# Prioritized implementation backlog

The deadline-oriented path is P0 first. Do not begin P2 work until a complete
Hemi Mainnet score has been submitted from the production game.

## P0 — contest-critical

### 1. Freeze and isolate run results

- [x] Add a game-version constant.
- [x] Define canonical `GameResult`, seed, and trace-receipt fields.
- [x] Generate collision-resistant run IDs.
- [x] Keep local game-over results retryable after network failures.

Completion: the finished V1 result is frozen, signed once, and remains retryable
after Turnstile, network, wallet, or receipt-wait failures.

### 2. Implement the score contract

- [ ] Select a pinned Solidity toolchain.
- [ ] Implement EIP-712 verifier authorization.
- [ ] Add run replay protection and expiry.
- [ ] Store per-player best score by game version.
- [ ] Emit complete score events.
- [ ] Add bounds and access-control tests.
- [ ] Measure worst-case gas.

Completion: contract tests cover successful, invalid, and duplicate submissions.

### 3. Implement verifier attestation and direct submission

- [x] Validate server-issued ticket timing, seed, score plausibility, and bounds.
- [x] Store exactly one payload attestation per run and make identical retries idempotent.
- [x] Sign and return short-lived typed attestations.
- [x] Submit directly from the player's wallet with an explicit gas prompt.
- [x] Add shared D1 rate limiting and optional Turnstile protection.
- [x] Preserve the payload, attestation, and transaction hash across retryable failures.

Completion: a funded wallet can pay gas to save a bounded, ticket-backed score;
declining the transaction never affects practice and can reuse the one permitted
attestation. Full gameplay validation is explicitly V2.

### 4. Add wallet-at-end UX

- [ ] Keep the start button wallet-free.
- [ ] Add **Save score on Hemi** to the result screen.
- [ ] Connect wallet and switch to Hemi only when requested.
- [ ] Display verifying, submitting, confirmed, rejected, and retry states.
- [ ] Preserve local result if the player declines or submission fails.
- [ ] Add accessible status announcements.

Completion: declining wallet access never prevents replaying the game.

### 5. Add the leaderboard

- [ ] Provide read-only results without wallet connection.
- [ ] Rank best score per wallet and game version.
- [ ] Show shortened wallet, score, survival time, and confirmation link.
- [ ] Mark the connected player's row.
- [ ] Handle loading, empty, stale, and RPC-error states.
- [ ] Link to independently readable chain evidence.

Completion: a confirmed score appears after refresh and is traceable to Hemi.

### 6. Mainnet release

- [ ] Complete Hemi Testnet rehearsal.
- [ ] Review contract and privileged roles.
- [ ] Deploy to Hemi Mainnet.
- [ ] Verify/publish Solidity source.
- [ ] Configure production without committing secrets.
- [ ] Run production smoke tests.
- [ ] Record contract address and explorer links in README.

## P1 — submission quality

- [ ] Add one-click copy for score and transaction link.
- [ ] Add clear wallet/mobile failure recovery.
- [ ] Add game-version filter to the leaderboard.
- [ ] Add privacy-respecting performance and submission diagnostics.
- [ ] Test common desktop and mobile browsers.
- [ ] Confirm the social card on major link-unfurl sizes.
- [ ] Record a short gameplay clip for the contest post.

## P2 — optional originality

- [ ] Extract the deterministic simulation into a shared headless module.
- [ ] Define and size-limit a canonical timestamped input trace.
- [ ] Replay each trace in the Worker and require exact result/trace-hash parity.
- [ ] Add browser/Worker replay parity and tamper tests.
- [ ] Display a cryptographic run receipt after verification.
- [ ] Add a proof-status visual without blocking play.
- [ ] Explore a ZK replay proof behind a feature flag.
- [ ] Add community seasons while preserving the base five-minute mode.

## Suggested short schedule

| Day | Outcome |
| --- | --- |
| 1 | Freeze result/version fields and select the bounded V1 trust model |
| 2 | Contract implementation and tests |
| 3 | D1-backed idempotent verifier and abuse controls |
| 4 | Verifier attestation and direct wallet transaction |
| 5 | Wallet-at-end UX and leaderboard |
| 6 | Testnet rehearsal, abuse tests, mobile regression |
| 7 | Mainnet deployment, verification and production smoke test |

Keep one contingency day for network, wallet, or hosting issues.
