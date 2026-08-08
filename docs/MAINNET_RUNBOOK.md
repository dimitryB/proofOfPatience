# Hemi Mainnet runbook

This is the production handoff for the onchain score registry and player-paid
submission flow. It separates the owner and verifier so a compromised
web-service key cannot administer the contract.

Hemi Mainnet is EVM-compatible. Its chain ID is `43111`, its native gas token is
ETH, its public RPC is `https://rpc.hemi.network/rpc`, and its explorer is
`https://explorer.hemi.xyz`.

## What is already implemented

- `ProofOfPatienceScores.sol` verifies both the player's EIP-712 signature and
  the authorized verifier's signature.
- The contract enforces a rolling 24-hour cooldown per wallet, unique run
  IDs, a short signature deadline, game-version matching, and result bounds.
- Weekly and all-time scores are independently readable from Hemi. The Worker
  reads unsorted pages and ranks the top ten offchain.
- The hosted Worker stores signed run tickets in D1, validates timing and score
  bounds, and signs at most one result payload per run. An identical request is
  idempotent, so a lost response can be retried without consuming the run.
- The connected player wallet submits the attested result and pays the Hemi
  network gas. The client preserves the signed payload, attestation, and
  transaction hash across retryable failures.
- Practice remains fully local and wallet-free when Mainnet or the verifier is
  unavailable.

The contract is non-upgradeable and owner-pausable. The owner can pause or
unpause submissions, rotate the verifier, change the accepted game version,
block or unblock a wallet, precisely void a named weekly or all-time result, and
transfer ownership through OpenZeppelin's two-step ownership flow. Reads remain
available while submissions are paused.

## Security boundary

Use two distinct Hemi Mainnet accounts:

| Account | Holds ETH | Used where | Authority |
| --- | --- | --- | --- |
| Owner/deployer | Deployment and administration gas | Offline Hardhat keystore | Pause; rotate verifier/version; block; targeted void; transfer ownership |
| Verifier | No | Sites secret | Attest run tickets and bounded final results |

Prefer a hardware wallet or multisig as the final owner. A one-wallet-per-day
rule is not a one-human-per-day rule; a player can create more wallets. The
Worker adds best-effort per-IP throttles, while the contract remains
authoritative for cooldown and replay protection.

The current verifier proves that the server-issued ticket existed for at least
the claimed duration, was not used for another payload, and that all submitted
fields are within game bounds. It does not replay every input, so a determined
player who alters browser state may forge a plausible bounded score. V1 accepts
this clearly disclosed limitation because the board is a fun community activity
with no material prize attached to winning. Deterministic server replay is the
V2 anti-cheat milestone, not a Mainnet launch requirement for V1.

## Release decision: direct Mainnet rollout

This V1 release intentionally skips a Testnet rehearsal because the operator
could not obtain test gas and judged the available Testnet unreliable for an
end-to-end release gate. That waiver does not bypass any local or Mainnet
validation step in this runbook.

Compensating controls:

- run the complete optimized contract, Worker, build, and rendered-page suites;
- fund the deployer with only a small Mainnet balance;
- validate every immutable constructor value before deployment;
- verify the deployed source and read every privileged value from the explorer;
- keep the hosted contract and verifier settings unset until verification is complete;
- use a minimally funded player wallet for the first transaction; and
- announce onchain recording only after the production smoke test passes.

## 1. Prepare and test

Use Node.js 22 LTS (22.13 or newer), then install and validate the pinned build:

```bash
npm ci
npm run check
```

The contract suite should report 16 passing tests and the Worker state suite
should report four passing tests before any Mainnet action.
Do not deploy from a dirty or unreviewed commit.

## 2. Create the production accounts

Create the owner/deployer and verifier in a reputable EVM wallet. Do
not paste seed phrases into a terminal, source file, issue, chat, or deployment
log. Record only their public addresses in the release notes.

Fund the deployer with enough ETH on Hemi Mainnet for one deployment. The
verifier does not send transactions and needs no ETH. Each submitting player
must hold enough ETH on Hemi Mainnet to pay the score transaction's network fee.

Before funding, add and verify the Hemi network in the wallet:

| Setting | Value |
| --- | --- |
| Network name | Hemi Mainnet |
| RPC URL | `https://rpc.hemi.network/rpc` |
| Chain ID | `43111` |
| Currency symbol | `ETH` |
| Explorer | `https://explorer.hemi.xyz` |

## 3. Configure deployment parameters

Create the ignored production parameter file:

```bash
cp ignition/parameters/hemi-mainnet.example.json ignition/parameters/hemi-mainnet.json
```

Replace:

- `owner` with the final owner address;
- `verifier` with the address derived from `POP_VERIFIER_PRIVATE_KEY`;
- `seasonStart` only if a different weekly boundary is required.

The committed example anchors week zero to Monday, August 3, 2026 at 00:00 UTC.
The game-version hash is frozen to:

```text
proof-of-patience-v1
0x85df25dbcff56b9494cf40869260696bbf28075241b0c7b2620b93ed724025a5
```

Any gameplay or scoring-rule change requires a new label/hash and an owner call
to `setActiveGameVersion` before the new verifier begins accepting runs.

## 4. Store the deployer credential locally

Hardhat reads encrypted configuration variables. Enter values only at its
hidden prompts:

