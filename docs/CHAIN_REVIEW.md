# Proof of Patience — blockchain layer review

**Scope:** `contracts/ProofOfPatienceScores.sol`, `worker/chain.ts`, `lib/chain.ts`,
`app/components/OnchainScore.tsx`, `app/components/Leaderboards.tsx`, the run-proof
lifecycle in `app/page.tsx`, `hardhat.config.ts`, the Ignition module and parameters,
and the chain-layer docs.

**Date:** 7 August 2026 · **Commit:** `67fd461` "Switch to player-paid score submissions"

---

## Method

This is not a read-only review. Findings marked **[verified]** were reproduced by
execution, not inferred:

- The contract was rebuilt from source in an isolated Foundry project with solc
  `0.8.28+commit.7893614a`, `evm_version = "paris"`, under both of your build
  profiles (default and optimizer/200), and exercised by **33 purpose-written tests
  — 33 passed, 0 failed under both profiles.** It compiles with **zero solc errors
  and zero warnings**. Deployment cost: 1,999,188 gas, 10,120 bytes.
- Gas figures are cold-storage measurements (`vm.cool` before each call,
  cross-checked against `forge --gas-report`). Warm-storage numbers are ~4.9x
  cheaper and would have understated the read cost badly.
- Hemi network constants were checked against live chain data and official docs
  today, not from memory.

Nothing was run against your production site or any live key.

---

## Verdict

The cryptography is sound and the contract is clean — genuinely clean, which is not
the norm. The problem is one level up: **the signature scheme faithfully attests a
number that nothing ever checked.** Every EIP-712 domain binding, replay guard and
dual-signature check works exactly as designed, and all of it is protecting a value
the client made up.

Two issues are launch-blocking. Both are cheap to exploit and one of them is
permanent, because the contract has no remediation path of any kind.

