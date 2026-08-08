# Developer handoff

## Mission

Maintain the completed Proof of Patience browser game and its verifiable,
player-paid Hemi Mainnet score submission and global leaderboard without
changing the core game feel.

Current prototype:
https://proof-of-patience-pop.dbur70.chatgpt.site

## Current snapshot

Working:

- complete five-minute game loop;
- gradual four-stage difficulty curve;
- keyboard, pointer, and touch play;
- aim assistance and hold-to-fire;
- sound toggle and synthesized effects;
- POP Off ability;
- local high score;
- responsive UI and reduced-motion styling;
- product regression tests;
- social sharing metadata and card;
- Cloudflare Workers-compatible production build;
- wallet-at-end connection and Hemi network switching;
- verifier-attested, player-paid score submission;
- score contract, deployment module, tests, and read-only leaderboards.

Not implemented:

- production Hemi Mainnet contract deployment and source verification;
- final owner/verifier account configuration;
- deterministic input replay for stronger anti-cheat verification.

## Read this first

1. Run `npm install` and `npm run check`.
2. Play one complete round before refactoring anything.
3. Read `lib/pop.ts` for rules and `app/page.tsx` for the game loop.
4. Read [BLOCKCHAIN_ROADMAP.md](BLOCKCHAIN_ROADMAP.md).
5. Agree with the owner on the score-verification tier before selecting wallet
   or contract libraries.

## Product invariants

These require explicit owner approval to change:

- title: Proof of Patience (POP);
- framing: MWM: Community Takeover;
- five-minute round;
- approachable first four minutes and difficult final minute;
- SOON ammunition order;
- current ten-question catalog;
- POP V2 remains, POP V2.1 remains excluded;
- Hemi-orange visual identity;
- immediate free play without a wallet gate;
- keyboard, pointer, and touch support;
- fictional-satire content note.

## Recommended integration boundary

Keep the real-time game loop independent of wallet and network libraries.
At the moment a run ends, convert the game state into a small immutable
`GameResult` object:

```ts
type GameResult = {
  runId: string;
  gameVersion: string;
  player: string;
  score: number;
  survivalSeconds: number;
  questionsAnswered: number;
  shots: number;
  hits: number;
  seed: number;
  traceHash: string;
};
```

The chain integration should consume this result after the game ends. It must
not slow the animation loop or make a failed wallet transaction erase the local
result.

## Ownership decisions still needed

Before Mainnet deployment, confirm:

1. Is a server-attested score acceptable, or is deterministic replay/proof
   required for judging?
2. Who controls the score-authority and contract-admin keys?
3. Which public owner and verifier addresses will be used for Mainnet?
4. Should anonymous players appear locally only, or may they submit after
   connecting a wallet at the end?
5. Is the final leaderboard best score per wallet, best score per game version,
   or both?

Recommended defaults are documented in
[BLOCKCHAIN_ROADMAP.md](BLOCKCHAIN_ROADMAP.md).

## Handoff boundaries

- The current Sites deployment is an existing production project. Do not replace
  its local `.openai/hosting.json` identifier.
- The public contest repository should be created separately on GitHub or GitLab.
- No production secrets are present in this working copy.
- No current game code depends on a database, login system, or blockchain SDK.
- Keep generated build folders and local environment files out of source control.

## Delivery evidence

The final developer delivery should include:

- public source repository under MIT;
- live game URL;
- Hemi Mainnet contract address and explorer link;
- verified Solidity source;
- contract and application test results;
- documented player-paid gas flow;
- written trust/anti-cheat model;
- wallet-free play and wallet-at-end manual test;
- recovery behavior for rejected, delayed, and duplicate submissions.
