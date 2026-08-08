import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("ProofOfPatienceScoresModule", (m) => {
  const owner = m.getParameter("owner");
  const verifier = m.getParameter("verifier");
  const gameVersion = m.getParameter("gameVersion");
  const seasonStart = m.getParameter("seasonStart");

  const scores = m.contract("ProofOfPatienceScores", [
    owner,
    verifier,
    gameVersion,
    seasonStart,
  ]);

  return { scores };
});
