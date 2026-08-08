# Proof of Patience™ (POP)

An unofficial five-minute browser arcade game presented as **MidWeek With Max:
Community Takeover**. Community questions descend toward the broadcast desk and
the player answers by firing `S → O → O → N`.

[Play the current prototype](https://proof-of-patience-pop.dbur70.chatgpt.site)

![Proof of Patience social card](public/og.png)

## Project status

The browser game and blockchain vertical slice are complete. Practice and the
device high score remain wallet-free; after a run, a player may sign an EIP-712
score, receive a verifier attestation, and submit it from their wallet on Hemi
Mainnet. The player pays the network gas. The contract enforces one recorded
score per wallet every rolling 24 hours and exposes weekly and all-time boards.
Mainnet deployment is pending. The production owner and verifier addresses have
been selected, while all private keys and hosted runtime secrets remain outside
the repository.

Start with [the developer handoff](docs/DEVELOPER_HANDOFF.md), then work through
[the implementation backlog](docs/IMPLEMENTATION_BACKLOG.md) and
[acceptance checklist](docs/ACCEPTANCE_CHECKLIST.md).

## Gameplay

- Survive a five-minute MWM broadcast.
- Aim at a question and fire `S`, `O`, `O`, `N` in order.
- Some questions require more than one complete SOON.
- Answering questions builds score, combo, and the POP Off meter.
- POP Off clears the studio when its meter reaches 100%. It charges roughly once
  every dozen answers, so it is an emergency, not a routine.
- A ten-question backlog ends the show, at any point in the round. There is no immunity
  window; the last ninety seconds are the survival finale.

### Controls

| Action | Keyboard | Pointer/touch |
| --- | --- | --- |
| Aim | Left/Right or A/D | Drag across the stage |
| Fire | Hold Space | Hold the stage or ANSWER button |
| POP Off | P | POP OFF button |
| Restart | R | Play-again button |
| Sound | Header control | Header control |

## Five-minute difficulty curve

The curve ramps continuously for the whole five minutes. Nothing switches on or
off partway through, and there is no point at which the rules change.

- First 30 seconds: one slow guided caller, taking about 22 seconds to fall.
- The board cap then rises one caller every 34 seconds, from two up to eight.
- The show books callers faster as it goes: roughly one every 3.2 seconds at the
  top, one every 0.8 seconds by the close. That last figure is slightly more
  than a good player can answer, which is what makes the finale a real test.
- Callers also fall faster: about 22 seconds to reach the desk at the start,
  about 5 seconds at the end.
- Every third answered question can remove one item from the backlog.
- Each minute opens with an eight-second MWM break and one backlog reduction.
- **A full backlog ends the show at any point in the round, from the first
  second.** The opening is forgiving because it is genuinely easy — one slow
  caller with the whole desk to itself — and not because losing is disabled.
  A player who ignores the game entirely goes off air at about 1:30.

Earlier builds had a Producer Override that halved a full backlog instead of
ending the round, for the first four minutes. It made the opening unloseable and
pushed every loss into the last sixty seconds, because that was the first moment
a loss was permitted. It has been removed.

The curve is tuned against a headless playtest harness that drives the real
simulation with scripted players. Over 200 seeded rounds per skill tier: a
good-reflex player survives ~99% of rounds, a moderate-reflex player ~73%, and a
careless player ~27%, with failures spread across the last two minutes. That is
the measurement behind the "roughly four to five minutes" product guardrail.

The tuning constants and question catalog live in [lib/pop.ts](lib/pop.ts).

## Question catalog

1. WEN OG?
2. WEN VBK?
3. WEN ACTUAL DATE?
4. WEN POP V2?
5. WEN veHEMI REWARDS?
6. zkPROOF WHITEPAPER?
7. WEN POP CLAIM?
8. PLOUTOS HACK?
9. op-reth DONE?
10. WHERE IS JUSTIN?

## Technology

- TypeScript
- React 19 and Next-compatible App Router APIs
- Vinext and Vite
- Cloudflare Workers-compatible runtime
- Canvas 2D gameplay
- Solidity 0.8.28, OpenZeppelin Contracts and Hardhat
- viem for Hemi reads, EIP-712 verification and player-paid transactions
- Node's built-in test runner

There is no application login, analytics SDK, token, or prize system. Sites D1
stores short-lived run tickets, shared abuse limits, and the leaderboard index
cursor; canonical recorded scores remain independently readable from Hemi.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The development command prints the local URL. Production checks:

```bash
npm run check
```

Available commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server |
| `npm run build` | Build the Cloudflare-compatible application |
| `npm test` | Run contract tests, build, and run the regression suite |
| `npm run test:contract` | Run the Solidity integration suite |
| `npm run contract:compile` | Compile the optimized production contract |
| `npm run contract:deploy:hemi` | Deploy and verify with the ignored Mainnet parameters |
| `npm run lint` | Run static code checks |
| `npm run check` | Run lint, build, and tests |

## Project map

```text
app/page.tsx                 Canvas game loop, controls, HUD, audio and UI
app/globals.css              Responsive presentation and reduced-motion styles
app/layout.tsx               Page, Open Graph and X metadata
app/components/OnchainScore.tsx  Post-run attestation and player-paid transaction UI
app/components/Leaderboards.tsx  Weekly and all-time Hemi boards
lib/pop.ts                   Game rules, difficulty and question catalog
lib/chain.ts                 Hemi configuration, ABI, EIP-712 types and API models
contracts/                   Immutable Solidity score registry
test/                        Contract integration tests
public/og.png                Social sharing card
tests/rendered-html.test.mjs Product and tuning regression tests
worker/chain.ts              Run tickets, verifier attestations and chain reads
worker/index.ts              Cloudflare Worker entry point and API routing
docs/                        Developer handoff and blockchain plan
```

## Product guardrails

- Preserve the Hemi-orange MWM community-takeover identity.
- Keep a moderate-reflex player alive for roughly four to five minutes.
- Keep keyboard, pointer, and touch controls.
- Keep gameplay free. Do not require a wallet before playing.
- Store only final results onchain, not each shot or animation frame.
- Treat the copy as fictional community satire, not as factual allegations.
- Do not add real names, likenesses, or community handles without permission.

## Deployment

The current prototype is hosted with Sites on a Cloudflare-compatible build.
The local `.openai/hosting.json` binds this working copy to that existing site.
Do not replace its project identifier or create a second site accidentally.

For the contest handoff, publish this repository to GitHub or GitLab under the
MIT license and document the final Hemi contract addresses in this README.
Keep private keys, deployer mnemonics, verifier credentials, and RPC secrets out
of the repository.

Follow the [Hemi Mainnet runbook](docs/MAINNET_RUNBOOK.md) to create the two
production accounts, deploy and verify the contract, configure protected Sites
runtime values, and complete the player-paid transaction smoke test.

The V1 operator has intentionally waived a Testnet rehearsal after being unable
to obtain test gas and finding the available Testnet unsuitable for a reliable
end-to-end run. The compensating controls are the complete local contract and
Worker suites, minimal Mainnet funding, verified source and constructor values,
and keeping hosted submissions disabled until the Mainnet smoke test passes.

### Hemi Mainnet release record

| Field | Value |
| --- | --- |
| Chain | Hemi Mainnet (`43111`) |
| Score contract | Pending owner deployment |
| Deployment transaction | Pending owner deployment |
| Owner | `0x98978246D8Be2343c0e4C73812c4e1f0B83A20F2` |
| Verifier | `0x47948279A060cDAF1cEEd0777991E27d3448418F` |
| Game version | `0x85df25dbcff56b9494cf40869260696bbf28075241b0c7b2620b93ed724025a5` |
| Week zero | `2026-08-03T00:00:00Z` |

### Trust model

The player and verifier sign the same typed result, the connected wallet submits
it and pays gas, and the contract enforces cooldown and replay protection. The
verifier stores each signed run ticket in D1, checks elapsed time and numeric
bounds, and will attest only one payload per run. Lost responses can safely return
the same attestation for a retry. V1 does not deterministically replay every
control input, so the board resists casual tampering but is not Sybil-proof or
trustless. Deterministic replay is the documented V2 hardening milestone; this V1
board is a fun community activity with no material prize attached to winning.

## Documentation

- [Developer handoff](docs/DEVELOPER_HANDOFF.md)
- [Blockchain architecture and roadmap](docs/BLOCKCHAIN_ROADMAP.md)
- [Hemi Mainnet runbook](docs/MAINNET_RUNBOOK.md)
- [Prioritized implementation backlog](docs/IMPLEMENTATION_BACKLOG.md)
- [Definition of done](docs/ACCEPTANCE_CHECKLIST.md)
- [Contribution workflow](CONTRIBUTING.md)
- [Security guidance](SECURITY.md)

## Content note

This is fictional community satire and an unofficial fan game. It does not make
factual claims about rewards, security incidents, people, allocations, or
delivery dates. It uses no person's likeness.

## Ownership and trademarks

**Proof of Patience™** is a trademark of **Neva Technologies Inc**, the project
originator and principal contributor. The `™` symbol states the company's claim
to the mark; it does not represent a federal trademark registration.

The software is available under the MIT License. The project name and branding
may not be used to imply that a modified version is official, sponsored, or
endorsed by Neva Technologies Inc. See [TRADEMARKS.md](TRADEMARKS.md) for the
trademark policy and [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor
attribution.

## License

[MIT](LICENSE).
