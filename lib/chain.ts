import {
  defineChain,
  getTypesForEIP712Domain,
  hashTypedData,
  keccak256,
  parseAbi,
  serializeTypedData,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const HEMI_CHAIN_ID = 43_111;
export const HEMI_CHAIN_ID_HEX = "0xa867";
export const HEMI_RPC_URL = "https://rpc.hemi.network/rpc";
export const HEMI_EXPLORER_URL = "https://explorer.hemi.xyz";
export const GAME_VERSION_LABEL = "proof-of-patience-v1";
export const GAME_VERSION = keccak256(stringToHex(GAME_VERSION_LABEL));
export const SCORE_DOMAIN_NAME = "Proof of Patience";
export const SCORE_DOMAIN_VERSION = "1";

/** Mirrors `MAX_SCORE` in the contract. Kept in sync by `npm run check`. */
export const MAX_SCORE = 250_000_000;

export const hemiChain = defineChain({
  id: HEMI_CHAIN_ID,
  name: "Hemi Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [HEMI_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Hemi Explorer", url: HEMI_EXPLORER_URL },
  },
});

export const scoreSubmissionTypes = {
  ScoreSubmission: [
    { name: "runId", type: "bytes32" },
    { name: "gameVersion", type: "bytes32" },
    { name: "player", type: "address" },
    { name: "score", type: "uint64" },
    { name: "survivalSeconds", type: "uint32" },
    { name: "answered", type: "uint32" },
    { name: "shots", type: "uint32" },
    { name: "hits", type: "uint32" },
    { name: "seed", type: "bytes32" },
    { name: "traceHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/**
 * The verifier signs this, not the player's payload.
 *
 * `scoreHash` is the player's FULL EIP-712 digest — `0x1901 ‖ domainSeparator ‖
 * structHash` — not the struct hash. Signing the struct hash produces
 * signatures the contract rejects, and the failure only shows up on chain.
 */
export const verifierAttestationTypes = {
  VerifierAttestation: [{ name: "scoreHash", type: "bytes32" }],
} as const;

export const proofOfPatienceScoresAbi = parseAbi([
  "function verifier() view returns (address)",
  "function activeGameVersion() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function nextEligibleAt(address player) view returns (uint64)",
  "function blockedPlayers(address player) view returns (bool)",
  "function currentWeekId() view returns (uint256)",
  "function allPlayerCount() view returns (uint256)",
  "function weeklyPlayerCount(uint256 weekId) view returns (uint256)",
  "function scoreCeiling(uint32 answered, uint32 hits) pure returns (uint256)",
  "function getAllTimeScores(uint256 offset, uint256 limit) view returns ((bytes32 runId, address player, uint64 score, uint32 survivalSeconds, uint32 answered, uint32 shots, uint32 hits, uint64 submittedAt)[])",
  "function getWeeklyScores(uint256 weekId, uint256 offset, uint256 limit) view returns ((bytes32 runId, address player, uint64 score, uint32 survivalSeconds, uint32 answered, uint32 shots, uint32 hits, uint64 submittedAt)[])",
  "function submitScore((bytes32 runId, bytes32 gameVersion, address player, uint64 score, uint32 survivalSeconds, uint32 answered, uint32 shots, uint32 hits, bytes32 seed, bytes32 traceHash, uint64 deadline) submission, bytes playerSignature, bytes verifierSignature)",
  "event ScoreSubmitted(bytes32 indexed runId, address indexed player, uint256 indexed weekId, (bytes32 runId, address player, uint64 score, uint32 survivalSeconds, uint32 answered, uint32 shots, uint32 hits, uint64 submittedAt) result, bytes32 seed, bytes32 traceHash)",
  "event AllTimeBestVoided(address indexed player, bytes32 indexed runId)",
  "event WeeklyScoreVoided(address indexed player, uint256 indexed weekId, bytes32 indexed runId)",
]);

/** Placeholder until deterministic replay ships. Accepted on chain today. */
export const EMPTY_TRACE_HASH = `0x${"0".repeat(64)}` as const;

export interface RunProof {
  runId: Hex;
  issuedAt: number;
  ticket: Hex | null;
  /**
   * Chosen by the server at ticket time, not by the browser.
   *
   * V1 checks that it matches the durable server-issued ticket. The replay
   * verifier on the V2 roadmap can therefore be switched on without redeploying:
   * the server already knows which seed a run was played with, and the value is
   * bound into the signed payload and emitted on chain.
   */
  seed: Hex;
}

export interface FinalRunResult extends RunProof {
  score: number;
  survivalSeconds: number;
  answered: number;
  shots: number;
  hits: number;
  traceHash: Hex;
}

export interface ScoreSubmissionPayload {
  runId: Hex;
  gameVersion: Hex;
  player: Address;
  score: number;
  survivalSeconds: number;
  answered: number;
  shots: number;
  hits: number;
  seed: Hex;
  traceHash: Hex;
  deadline: number;
}

export function toTypedScoreSubmission(submission: ScoreSubmissionPayload) {
  return {
    ...submission,
    score: BigInt(submission.score),
    deadline: BigInt(submission.deadline),
  };
}

export function scoreTypedData(submission: ScoreSubmissionPayload, verifyingContract: Address) {
  return {
    domain: {
      name: SCORE_DOMAIN_NAME,
      version: SCORE_DOMAIN_VERSION,
      chainId: HEMI_CHAIN_ID,
      verifyingContract,
    },
    types: scoreSubmissionTypes,
    primaryType: "ScoreSubmission" as const,
    message: toTypedScoreSubmission(submission),
  };
}

/**
 * JSON payload for `eth_signTypedData_v4`.
 *
 * Viem's hashing helpers infer the EIP712Domain fields from `domain`, but its
 * serializer intentionally emits only domain fields declared in
 * `types.EIP712Domain`. Supplying only the score struct therefore serialized
 * `domain: {}` and made browser-wallet signatures impossible to verify against
 * the domain-bound digest used by both the server and contract.
 */
export function serializeScoreTypedData(
  submission: ScoreSubmissionPayload,
  verifyingContract: Address,
) {
  const typedData = scoreTypedData(submission, verifyingContract);
  return serializeTypedData({
    ...typedData,
    types: {
      EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }),
      ...typedData.types,
    },
  });
}

/** The envelope the verifier signs. `scoreHash` is the player's full digest. */
export function attestationTypedData(
  submission: ScoreSubmissionPayload,
  verifyingContract: Address,
) {
  return {
    domain: {
      name: SCORE_DOMAIN_NAME,
      version: SCORE_DOMAIN_VERSION,
      chainId: HEMI_CHAIN_ID,
      verifyingContract,
    },
    types: verifierAttestationTypes,
    primaryType: "VerifierAttestation" as const,
    message: { scoreHash: hashTypedData(scoreTypedData(submission, verifyingContract)) },
  };
}

/* ------------------------------- plausibility ------------------------------- */

/**
 * The highest score a run answering `answered` questions with `hits` correct
 * letters could actually have produced.
 *
 * Derived from every award site in the simulation:
 *   - per correct letter: `20 + combo * 3`, combo <= answered      -> 3ha + 20h
 *   - per answer: `spec.value * combo`, value <= 340, combo <= answered
 *     summed over the run: sum(340 * i) for i in 1..a               -> 170a(a+1)
 *   - perfect-chain bonus <= 750, backlog burn 300, POP OFF 260     -> 1310a
 *   - a perfect-chain bonus and a backlog burn can also land on the
 *     very first answer, so they appear in the constant too         ->   1050
 *   - five MWM breaks at 250, end-of-round <= 6000                  ->   7250
 *
 * This is a real upper bound, not a guess: verified against a full sweep with
 * zero false rejections. The contract carries a much looser version of the same
 * shape (`scoreCeiling`, ~5x headroom) because it cannot be changed after
 * deployment; this one is tight because it can.
 */
export function honestScoreCeiling(answered: number, hits: number) {
  const a = answered;
  const h = hits;
  return 170 * a * (a + 1) + 1_310 * a + 3 * h * a + 20 * h + 8_300;
}

/** Tolerance over `honestScoreCeiling` before a result is refused. */
export const SCORE_TOLERANCE = 1.25;

/**
 * Rate ceilings implied by the fire cooldown, in events per second.
 *
 * A SOON is four letters at a 0.06s cooldown, so shooting alone answers at most
 * 4.17 questions a second. POP OFF answers cost no time — but they are not free
 * either: the meter gains at most 8 per answer and a clear needs 100, so every
 * POP OFF is paid for with at least 12.5 shot-gated answers and returns at most
 * 8. That bounds the inflation at 1.64x, giving 6.83/s. Rounded up to 8.
 *
 * These only bind on short runs; past about 125 seconds the contract's
 * `MAX_ANSWERED` is the tighter limit.
 */
export const MAX_ANSWERS_PER_SECOND = 8;
export const MAX_SHOTS_PER_SECOND = 17;

export interface PlausibilityInput {
  score: number;
  survivalSeconds: number;
  answered: number;
  shots: number;
  hits: number;
}

/** Returns a human-readable reason when a result could not have been played. */
export function implausibleReason(result: PlausibilityInput): string | null {
  if (result.hits > result.shots) return "More hits than shots.";
  if (result.score > MAX_SCORE) return "Score is above the contract maximum.";

  // `survivalSeconds` is floored before it is signed, so a run reported as S
  // seconds actually ran for up to S+1. Without this the rate rules refuse
  // honest sub-five-second runs.
  const duration = result.survivalSeconds + 1;

  // Capped at the contract's own maximum so the verifier is never more
  // permissive than the chain — otherwise it would sign a result that reverts
  // and the player would pay gas to learn it.
  const ceiling = Math.min(
    honestScoreCeiling(result.answered, result.hits) * SCORE_TOLERANCE,
    MAX_SCORE,
  );
  if (result.score > ceiling) return "Score is higher than this run's answers could produce.";

  if (result.answered > duration * MAX_ANSWERS_PER_SECOND) {
    return "More answers than the round length allows.";
  }
  if (result.shots > duration * MAX_SHOTS_PER_SECOND + 1) {
    return "More shots than the fire rate allows.";
  }
  return null;
}

/* --------------------------------- responses -------------------------------- */

export interface ChainConfigResponse {
  enabled: boolean;
  submissionEnabled: boolean;
  reason?: string;
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  contractAddress?: Address;
  gameVersion: Hex;
  paused?: boolean;
  /**
   * Public Turnstile site key. Present only when the operator has configured
   * bot protection. When present, the client must attach a Turnstile token to
   * its attestation or the Worker will reject it.
   */
  turnstileSiteKey?: string;
}

export interface LeaderboardEntry {
  player: Address;
  score: number;
  survivalSeconds: number;
  answered: number;
  submittedAt: number;
  runId: Hex;
}

export interface LeaderboardResponse {
  enabled: boolean;
  /** Whether the response came from the durable log index or bounded RPC reads. */
  source?: "events" | "scan";
  weekId?: number;
  weekly: LeaderboardEntry[];
  allTime: LeaderboardEntry[];
  contractAddress?: Address;
  /** Set when the board could not be built from a complete view of the data. */
  partial?: boolean;
  error?: string;
}

export interface PlayerStatusResponse {
  address: Address;
  nextEligibleAt: number;
  blocked: boolean;
}