Your docs already disclaim the trust model honestly (`BLOCKCHAIN_ROADMAP.md:43-46`:
*"A determined player can modify browser state and submit a plausible bounded
score. The verifier remains trusted"*). I want to be precise about why that
disclaimer does not cover what I found: the bound is `100,000,000`, the contract's
own bound is `2^64-1`, and **no field is required to be consistent with any other**.
"Plausible" is doing no work here. And the leaderboard truncation in **H1** is not
disclaimed anywhere — it contradicts your own roadmap.

---

# Critical

## C1 — The verifier signs any score the client asks it to

`worker/chain.ts:320-405`

`handleAttest` performs, in order: field range checks, ticket-signature check,
wall-clock check, player-signature check, on-chain verifier/version/cooldown check —
then signs. What it never does is form any opinion about whether the score happened.
There is no simulation, no replay, no recomputation, and **no required relationship
between `score` and `survivalSeconds`, `answered`, `shots` or `hits`.**

The full attack:

```
POST /api/chain/run                    # returns {runId, issuedAt, ticket}
sleep 300                              # only needed if you want survivalSeconds=300
POST /api/chain/attest                 # score: 100_000_000, answered: 1000, ...
                                       # + one EIP-712 wallet signature
submitScore(...) on Hemi               # ~$0.001 in gas
```

The verifier signs it. The contract accepts it. You are now permanently rank 1.

The one temporal binding — `now - runProof.issuedAt + 15 >= submission.survivalSeconds`
(line 344) — is a *lower bound on elapsed wall time only*. It is trivially satisfied by
waiting, and entirely sidestepped by claiming `survivalSeconds: 5` alongside
`score: 100_000_000`, since nothing correlates the two.

Three things make this worse than the roadmap's framing:

1. **`sameOrigin()` accepts a null Origin** (line 97: `origin === null || ...`).
   Browsers send `Origin`; `curl` need not. The check stops nothing that matters.
2. **The rate limiter is an in-memory `Map` in a Cloudflare Worker isolate**
   (line 63). Isolates are per-PoP and ephemeral, so the counter is neither shared
   nor durable — and it never evicts stale keys. 10/min/IP is, in practice, closer to
   10/min/IP/isolate/lifetime.
3. **Run tickets are unbound to any wallet, freely mintable, and valid 6 hours**
   (`RUN_TICKET_MAX_AGE`). Nothing prevents bulk pre-issuance. Your own docs note
   tickets are "stateless" (`MAINNET_RUNBOOK.md:19`), which means single-use cannot
   be enforced off-chain at all.

**How expensive is a real run?** Scoring is `spec.value × combo` with values 120–340
and **no combo cap** (`lib/pop.ts:673`, `app/page.tsx:477`). A perfect unbroken chain
of N answers scores roughly `228 × N²/2`. A strong human answering ~100 questions
with an unbroken chain tops out near ~1.1M. The verifier's ceiling of 100,000,000
corresponds to answering ~937 questions perfectly — the physical limit of the
0.06s fire cooldown, not a human result. **The ceiling is ~100x any real score.**

**Fix, in order of cost:**

- *Now, cheap:* clamp `score` server-side to a function of the fields that are
  already bounded — e.g. `score <= maxTheoretical(answered)` using your real scoring
  curve, and require `answered <= survivalSeconds × maxAnswerRate`,
  `hits >= answered × minShotsPerAnswer`. This does not stop a determined cheat but
  it collapses the ceiling from 100x to ~1x and makes forged entries look forged.
- *Now, cheap:* make the run ticket single-use and bound to the wallet. Bind
  `player` into the ticket at issue time, and hold issued `runId`s in Workers KV or a
  Durable Object with a TTL so one ticket yields at most one attestation.
- *Now, cheap:* replace the in-memory limiter with Cloudflare's Rate Limiting
  binding (durable, cross-isolate), and add Turnstile to `/api/chain/attest`.
- *Real fix, already on your roadmap:* deterministic replay of a recorded input
  trace in the Worker (`BLOCKCHAIN_ROADMAP.md:48-53`). Note that `ScoreSubmission`
  carries neither `seed` nor `traceHash` today, so the on-chain record cannot be
  re-derived even in principle — if replay is the destination, add those fields
  **before** deploying, because the struct is baked into the EIP-712 typehash and
  changing it later means a new contract.

## C2 — A single bad score is permanent. There is no remediation path. **[verified]**

`contracts/ProofOfPatienceScores.sol` — full external surface enumerated

I enumerated all 27 external/public functions: 6 state-changing (`submitScore`,
`setVerifier`, `setActiveGameVersion`, `transferOwnership`, `acceptOwnership`,
`renounceOwnership`), 21 read-only. **Zero** match
`remove|delete|reset|clear|pause|invalidate|slash|ban|migrate|setScore`. No proxy,
not upgradeable, no `selfdestruct`.

Both score writes are strictly monotonic-up:

```solidity
if (stored.runId == bytes32(0) || submission.score > stored.score) stored = result;
```

Empirically confirmed:

- **Scores cannot be lowered.** A later score of 1 does not displace a stored 1000.
- **Verifier rotation does not help.** After `setVerifier(0xdead)` *and*
  `setActiveGameVersion("v2")`, the bogus `allTimeBest[verifier].score ==
  18446744073709551615` is still sitting at position 0 on both boards, and
  `allPlayerCount()` is unchanged. The version bump blocks *future* old-version
  submissions and nothing else.
- **`setVerifier(address(0))` reverts** `InvalidVerifier` — the owner cannot even
  halt submissions that way.
- **`renounceOwnership()`** freezes the board permanently with the bad entry intact
  and no admin at all.

Combine with C1: one curl and one wallet signature permanently owns rank 1, and your
only recovery is redeploying and abandoning all prior state. If the verifier key ever
leaks, the same is true without the curl. `MAINNET_RUNBOOK.md:208-210` — *"If the
verifier key is exposed, call `setVerifier`, update `POP_VERIFIER_PRIVATE_KEY`, and
redeploy the site environment"* — is the entire documented incident response, and it
does not address entries already written.

**Fix:** you need exactly one of these before mainnet.

- **`pause()` / `unpause()`** (owner-only, blocks `submitScore`). Smallest change,
  buys time during an incident. Strongly recommend regardless.
- **`voidRun(bytes32 runId)`** or **`voidPlayer(address player)`** (owner-only,
  emits an event, clears the stored entry). Targeted, keeps the board honest.
- **`seasonId` indirection** — make `allTimeBest` keyed by season and add
  `startNewSeason()`. Heaviest, but it also solves H1 and gives you a natural
  content cadence.

Yes, each adds centralization. That is the correct trade for a game leaderboard, and
you should say so plainly in the docs — your current line, *"The contract is
immutable and cannot be upgraded or paused"* (`MAINNET_RUNBOOK.md:25-27`), currently
reads as a feature when it is the thing that makes C1 unrecoverable.

---

# High

## H1 — The leaderboard silently freezes out everyone past player 2,000 **[verified]**

`worker/chain.ts:61,187-213` + `contracts/…:79-82,194-218`

`_allPlayers` and `_weeklyPlayers[weekId]` grow unbounded, one entry per unique
player, insertion-ordered, with no cap and no removal — confirmed across 250 distinct
wallets (`allPlayerCount()` grew by exactly 1 each time). The Worker reads them with
`MAX_LEADERBOARD_SCAN = 2_000`.

So the board reads the **first 2,000 wallets that ever submitted** and nothing else.
Player 2,001 can post the highest score in the game's history and never appear.
No error, no warning — the board just quietly stops being the leaderboard.

This is also an attack, not only a scaling limit. Measured cost of one new-player
submission: **330,392 gas** (production profile, cold storage, incl. 26,244 gas of
calldata). At Hemi's live economics — base fee 252 wei, effective ~0.0012 gwei, ETH
~$1,915 — that is on the order of **$0.001–0.005 per entry**, so **roughly $3–$10 to
push the board past its own scan window permanently.** Filling the visible top 10
with max scores costs a few cents.

Your roadmap already calls this shot (`BLOCKCHAIN_ROADMAP.md:107-109`):

> *"Avoid an unbounded onchain sorted array. Store each player's best result and use
> events or a small indexed service to calculate ranked pages."*

The contract does the first half. The read path does not do the second half.

**Fix:** index `ScoreSubmitted` / `AllTimeBestUpdated` events into Workers KV or D1
and serve the board from there. You already emit everything needed. That removes the
scan entirely, removes the 2,000 cliff, removes H2, and makes the board O(1) to read.
Until then, at minimum **log loudly when `count > MAX_LEADERBOARD_SCAN`** so this
fails visibly rather than silently.

## H2 — One unauthenticated request costs you ~40 RPC calls, and caching is trivially bypassed

`worker/chain.ts:268-318`

`/api/chain/leaderboard` has no rate limit and no origin check. Each call does: 1
`currentWeekId` + 2 count reads + up to 20 weekly page reads + up to 20 all-time page
reads + optionally `nextEligibleAt`. **[verified]** each 100-entry page is
**1,029,490 gas of `eth_call`** returning 25,664 bytes — so a full board load is
~41M gas of RPC work and ~1 MB of response data.

Hemi's public RPC — the one you hardcode — is documented at **~300 requests/minute**
and explicitly *"intended for development and testing."* At ~40 calls per load,
**~7 leaderboard loads per minute saturates it.** That is below organic traffic for a
contest entry, before anyone is being hostile.

Two multipliers:

- **`?address=` disables caching entirely** (line 316: `address ? {} : {cache-control…}`).
  Appending any address to the URL gets an attacker the uncached path on demand.
- **The `s-maxage=30` is inert anyway.** Cloudflare does not edge-cache a response
  constructed inside a Worker just because it carries the header — you need
  `caches.default` explicitly, or a Cache Rule.

Also `Promise.all` with no error handling or retry (line 291): a single RPC hiccup
fails the whole board with a 502, no partial result.

**Fix:** event indexing (H1) makes this moot. Short of that — rate-limit the
endpoint, put `nextEligibleAt` on its own cheap route (see M5), use `caches.default`
explicitly, add a fallback RPC (dRPC `https://hemi.drpc.org`, Infura and QuickNode
all support Hemi), and make `HEMI_RPC_URL` genuinely env-driven for production.

## H3 — The QA harness ships to production

`app/page.tsx:884-985`

The harness is gated on `window.__POP_QA__` being set first — but **the code is in
the production client bundle**, confirmed present in `dist/client/assets/page-*.js`.
Anyone who sets that flag before hydration gets `window.__popGame` with:

- `setCombo(value)` — unbounded, and score is `value × combo`
- `advance(steps)` — steps the simulation with no wall-clock cost
- `triggerPop()`, `setPhase()`, `aimAtTarget()`

`advance()` + `setCombo()` produces an arbitrary score in milliseconds. It doesn't
even defeat the ticket's elapsed-time check, because (per C1) nothing requires the
score to match `survivalSeconds`.

This isn't the primary cheat vector — the API is — but it drops the bar from "can
write a curl script" to "can paste one line into a console."

**Fix:** tree-shake it out of production builds behind a compile-time constant
(`import.meta.env.DEV`, or a Vite `define` flag), so the code is absent rather than
merely dormant.

---

# Medium

**M1 — The contract's bounds are decorative where it counts. [verified]**
`survivalSeconds ≤ 300`, `answered ≤ 1000`, `shots ≤ 10000`, `hits ≤ shots` are all
enforced — but `score` is an unchecked `uint64`, and no field must be consistent with
any other. Verified accepted: `score = 18446744073709551615` with
`survivalSeconds = answered = shots = hits = 0`. Add a `MAX_SCORE` constant and at
least one cross-field invariant on-chain, so the contract is not solely trusting the
verifier.

**M2 — Verifier self-signature collapses two checks into one. [verified]**
When `submission.player == verifier`, the *same signature bytes passed twice* satisfy
both `ECDSA.recover` checks, because both recover against an identical digest. Verified:
a single signature recorded `score = type(uint64).max`. Not independently exploitable
(it needs the verifier key), but it's a missing domain separation. Give the verifier
attestation its own typehash, or add a `role` field to the struct — cheap now,
impossible after deploy.

**M3 — `evmVersion: "paris"` is unnecessarily conservative.**
Hemi is running the OP-Stack **Isthmus** hardfork — every block carries a
`setL1BlockValuesIsthmus` call to the L1Block predeploy at `0x42…15`, and batches post
in EIP-4844 blobs. That is post-Cancun. You can compile with `"cancun"` and get PUSH0,
MCOPY and transient storage. Rehearse on testnet 743111 first; Hemi's docs don't state
the EVM target explicitly, so this is inferred from chain evidence (strongly, but
inferred).

**M4 — No chain re-check after the wallet switch.**
`OnchainScore.tsx:159-235` calls `ensureHemiNetwork()` and proceeds. Some wallets
resolve `wallet_switchEthereumChain` without actually switching. The EIP-712 signature
will still be valid (chainId is in the typed data), so the mismatch surfaces only at
`eth_sendTransaction`, with a confusing error. Read `eth_chainId` back and compare to
`HEMI_CHAIN_ID_HEX` before signing.

**M5 — The cooldown pre-check runs the entire leaderboard scan.**
`OnchainScore.tsx:151` fetches `/api/chain/leaderboard?address=…` — ~40 RPC calls,
on the uncached path — purely to read one `nextEligibleAt`. Give it a dedicated
`/api/chain/status?address=` route: one `eth_call`, cacheable per-address.

**M6 — `MAX_BODY_BYTES` is bypassable.** `worker/chain.ts:115` reads
`content-length`; omit the header and `Number(null || 0)` is 0, so the check passes
and `request.json()` reads the body anyway. Check the actual size after reading, or
cap via a `ReadableStream`.

**M7 — `window.ethereum` only.** No EIP-6963 discovery, so with several wallets
installed you get whichever injected last, with no way to choose. Also no
`accountsChanged` listener between signing and sending.

**M8 — `Number(bigint)` on scores.** `toEntry` (line 169) coerces a `uint64`; above
2^53 that silently loses precision. Harmless while the verifier caps at 100M, cosmetic
if it doesn't — but it's the kind of thing that makes an incident harder to read.

**M9 — Weekly winners vanish at rollover. [verified]** Confirmed: a week-N leader has
no week-N+1 entry until they play again, so at 00:00 Monday the weekly board is empty
and someone scoring 1 is the outright leader. Correct by design, but the UI shows
`THIS WEEK · W{n}` with no explanation. Worth a line of copy.

---

# Deployment and ops

**Deploying with the unedited example parameters bricks the contract permanently.**
`ignition/parameters/hemi-mainnet.example.json` ships `owner: 0x1111…1111` and
`verifier: 0x2222…2222`. `owner` and `seasonStart` are constructor-set and immutable,
and the contract cannot be paused or upgraded — so a mis-deploy means an owner nobody
controls and a verifier whose key does not exist, i.e. every submission fails forever
with no recovery. The only current guard is prose in the runbook. **Add a preflight
assertion to the Ignition module** that rejects the placeholder addresses and
`seasonStart % 86400 != 0`.

**`seasonStart` alignment is asserted but never specified.** The example value
`1785715200` is exactly Monday 2026-08-03 00:00 UTC — correct. But no doc states the
rule, so a hand-edited value silently skews every weekly boundary, permanently. Write
the invariant down.

**You test unoptimized bytecode and deploy optimized bytecode.** `test:contract` runs
`hardhat test nodejs` on the default profile; `contract:deploy:hemi` uses
`--build-profile production`. The bytecode you ship is never the bytecode you tested.
I ran all 33 tests under both profiles and they agree — but make that the standing
practice, not a one-off.

**Verified as correct, no change needed:** chain ID `43111` / `0xa867`; RPC
`https://rpc.hemi.network/rpc` (canonical, but see H2 on rate limits); explorer
`https://explorer.hemi.xyz` and its Blockscout API at `/api` (I confirmed the API
endpoint your `--verify` step depends on is live and responding); native currency
ETH/18. Secrets hygiene is right — `.env*`, `ignition/parameters/hemi-mainnet.json`
and `/ignition/deployments/` are all gitignored, and `git ls-files` shows only the
`.example` files tracked. The verifier key is a Worker-only binding and never enters
the client bundle.

**One thing to check yourself:** `package.json` describes the project as *"built for
the Hemi Arcade contest."* I could not find any public evidence that a "Hemi Arcade"
contest exists — no results on hemi.xyz, docs.hemi.xyz, Devpost or TAIKAI. Hemi does
run an open-ended grants program with no published deadline. If you're working to a
deadline, confirm it directly (their Discord) rather than assuming.

**Finality note.** You wait for 1 confirmation before showing success
(`OnchainScore.tsx:237`). Hemi has a centralized sequencer, no live fraud proofs
(L2BEAT: *"not even a Stage 0 project"*, *"currently permits invalid state roots"*),
and Bitcoin-anchored finality ~90 minutes out. 1 confirmation is fine for optimistic
UI. If anything with prize consequence is ever settled from this board, read at
`finalized` instead.

---

# What's working well

Worth stating, because the list above is long and the foundation is not the problem:

- **The signature scheme is correct.** EIP-712 domain binds `chainId` and
  `verifyingContract`, so cross-chain and cross-deployment replay are both closed.
  OZ v5's `ECDSA.recover` rejects malleable `s`/`v`. The run ticket uses
  `personal_sign` while attestations use typed data, so the two schemes cannot be
  confused for each other.
- **Failed submissions do not burn the runId. [verified]** Checked across four
  distinct revert paths (forged player sig, forged verifier sig, expired deadline,
  out-of-range result) — `usedRunIds` stays false and the run remains submittable. A
  player who hits a wallet error does not lose their run. That's a thoughtful detail.
- **The cooldown is keyed to `submission.player`, not `msg.sender`. [verified]** One
  relayer added 25 entries for 25 players in a single block with its own
  `nextEligibleAt` still 0. This means you can add gasless relaying later without
  touching the contract — the design is already open to it.
- **`Ownable2Step`**, so a fat-fingered ownership transfer can't strand the contract.
- **Unsorted pagination with off-chain ranking** instead of an on-chain sorted
  insert. Exactly the right call.
- **Zero solc warnings**, no `receive`/`fallback`, no upgradeability surprises, and
  `_pageEnd` is genuinely safe — I fuzzed 1,000 offset/limit pairs including
  `type(uint256).max` and it never panics or returns a malformed array. The
  `offset + limit` overflow I went looking for is mathematically unreachable behind
  the early-return guard.
- **The docs are honest about the trust model**, which is rarer than it should be.
  My objection is to the size of the gap, not to it being hidden.

---

# Suggested order of work

**Before any mainnet deploy:**

1. Add `pause()` and a void/season mechanism to the contract (**C2**) — this is the
   one thing that cannot be retrofitted afterward.
2. If deterministic replay is the destination, add `seed` and `traceHash` to
   `ScoreSubmission` **now** (**C1**) — the struct is frozen into the EIP-712
   typehash at deploy.
3. Add `MAX_SCORE` and a cross-field invariant on-chain (**M1**); give the verifier
   attestation its own typehash (**M2**).
4. Add placeholder/alignment assertions to the Ignition module.

**Before the board sees real traffic:**

5. Server-side score plausibility clamp, single-use wallet-bound run tickets, durable
   rate limiting, Turnstile (**C1**).
6. Move the leaderboard to event indexing in KV/D1 (**H1**, **H2**). Until then, log
   when the scan cap is hit.
7. Strip the QA harness from production builds (**H3**).

**Then:** M3–M9, and set `evmVersion` to `cancun` after a testnet rehearsal.

---

*Contract verification artifacts: 33-test Foundry suite covering storage growth,
sybil cost, pagination edge cases and fuzzing, self-signature, relay/cooldown
semantics, week boundaries, and remediation-surface enumeration. All gas figures are
cold-storage, production profile.*

---

# Addendum — what was implemented

Everything below is on the `chain-hardening` branch and verified by an 81-test
Foundry suite (81 passed, both build profiles, legacy codegen, no viaIR).

**Contract** (`contracts/ProofOfPatienceScores.sol`)

- `Pausable`; owner `pause()` / `unpause()`. **C2**
- `seasonId` + `startNewSeason()`. Both boards are season-scoped, so a new season
  supersedes the weekly board too; prior seasons stay readable. **C2**
- `voidSeasonBest(player, season, expectedRunId)` and
  `voidWeeklyScore(player, season, weekId, expectedRunId)`. Each names the run it
  expects to delete and reverts `VoidTargetMismatch` otherwise, so a mistyped
  parameter cannot destroy a legitimate entry — including in the race where an
  attacker resubmits between the operator reading the board and sending the
  void. Plus `setPlayerBlocked`. **C2**
- `MAX_SCORE = 250_000_000` and `scoreCeiling(answered, hits)`, an on-chain bound
  tying score to claimed work. This is the one check a compromised verifier
  cannot assert its way past. Honest maximum is 201,688,300. **M1**
- Verifier signs a distinct `VerifierAttestation(bytes32 scoreHash)` typehash
  wrapping the player's full EIP-712 digest. **M2**
- `seed` and `traceHash` added to `ScoreSubmission` and emitted, so deterministic
  replay can be switched on without redeploying. **C1**
- `MAX_DEADLINE_WINDOW = 1 hours`; constructor rejects a `seasonStart` that is
  zero or not a UTC midnight.
- `ScoreSubmitted` now carries the whole `StoredScore` plus `seed`/`traceHash`,
  so the board can be built from logs alone.

Cost: +4.1% gas for a new-player submission (330,392 → 343,976), +1.1% on a
100-entry page read, +35.6% deployment. Runtime 11,861 B, 48% of the EIP-170
limit under the production profile — **deploy with `--build-profile production`;
the no-optimizer build is at 84%.**

**Verifier** (`worker/chain.ts`)

- Off-chain plausibility bound refusing any score the claimed work could not have
  produced, plus rate rules from the 0.06s fire cooldown. Swept across 7,007
  score points and all 301 reportable durations: zero false rejections, and
  capped at `MAX_SCORE` so the verifier is never more permissive than the
  chain. **C1**
- Run tickets are single-use and carry a **server-chosen seed** the submission
  must match (requires a `POP_KV` binding). **C1**
- Durable rate limiting via an optional `POP_RATE_LIMIT` binding, optional
  Turnstile on `/api/chain/attest`, and the in-memory fallback now evicts. **C1**
- The origin check no longer treats a missing `Origin` as same-origin, and is
  documented as a browser heuristic rather than a control. **C1**
- Body size measured after reading rather than trusting `content-length`. **M6**
- Leaderboard rebuilt on `ScoreSubmitted` / `*Voided` logs with a KV snapshot and
  an explicit `caches.default` entry — no player ceiling, ~1 RPC call per
  refresh instead of ~40. Falls back to the array scan when `POP_DEPLOY_BLOCK`
  is unset, and now *reports* truncation instead of silently omitting players.
  Multi-RPC failover via `HEMI_RPC_FALLBACKS`. **H1**, **H2**
- New `/api/chain/status?address=` so the cooldown check is one `eth_call`
  instead of a full board rebuild. **M5**
- On-chain config reads cached for 60s, so a game start no longer costs two RPC
  calls. **H2**

**Client**

- `eth_chainId` re-read and verified after the wallet switch. **M4**
- Wallet rejection (code 4001) reported as a cancellation, not a failure. **M7**
- Voided rows filtered out of the board; season and week labelled honestly. **M9**
- The QA harness is now stripped from production builds (`import.meta.env.DEV`,
  or build with `VITE_POP_QA=1` to keep it). **H3**

**Deployment**

- `scripts/check-deploy-params.mjs`, wired into `contract:deploy:hemi`. Refuses
  the placeholder addresses, an owner equal to the verifier, a wrong
  `gameVersion`, and any `seasonStart` that is not a past Monday UTC midnight.
- `test:contract` now runs under the production profile, so the tested bytecode
  is the deployed bytecode.

**Not done** — deterministic replay (**C1**'s real fix) is still the next
milestone. The signed payload and the emitted event are now shaped for it, which
was the part that could not be retrofitted.

**Operational note:** void the weekly board *before* the season board.
`weekIdOfSeasonBest` reads the season entry, so voiding that first destroys the
lookup.

---

# Addendum 2 — second review pass

A follow-up review raised five findings against the hardening above. All five
were valid; four were defects introduced by the hardening itself. Resolved on the
`chain-hardening` branch and re-verified (contract: 43-test Foundry suite, both
build profiles; worker log-ordering: a separate replay simulation against
on-chain truth).

**Seasons removed — the all-time board is permanent again.** The biggest finding:
season-scoping made the "all-time" APIs return only the active season, and a
season reset wiped that board — a silent regression of the product's all-time-high
leaderboard. Seasons are gone. `allTimeBest[player]` is a global permanent mapping;
the board is only ever changed by a submission or a targeted void, never wiped.
Remediation (**C2**) never needed seasons: `pause`, precise runId-matched voids,
`setPlayerBlocked` and `setVerifier` are the toolkit. The `ScoreSubmitted` event
lost its `seasonId` field, so its topic0 is now
`0x1ccbf754735df6b18922bcb3f7b053f29073949a0a136ba5a8b7782749f07d79` and its data
is ten words `(StoredScore, seed, traceHash)` — the indexer decodes exactly that.
This also shrank the no-optimizer build from 84% to 77% of the EIP-170 limit.

**Turnstile now works end-to-end.** The Worker required a `turnstileToken` when a
secret was configured, but the client never sent one — so enabling the advertised
protection would have 403'd every submission. The client now fetches the public
site key from `/api/chain/config`, loads Turnstile, and attaches a fresh token to
each attestation. `.env.example` documents that the secret and site key are set as
a pair.

**Log indexing requires durable storage.** Setting `POP_DEPLOY_BLOCK` selected log
indexing even with no KV bound, so every cache miss restarted at the deploy block
and — once the chain was more than 40 chunks past it — could never reach recent
scores while hammering the RPC. Indexing now requires `POP_KV`; without it the
Worker logs a warning and falls back to the bounded contract scan.

**Logs are applied in chain order.** Submission and void logs were fetched per
event type and applied in two batches, so a void that on chain preceded a
re-submission could delete the newer, legitimate result. All logs are now merged
and replayed in strict `(blockNumber, transactionIndex, logIndex)` order, and each
void is matched on `runId` so a stale reorg event cannot remove an entry it does
not name. Verified: on the exact hazard, the old batched logic dropped a
legitimate resubmission to zero while the sorted logic matches on-chain state.

**Verifier still signs unattested gameplay — unchanged, and still the real gap.**
This one is not a regression; it is the documented trust limitation. The
plausibility bound narrows what a fabricated result can claim, but the only true
fix is deterministic replay, which remains the next milestone. Mainnet launch
should either gate on replay or ship with the trust model stated plainly, as the
roadmap already does. The signed payload and emitted event now carry `seed` and
`traceHash`, so replay can be turned on without redeploying.

---

# Addendum 3 — V1 production-state hardening

The Sites runtime now uses its supported D1 `DB` binding instead of the proposed
KV bindings. Run tickets, shared fixed-window rate limits, and the event-indexed
leaderboard cursor/snapshot are durable across Worker isolates and regions.

Attestation is now retry-safe. D1 conditionally stores the first payload hash and
verifier signature for a run ID. An identical retry returns that exact stored
signature, while another payload conflicts. The client likewise preserves the
typed payload, player signature, verifier signature, and submitted transaction
hash so a rejected gas prompt or interrupted receipt wait does not request a
second attestation or create a second transaction.

Turnstile now fails configuration closed: the secret and public site key must be
present as a pair, or submissions remain disabled. Schema-backed integration
tests cover ticket idempotency and conflict, the shared rate limiter, and
monotonic leaderboard cursors.

Deterministic gameplay replay remains the strongest answer to a modified client,
but is explicitly a V2 feature. V1 is a fun community leaderboard with no
material prize attached to winning; its bounded-verifier trust limitation is
disclosed in the README, roadmap, and Mainnet runbook.