```bash
npx hardhat keystore set HEMI_RPC_URL
npx hardhat keystore set HEMI_DEPLOYER_PRIVATE_KEY
npx hardhat keystore list
```

Use `https://rpc.hemi.network/rpc` for the first prompt. Use the deployer private
key for the second. Never put the deployer key in `.env`, shell history, or Git.

## 5. Deploy and verify on Hemi Mainnet

Confirm the owner and verifier addresses in the parameter file a second time,
then run:

```bash
npm run contract:deploy:hemi
```

The command uses the optimized production compiler profile and requests source
verification from Hemi's Blockscout explorer. Preserve the deployment output
locally. The deployed address is also written under:

```text
ignition/deployments/pop-hemi-mainnet/deployed_addresses.json
```

Open the contract in `https://explorer.hemi.xyz`, confirm that its source is
verified, and read these values before continuing:

- `verifier` equals the production verifier address;
- `activeGameVersion` equals the hash above;
- `SUBMISSION_COOLDOWN` is `86400`;
- `seasonStart` equals the intended UTC boundary;
- `owner` equals the intended owner address.

If automated verification fails but deployment succeeds, use the explorer's
contract-verification UI with Solidity `0.8.28`, optimization enabled, 200 runs,
the Paris EVM target, and the four constructor arguments from the parameter file. Do not deploy a
second contract just because source verification failed.

## 6. Configure the hosted service

Add these runtime values to the existing Sites project. Mark the verifier key
as a secret:

| Key | Secret | Value |
| --- | --- | --- |
| `HEMI_RPC_URL` | No | `https://rpc.hemi.network/rpc` |
| `HEMI_RPC_FALLBACKS` | No | Optional comma-separated production RPC fallbacks |
| `POP_CONTRACT_ADDRESS` | No | Deployed score-contract address |
| `POP_VERIFIER_PRIVATE_KEY` | **Yes** | Verifier key matching the constructor address |
| `POP_DEPLOY_BLOCK` | No | Exact block in which the contract was deployed |
| `POP_TURNSTILE_SECRET` | **Yes** | Optional Turnstile secret; set with the site key or omit both |
| `POP_TURNSTILE_SITE_KEY` | No | Matching public Turnstile site key |

The committed `.openai/hosting.json` declares the logical D1 binding as `DB`.
Sites provisions it and applies the SQL migrations in `drizzle/` during
packaging. D1 stores run tickets and their one allowed attestation, shared rate
limits, and the event-indexed leaderboard cursor/snapshot. Do not rename or
remove this binding in production. `POP_DEPLOY_BLOCK` enables log indexing only
when `DB` is available; otherwise the Worker deliberately uses the bounded
contract-read fallback.

Never use a `NEXT_PUBLIC_` prefix for the verifier key. It is a Worker-only binding
and must never enter the browser bundle. After changing runtime values, publish
a new Sites deployment so its environment revision is active.

For local end-to-end testing only, copy `.env.example` to an ignored `.env.local`
and fill the same values. Do not copy production keys onto a shared machine.

## 7. Production smoke test

Check the public configuration without exposing secrets:

```bash
curl --fail --silent https://proof-of-patience-pop.dbur70.chatgpt.site/api/chain/config
curl --fail --silent https://proof-of-patience-pop.dbur70.chatgpt.site/api/chain/leaderboard
```

The first response must show `enabled: true` and `submissionEnabled: true` with
chain ID `43111`, the expected contract address, and the expected game-version
hash. If Turnstile is enabled it must expose the expected public site key. The
second response must show `enabled: true` and `source: "events"` after the first
index refresh.

Then perform one complete browser test:

1. Start and play without connecting a wallet.
2. Finish the run and choose **Record on Hemi**.
3. Connect a wallet funded with enough Hemi Mainnet ETH for one transaction.
4. Review and sign the typed score.
5. Review the wallet's gas estimate, submit the transaction, and open its
   explorer link.
6. Refresh and confirm the score appears on the weekly and all-time boards.
7. Try another completed run from the same wallet and confirm the UI reports the
   exact next eligible time without sending another transaction.

Before starting a second run, also reject the gas prompt once and press **Record
on Hemi** again. The retry must reuse the existing signature and attestation,
open a new gas prompt, and record exactly one transaction for the run.

Also test practice mode in a browser with no wallet extension. It must remain
fully playable.

## 8. Release record and operations

Add the following to `README.md` after deployment:

- score-contract address and explorer link;
- deployment transaction link;
- owner and verifier public addresses;
- week-zero timestamp;
- the exact deployed Git commit.

Monitor failed Worker attestations and RPC errors during the contest. If the
verifier key is exposed, first call `pause`, then call `setVerifier`, update the
`POP_VERIFIER_PRIVATE_KEY` secret and publish the new environment. Confirm
`/api/chain/config` reports the new verifier configuration before calling
`unpause`.

For a poisoned score, pause if abuse is ongoing, identify the exact player and
run ID from the explorer, and void the weekly entry before the all-time entry.
Use `weekIdOfAllTimeBest` before deleting the all-time row, then call
`voidWeeklyScore` and `voidAllTimeBest` with the expected run ID. The run remains
spent. `setPlayerBlocked` prevents further submissions from that wallet but is
not proof that two wallets belong to the same person.

After the launch is stable, transfer ownership to the final multisig using
`transferOwnership`; the multisig must then call `acceptOwnership`.
