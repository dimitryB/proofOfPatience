# Acceptance checklist

## Player experience

- [ ] The game opens and starts without a wallet or payment.
- [ ] Keyboard, pointer, and touch controls work.
- [ ] A moderate-reflex player can usually remain active for four to five
  minutes.
- [ ] Sound can be disabled.
- [ ] Reduced-motion preferences are respected.
- [ ] Network or wallet failure does not lose the completed local result.
- [ ] The question catalog is unchanged and contains POP V2, never POP V2.1.

## Onchain behavior

- [ ] The application targets Hemi Mainnet in production.
- [ ] Practice costs the player nothing and never requires a wallet.
- [ ] Onchain submission clearly discloses that the player pays Hemi network gas.
- [ ] The contract rejects duplicate run IDs.
- [ ] Invalid, expired, wrong-player, and wrong-version attestations fail.
- [ ] Confirmed scores remain readable after browser refresh or device change.
- [ ] Contract events and stored best scores agree.
- [ ] Every leaderboard entry links to verifiable Hemi chain evidence.
- [ ] The trust and anti-cheat model is documented honestly.

## Engineering quality

- [ ] `npm run check` passes from a clean install.
- [ ] Solidity compile and test commands are documented and pass.
- [ ] Contract, verifier, and frontend versions are pinned.
- [ ] No private key, mnemonic, secret RPC URL, or verifier credential is in Git.
- [ ] Production configuration uses protected environment values.
- [ ] Important transaction states have user-readable recovery messages.
- [ ] Contract address, chain, deploy transaction, verifier role, admin role, and
  upgrade policy are documented.

## Contest readiness

- [ ] Repository is public on GitHub or GitLab.
- [ ] Repository license is MIT.
- [ ] Live game is reachable without fees.
- [ ] README contains setup, architecture, testing, deployment, and contract
  information.
- [ ] Submission grants permission for future HAIR Games seasons.
- [ ] A final desktop and mobile playthrough has been recorded.
- [ ] A new person can follow the README and run the project locally.
- [ ] Mainnet behavior is completed before judging.

## Final owner sign-off

- [ ] Gameplay feel approved.
- [ ] Copy and social card approved.
- [ ] Contract trust model approved.
- [ ] Player-paid gas UX approved.
- [ ] Public repository contents approved.
- [ ] Contest submission text approved.
