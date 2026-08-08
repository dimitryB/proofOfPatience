# Blockchain architecture and roadmap

## Goal

Record final Proof of Patience results on Hemi Mainnet in a way that keeps
practice free and walletless, makes submission costs explicit, remains
independently readable and resistant to casual manipulation, and stays isolated
from the real-time game loop.

Verify all chain IDs, RPC URLs, explorer URLs, wallet methods, and current Hemi
recommendations against official documentation immediately before implementation.
Do not treat values in third-party tutorials as authoritative.

## Implemented player flow

1. The player starts immediately without connecting a wallet.
2. The hosted Worker issues a unique, signed, short-lived run ticket. If the
   service is unavailable, the same run remains available as local practice.
3. The five-minute game runs entirely in the browser.
4. At game-over or completion, the game freezes an immutable result and ticket.
5. The player may connect a wallet and choose **Save score on Hemi**.
6. The Worker validates the ticket, elapsed wall time, game version, result
   bounds, cooldown and player signature. The verifier signs the same EIP-712
   payload and returns the attestation.
7. The connected player wallet submits the signed result and pays the Hemi
   network gas.
8. The contract rejects replays and stores/emits the verified result.
9. The UI confirms the transaction and refreshes the leaderboard.
10. If any network step fails, practice is unaffected and the completed result
    remains visible until the player starts another run.

## Trust model

### Implemented contest MVP: timed run ticket plus bounded attestation

The Worker signs a unique run ID and issue time before play, then verifies that
the ticket is authentic, is no more than six hours old, and has existed for at
least the claimed survival duration. It validates all score fields, the wallet's
typed signature, the configured game version, and the onchain cooldown before
signing the result. The contract independently checks the player
and verifier signatures, replay protection, version, deadline and bounds.

This blocks casual request forgery and transaction-submitter tampering, but it
does not replay every browser input. A determined player can modify browser
state and submit a plausible bounded score. The verifier remains trusted and
the daily wallet limit is not Sybil resistance.

### V2 anti-cheat milestone

Extract the deterministic simulation into a shared headless module, record
timestamped control changes, and replay the canonical trace in the Worker before
attesting. This is deliberately deferred from V1: the current leaderboard is a
fun community activity with no material prize attached to winning. A later ZK
proof or optimistic challenge window can replace the trusted verifier if the
stakes or product scope change.

### Not acceptable for a competitive leaderboard

- trusting a score directly from browser state;
- storing only a client-generated hash;
- hiding score logic in minified JavaScript;
- using local storage as proof;
- signing results with a key shipped to the browser.

## Contract shape

Use a small append-only score registry. Exact Solidity types may change after
gas measurement.

```solidity
struct ScoreSubmission {
    bytes32 runId;
    bytes32 gameVersion;
    address player;
    uint64 score;
    uint32 survivalSeconds;
    uint32 answered;
    uint32 shots;
    uint32 hits;
    bytes32 seed;
    bytes32 traceHash;
    uint64 deadline;
}
```

Suggested function:

```solidity
function submitScore(
    ScoreSubmission calldata submission,
    bytes calldata playerSignature,
    bytes calldata verifierSignature
) external;
```

The contract should:

- use EIP-712 typed-data signatures;
- bind signatures to chain ID and verifying contract;
- allow any transaction submitter because both required signatures bind every
  score field, while the browser normally submits from the player's wallet;
- reject previously used run IDs;
- reject expired attestations;
- enforce five-minute duration and numeric bounds;
- emit the complete accepted result in an event;
- update the player's best score for the game version;
- expose leaderboard-friendly reads or document event indexing;
- keep verifier rotation under two-step owner control;
- remain non-upgradeable while giving the owner an emergency submission pause
  and precise, evented moderation actions.

Avoid an unbounded onchain sorted array. Store each player's best result and use
events or a small indexed service to calculate ranked pages. The canonical
score remains independently verifiable from chain data.

## Player-paid submission

Practice and local high scores remain free and never require a wallet. The Hemi
team has confirmed that a player may pay network gas for an optional onchain
score submission; preserve that response with the contest submission records.

The application should:

1. request a wallet only after a run;
2. obtain the verifier attestation before opening the transaction prompt;
3. disclose that the wallet pays Hemi network gas;
4. let the wallet estimate gas and require explicit transaction confirmation;
5. preserve the completed local result if the player declines or the transaction
   fails.

## Frontend modules

Keep blockchain code outside `app/page.tsx`:

```text
lib/game-result.ts              Canonical result and trace encoding
lib/chain/config.ts             Hemi chain configuration
lib/chain/client.ts             Public read client
lib/chain/wallet.ts             Connect/switch/sign helpers
lib/chain/score-service.ts      Attestation and direct wallet submission
components/score-submission.tsx End-of-run wallet and transaction UI
components/leaderboard.tsx      Onchain results UI
contracts/                      Solidity, tests and deployment scripts
```

Wallet libraries must be loaded outside the animation loop. Read-only
leaderboard access should work without a connected wallet.

## Versioning

Every result must include a stable `gameVersion`. Any change to scoring,
difficulty, collision rules, seed generation, or trace encoding requires a new
version. Presentation-only fixes do not.

Maintain:

- a human-readable release value for the UI;
- a bytes32 value used by the contract;
- verifier support for every still-accepted version;
- separate leaderboard filters per version.

## Test plan

### Contract

- valid direct submission;
- wrong signer;
- wrong player;
- wrong chain or contract domain;
- duplicated run ID;
- expired attestation;
- impossible duration or statistics;
- score overflow boundaries;
- best-score update and lower-score preservation;
- role changes and pause/upgrade paths, if present.

### Verifier — V1

- a ticket can attest only one payload and an identical retry returns the same
  signature;
- mismatched seed, score bounds, timing, player signature, or game version fails;
- shared rate limits and an optional complete Turnstile key pair fail closed;
- version mismatch fails closed;
- expired tickets and attestations are rejected.

### Verifier — V2 deterministic replay

- deterministic replay matches the browser simulation;
- tampered input or trace hash fails;
- canonical trace encoding is identical across environments;
- excessively large traces are rejected.

### Application

- play works with no wallet extension;
- connection is requested only after the run;
- wrong-network recovery;
- user rejects connection or signature;
- verifier timeout and transaction retry;
- duplicate submission is shown as already saved;
- transaction confirmation refreshes the leaderboard;
- local result survives page/network failure long enough to retry.

## Mainnet release sequence

1. Freeze the V1 game version, result schema, and bounded-attestation trust model.
2. Deploy and test the contract on Hemi Testnet.
3. Run abuse, replay, and gas-budget tests.
4. Verify player-paid submission end to end.
5. Publish the contract and verifier source.
6. Deploy the reviewed contract to Hemi Mainnet.
7. Record Mainnet address, transaction, roles, and explorer links.
8. Configure production environment values in the hosting platform.
9. Run a wallet-free playthrough and a player-paid Mainnet submission.
10. Publish the repository and contest submission only after evidence is saved.

Deterministic replay is a V2 release sequence, not a blocker for the no-prize V1
community leaderboard.
