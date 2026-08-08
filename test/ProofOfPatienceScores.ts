import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashTypedData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { network } from "hardhat";

const GAME_VERSION = keccak256(stringToHex("proof-of-patience-v1"));
const COOLDOWN = 24 * 60 * 60;
const ZERO_HASH = `0x${"0".repeat(64)}` as const;
const MAX_SCORE = 250_000_000n;

const scoreTypes = {
  ScoreSubmission: [
    { name: "runId", type: "bytes32" },
    { name: "gameVersion", type: "bytes32" },
    { name: "player", type: "address" },
    { name: "score", type: "uint64" },
    { name: "survivalSeconds", type: "uint32" },
    { name: "answered", type: "uint32" },
    { name: "shots", type: "uint32" },
    { name: "hits", type: "uint32" },
    { name: "seed", type: "bytes32" },
    { name: "traceHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const attestationTypes = {
  VerifierAttestation: [{ name: "scoreHash", type: "bytes32" }],
} as const;

/**
 * `allTimeBest` and `weeklyScore` are public mappings, so Solidity's generated
 * getter flattens `StoredScore` into eight separate return values rather than a
 * struct — viem hands those back positionally. `getAllTimeScores` and
 * `getWeeklyScores` are real functions with a struct return type, so those give
 * named fields and need no decoding.
 */
function readStored(raw: readonly unknown[]) {
  return {
    runId: raw[0] as Hex,
    player: raw[1] as Address,
    score: raw[2] as bigint,
    survivalSeconds: Number(raw[3]),
    answered: Number(raw[4]),
    shots: Number(raw[5]),
    hits: Number(raw[6]),
    submittedAt: raw[7] as bigint,
  };
}

function makeSubmission(player: Address, now: bigint, score = 42n, suffix = "run-1") {
  return {
    runId: keccak256(stringToHex(suffix)),
    gameVersion: GAME_VERSION,
    player,
    score,
    survivalSeconds: 180,
    answered: 12,
    shots: 20,
    hits: 15,
    seed: keccak256(stringToHex(`seed-${suffix}`)),
    traceHash: ZERO_HASH,
    deadline: now + 15n * 60n,
  } as const;
}

describe("ProofOfPatienceScores", async () => {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();

  async function deployFixture() {
    const [owner, verifier, player, impostor, relayer] = await viem.getWalletClients();
    const now = BigInt(await networkHelpers.time.latest());
    // The constructor requires a UTC midnight, so round down to one that has passed.
    const seasonStart = (now / 86_400n) * 86_400n;
    const contract = await viem.deployContract("ProofOfPatienceScores", [
      owner.account.address,
      verifier.account.address,
      GAME_VERSION,
      seasonStart,
    ]);
    const chainId = await publicClient.getChainId();

    return { contract, owner, verifier, player, impostor, relayer, chainId, seasonStart };
  }

  function domain(contract: Address, chainId: number) {
    return { name: "Proof of Patience", version: "1", chainId, verifyingContract: contract } as const;
  }

  async function signSubmission(
    contract: Address,
    chainId: number,
    submission: ReturnType<typeof makeSubmission>,
    player: Awaited<ReturnType<typeof viem.getWalletClients>>[number],
    verifier: Awaited<ReturnType<typeof viem.getWalletClients>>[number],
  ) {
    const payload = {
      domain: domain(contract, chainId),
      types: scoreTypes,
      primaryType: "ScoreSubmission" as const,
      message: submission,
    };

    const playerSignature = await player.signTypedData(payload);
    // The verifier signs an envelope around the player's full EIP-712 digest,
    // not the payload itself. Signing the payload produces a signature the
    // contract rejects.
    const verifierSignature = await verifier.signTypedData({
      domain: domain(contract, chainId),
      types: attestationTypes,
      primaryType: "VerifierAttestation" as const,
      message: { scoreHash: hashTypedData(payload) },
    });
    return { playerSignature, verifierSignature };
  }

  async function submit(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    submission: ReturnType<typeof makeSubmission>,
    playerSigner = fixture.player,
    sender = fixture.player,
  ) {
    const signatures = await signSubmission(
      fixture.contract.address,
      fixture.chainId,
      submission,
      playerSigner,
      fixture.verifier,
    );

    return fixture.contract.write.submitScore(
      [submission, signatures.playerSignature, signatures.verifierSignature],
      { account: sender.account },
    );
  }

  async function allTimeBestOf(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    player: Address,
  ) {
    return readStored(await fixture.contract.read.allTimeBest([player]));
  }

  async function weeklyScoreOf(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    weekId: bigint,
    player: Address,
  ) {
    return readStored(await fixture.contract.read.weeklyScore([weekId, player]));
  }

  it("accepts a player-paid, dual-signed score and updates both boards", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    const submission = makeSubmission(fixture.player.account.address, now);

    await submit(fixture, submission);

    const best = await allTimeBestOf(fixture, fixture.player.account.address);
    assert.equal(best.score, 42n);
    assert.equal(best.runId, submission.runId);
    assert.equal(await fixture.contract.read.allPlayerCount(), 1n);
    assert.equal(await fixture.contract.read.weeklyPlayerCount([0n]), 1n);
    assert.equal(await fixture.contract.read.usedRunIds([submission.runId]), true);
    assert.equal(
      await fixture.contract.read.nextEligibleAt([fixture.player.account.address]),
      best.submittedAt + BigInt(COOLDOWN),
    );
  });

  it("enforces a rolling 24-hour cooldown and keeps one weekly best per wallet", async () => {
    const fixture = await deployFixture();
    let now = BigInt(await networkHelpers.time.latest());
    await submit(fixture, makeSubmission(fixture.player.account.address, now));

    now = BigInt(await networkHelpers.time.latest());
    const early = makeSubmission(fixture.player.account.address, now, 99n, "run-too-early");
    await assert.rejects(submit(fixture, early));

    await networkHelpers.time.increase(COOLDOWN);
    now = BigInt(await networkHelpers.time.latest());
    await submit(fixture, makeSubmission(fixture.player.account.address, now, 99n, "run-eligible"));

    assert.equal((await allTimeBestOf(fixture, fixture.player.account.address)).score, 99n);

    await networkHelpers.time.increase(COOLDOWN);
    now = BigInt(await networkHelpers.time.latest());
    await submit(fixture, makeSubmission(fixture.player.account.address, now, 10n, "run-lower"));

    const weekly = await weeklyScoreOf(fixture, 0n, fixture.player.account.address);
    assert.equal(weekly.score, 99n, "a lower score must not displace the weekly best");
    assert.equal(await fixture.contract.read.weeklyPlayerCount([0n]), 1n);
  });

  it("rejects a forged player signature and leaves the run reusable", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    const submission = makeSubmission(fixture.player.account.address, now);

    await assert.rejects(submit(fixture, submission, fixture.impostor));
    assert.equal(await fixture.contract.read.usedRunIds([submission.runId]), false);
    assert.equal(await fixture.contract.read.allPlayerCount(), 0n);
  });

  it("rejects duplicate runs even after the cooldown", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    const submission = makeSubmission(fixture.player.account.address, now);
    await submit(fixture, submission);

    await networkHelpers.time.increase(COOLDOWN);
    const duplicate = {
      ...submission,
      deadline: BigInt(await networkHelpers.time.latest()) + 15n * 60n,
    };
    await assert.rejects(submit(fixture, duplicate));
  });

  it("paginates stored best scores without doing an expensive onchain sort", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    await submit(fixture, makeSubmission(fixture.player.account.address, now, 50n));

    const second = makeSubmission(fixture.impostor.account.address, now, 75n, "run-2");
    const signatures = await signSubmission(
      fixture.contract.address,
      fixture.chainId,
      second,
      fixture.impostor,
      fixture.verifier,
    );
    await fixture.contract.write.submitScore(
      [second, signatures.playerSignature as Hex, signatures.verifierSignature as Hex],
      { account: fixture.impostor.account },
    );

    // A struct-returning function, so these decode with named fields.
    const page = await fixture.contract.read.getAllTimeScores([0n, 100n]);
    assert.equal(page.length, 2);
    assert.deepEqual(
      page.map((entry) => entry.score),
      [50n, 75n],
    );
    await assert.rejects(fixture.contract.read.getAllTimeScores([0n, 101n]));
  });

  /* ------------------------------ score bounds ------------------------------ */

  it("refuses a score the claimed work could not have produced", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());

    // The v1 contract accepted type(uint64).max alongside zeroed work.
    const inflated = {
      ...makeSubmission(fixture.player.account.address, now, MAX_SCORE, "run-inflated"),
      survivalSeconds: 0,
      answered: 0,
      shots: 0,
      hits: 0,
    };
    await assert.rejects(submit(fixture, inflated), /ScoreAboveCeiling|InvalidResult/);

    const aboveAbsoluteCap = makeSubmission(
      fixture.player.account.address,
      now,
      MAX_SCORE + 1n,
      "run-over-cap",
    );
    await assert.rejects(submit(fixture, aboveAbsoluteCap));

    assert.equal(await fixture.contract.read.allPlayerCount(), 0n);
  });

  it("accepts a strong but honest run", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    // ceiling(answered=300, hits=5000) is 106,770,000, comfortably above this.
    const strong = {
      ...makeSubmission(fixture.player.account.address, now, 20_300_250n, "run-strong"),
      survivalSeconds: 297,
      answered: 300,
      shots: 7_777,
      hits: 5_000,
    };

    await submit(fixture, strong);
    assert.equal((await allTimeBestOf(fixture, fixture.player.account.address)).score, 20_300_250n);
  });

  it("bounds the score ceiling above every honest run", async () => {
    const fixture = await deployFixture();
    for (const [answered, hits] of [
      [50, 500],
      [120, 2_000],
      [300, 5_000],
      [1_000, 10_000],
    ] as const) {
      const ceiling = await fixture.contract.read.scoreCeiling([answered, hits]);
      const honest = 170n * BigInt(answered) * BigInt(answered + 1) +
        1_310n * BigInt(answered) +
        3n * BigInt(hits) * BigInt(answered) +
        20n * BigInt(hits) +
        8_300n;
      assert.ok(ceiling > honest, `ceiling must exceed the honest maximum at ${answered}/${hits}`);
    }
  });

  /* --------------------------- signature separation -------------------------- */

  it("refuses the verifier's own signature as a player signature", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    const submission = makeSubmission(fixture.verifier.account.address, now, 1_000n, "run-self");

    // In v1 both checks recovered against the same digest, so when the player
    // was the verifier a single signature satisfied both.
    const payload = {
      domain: domain(fixture.contract.address, fixture.chainId),
      types: scoreTypes,
      primaryType: "ScoreSubmission" as const,
      message: submission,
    };
    const single = await fixture.verifier.signTypedData(payload);

    await assert.rejects(
      fixture.contract.write.submitScore([submission, single, single], {
        account: fixture.verifier.account,
      }),
      /InvalidVerifierSignature/,
    );
  });

  it("refuses a deadline further out than the contract window", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    const distant = {
      ...makeSubmission(fixture.player.account.address, now, 42n, "run-distant"),
      deadline: now + 2n * 60n * 60n,
    };
    await assert.rejects(submit(fixture, distant), /DeadlineTooDistant/);
  });

  /* ------------------------------- relaying -------------------------------- */

  it("lets any relayer submit a fully signed result without taking the cooldown", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    const submission = makeSubmission(fixture.player.account.address, now, 500n, "run-relayed");

    await submit(fixture, submission, fixture.player, fixture.relayer);

    assert.equal((await allTimeBestOf(fixture, fixture.player.account.address)).score, 500n);
    assert.equal(await fixture.contract.read.nextEligibleAt([fixture.relayer.account.address]), 0n);
  });

  /* ----------------------------- administration ---------------------------- */

  it("pauses submissions while keeping every read available", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    await fixture.contract.write.pause({ account: fixture.owner.account });

    await assert.rejects(
      submit(fixture, makeSubmission(fixture.player.account.address, now, 42n, "run-paused")),
      /EnforcedPause/,
    );
    assert.equal(await fixture.contract.read.allPlayerCount(), 0n);
    assert.deepEqual(await fixture.contract.read.getAllTimeScores([0n, 100n]), []);

    await fixture.contract.write.unpause({ account: fixture.owner.account });
    await submit(
      fixture,
      makeSubmission(fixture.player.account.address, BigInt(await networkHelpers.time.latest()), 42n, "run-unpaused"),
    );
    assert.equal(await fixture.contract.read.allPlayerCount(), 1n);
  });

  it("blocks and unblocks an address", async () => {
    const fixture = await deployFixture();
    let now = BigInt(await networkHelpers.time.latest());
    await fixture.contract.write.setPlayerBlocked([fixture.player.account.address, true], {
      account: fixture.owner.account,
    });

    await assert.rejects(
      submit(fixture, makeSubmission(fixture.player.account.address, now, 42n, "run-blocked")),
      /PlayerBlocked/,
    );

    await fixture.contract.write.setPlayerBlocked([fixture.player.account.address, false], {
      account: fixture.owner.account,
    });
    now = BigInt(await networkHelpers.time.latest());
    await submit(fixture, makeSubmission(fixture.player.account.address, now, 42n, "run-unblocked"));
    assert.equal(await fixture.contract.read.allPlayerCount(), 1n);
  });

  it("voids a poisoned result from both boards and refuses the wrong target", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    // Must sit under scoreCeiling(answered=12, hits=15) = 226,550.
    const bad = makeSubmission(fixture.player.account.address, now, 200_000n, "run-bad");
    await submit(fixture, bad);

    const owner = { account: fixture.owner.account };
    const wrongRun = keccak256(stringToHex("not-this-run"));

    await assert.rejects(
      fixture.contract.write.voidAllTimeBest([fixture.player.account.address, wrongRun], owner),
      /VoidTargetMismatch/,
    );
    await assert.rejects(
      fixture.contract.write.voidWeeklyScore([fixture.player.account.address, 5n, bad.runId], owner),
      /NothingToVoid/,
    );

    await fixture.contract.write.voidAllTimeBest([fixture.player.account.address, bad.runId], owner);
    await fixture.contract.write.voidWeeklyScore([fixture.player.account.address, 0n, bad.runId], owner);

    assert.equal((await allTimeBestOf(fixture, fixture.player.account.address)).score, 0n);
    assert.equal((await weeklyScoreOf(fixture, 0n, fixture.player.account.address)).score, 0n);
    assert.equal(await fixture.contract.read.usedRunIds([bad.runId]), true, "the run stays spent");
  });

  it("keeps the all-time board through a week rollover", async () => {
    const fixture = await deployFixture();
    const now = BigInt(await networkHelpers.time.latest());
    await submit(fixture, makeSubmission(fixture.player.account.address, now, 900n, "run-week0"));

    // Cross into the next week.
    await networkHelpers.time.increase(7 * 24 * 60 * 60);
    assert.equal(await fixture.contract.read.currentWeekId(), 1n);

    // The all-time board is permanent and still carries the score.
    assert.equal((await allTimeBestOf(fixture, fixture.player.account.address)).score, 900n);
    assert.equal(await fixture.contract.read.allPlayerCount(), 1n);
    // The new week starts empty.
    assert.equal(await fixture.contract.read.weeklyPlayerCount([1n]), 0n);
  });

  it("refuses a season start that is not a UTC midnight", async () => {
    const fixture = await deployFixture();
    await assert.rejects(
      viem.deployContract("ProofOfPatienceScores", [
        fixture.owner.account.address,
        fixture.verifier.account.address,
        GAME_VERSION,
        fixture.seasonStart + 1n,
      ]),
    );
    await assert.rejects(
      viem.deployContract("ProofOfPatienceScores", [
        fixture.owner.account.address,
        fixture.verifier.account.address,
        GAME_VERSION,
        0n,
      ]),
    );
  });
});
