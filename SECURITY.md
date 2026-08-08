# Security

## Reporting

Report suspected vulnerabilities privately to the project owner before opening
a public issue. Include reproduction steps, affected commit, impact, and any
suggested mitigation.

## Secrets

Never commit:

- wallet private keys or seed phrases;
- deployer or relayer credentials;
- sponsored-transaction signing keys;
- privileged RPC URLs or API keys;
- production environment files.

Use separate development and production wallets. Keep the deployer key offline
after deployment when practical, and give administrative roles to a multisig or
time-delayed controller if the final contract is upgradeable.

## Smart contracts

- Pin compiler and dependency versions.
- Use established libraries for access control and signature verification.
- Protect score submission from replay across runs, chains, contracts, and game
  versions.
- Bound numeric fields and reject impossible durations, scores, and accuracy.
- Test duplicate submissions, invalid signatures, expired attestations, and
  unauthorized upgrades.
- Document every privileged role and whether the contract can be paused or
  upgraded.

## Client trust

Browser code is controlled by the player and cannot be trusted to certify its
own score. A production leaderboard needs deterministic replay verification,
a trusted attestation service, a proof system, or a clearly documented weaker
trust model. Hashing a client-provided score does not make it cheat-resistant.
