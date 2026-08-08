# Contributing

## Before changing code

1. Read [docs/DEVELOPER_HANDOFF.md](docs/DEVELOPER_HANDOFF.md).
2. Confirm the requested work against
   [docs/IMPLEMENTATION_BACKLOG.md](docs/IMPLEMENTATION_BACKLOG.md).
3. Preserve the product guardrails in the README.
4. For Hemi integration, verify current network details against official Hemi
   documentation rather than copying values from old examples.

## Development workflow

1. Create a short-lived branch from the current main branch.
2. Keep each change focused and avoid unrelated visual or gameplay rewrites.
3. Add or update tests for game rules, contract behavior, and score validation.
4. Run `npm run check` before requesting review.
5. Explain player-facing changes and include manual test notes in the pull
   request.

Suggested branch names:

- `feat/hemi-score-contract`
- `feat/gasless-score-submission`
- `feat/onchain-leaderboard`
- `fix/mobile-controls`

## Pull-request expectations

- State what changed and why.
- List automated and manual checks performed.
- Call out contract storage, gas, trust, or security tradeoffs.
- Include contract address and explorer links for deployed contract changes.
- Never commit secrets, private keys, mnemonics, or privileged RPC credentials.
- Request product-owner approval for changes to satire copy, question labels,
  difficulty, branding, or the five-minute round structure.

## Content safety

The game is unofficial community satire. Do not present jokes as factual claims.
Do not add a real person's likeness, private information, or exact community
handle without permission.
