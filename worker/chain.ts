import {
  bytesToHex,
  createPublicClient,
  hashTypedData,
  http,
  isAddress,
  isHex,
  parseAbiItem,
  verifyMessage,
  verifyTypedData,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  consumeRateLimit,
  issueRunTicket,
  readLeaderboardSnapshot,
  readRunTicket,
  storeAttestation,
  writeLeaderboardSnapshot,
  type D1Database,
} from "../db/chainState";
import {
  GAME_VERSION,
  HEMI_CHAIN_ID,
  HEMI_EXPLORER_URL,
  HEMI_RPC_URL,
  attestationTypedData,
  hemiChain,
  implausibleReason,
  proofOfPatienceScoresAbi,
  scoreTypedData,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type ScoreSubmissionPayload,
} from "../lib/chain";

export interface ChainEnv {
  /** Sites-provisioned D1 binding. Required for score submissions. */
  DB?: D1Database;
  HEMI_RPC_URL?: string;
  /** Comma-separated fallbacks, tried in order when the primary fails. */
  HEMI_RPC_FALLBACKS?: string;
  POP_CONTRACT_ADDRESS?: string;
  POP_VERIFIER_PRIVATE_KEY?: string;
  /** Block the contract was deployed in. Enables log-indexed leaderboards. */
  POP_DEPLOY_BLOCK?: string;
  /** Turnstile secret (server-side siteverify). Pairs with POP_TURNSTILE_SITE_KEY. */
  POP_TURNSTILE_SECRET?: string;
  /** Public Turnstile site key, delivered to the client so it can fetch a token. */
  POP_TURNSTILE_SITE_KEY?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScoreTuple {
  runId: Hex;
  player: Address;
  score: bigint;
  survivalSeconds: number;
  answered: number;
  shots: number;
  hits: number;
  submittedAt: bigint;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const MAX_BODY_BYTES = 12_000;
const RUN_TICKET_MAX_AGE = 6 * 60 * 60;
const SIGNATURE_MAX_AGE = 20 * 60;
const CLOCK_TOLERANCE = 15;
const LEADERBOARD_LIMIT = 10;

/** Conservative for public RPCs, most of which refuse ranges above ~10k. */
const LOG_CHUNK_BLOCKS = 9_000n;
/** Cap on chunks per refresh, so a cold cache can never hang a request forever. */
const MAX_LOG_CHUNKS = 40;
const BOARD_CACHE_SECONDS = 30;
const CONFIG_CACHE_MS = 60_000;
const ZERO_RUN = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const SCORE_SUBMITTED_EVENT = parseAbiItem(
  "event ScoreSubmitted(bytes32 indexed runId, address indexed player, uint256 indexed weekId, (bytes32 runId, address player, uint64 score, uint32 survivalSeconds, uint32 answered, uint32 shots, uint32 hits, uint64 submittedAt) result, bytes32 seed, bytes32 traceHash)",
);
const ALL_TIME_VOIDED_EVENT = parseAbiItem(
  "event AllTimeBestVoided(address indexed player, bytes32 indexed runId)",
);
const WEEKLY_VOIDED_EVENT = parseAbiItem(
  "event WeeklyScoreVoided(address indexed player, uint256 indexed weekId, bytes32 indexed runId)",
);

class RequestError extends Error {}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function configuredAddress(env: ChainEnv): Address | null {
  return env.POP_CONTRACT_ADDRESS && isAddress(env.POP_CONTRACT_ADDRESS)
    ? env.POP_CONTRACT_ADDRESS
    : null;
}

function configuredKey(value: string | undefined): Hex | null {
  return value && isHex(value) && value.length === 66 ? value : null;
}

function runTicketMessage(runId: Hex, issuedAt: number) {
  return `Proof of Patience run\n${runId}\n${issuedAt}`;
}

function rpcUrls(env: ChainEnv) {
  const primary = env.HEMI_RPC_URL || HEMI_RPC_URL;
  const fallbacks = (env.HEMI_RPC_FALLBACKS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return [primary, ...fallbacks];
}

function getPublicClient(env: ChainEnv, index = 0): PublicClient {
  const urls = rpcUrls(env);
  return createPublicClient({
    chain: hemiChain,
    transport: http(urls[Math.min(index, urls.length - 1)]),
  }) as PublicClient;
}

/**
 * Runs `work` against each configured RPC in turn.
 *
 * Hemi's public endpoint is documented at roughly 300 requests a minute and is
 * described as being for development. A single provider is a single point of
 * failure for the whole board, so a failure walks to the next one rather than
 * surfacing a 502.
 */
async function withRpcFallback<T>(env: ChainEnv, work: (client: PublicClient) => Promise<T>) {
  const urls = rpcUrls(env);
  let lastError: unknown;
  for (let index = 0; index < urls.length; index += 1) {
    try {
      return await work(getPublicClient(env, index));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/* ---------------------------------- limits ---------------------------------- */

async function withinRateLimit(request: Request, db: D1Database, route: string, limit: number) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  return consumeRateLimit(db, {
    bucketKey: `${route}:${ip}`,
    limit,
    nowMs: Date.now(),
  });
}

function turnstileConfigurationError(env: ChainEnv) {
  const hasSecret = Boolean(env.POP_TURNSTILE_SECRET?.trim());
  const hasSiteKey = Boolean(env.POP_TURNSTILE_SITE_KEY?.trim());
  return hasSecret === hasSiteKey
    ? null
    : "Turnstile requires both its secret and site key.";
}

/**
 * A same-origin heuristic, and only that.
 *
 * `Origin` is set by browsers and by nothing else, so a missing header means
 * "not a browser" rather than "same origin". It is still worth rejecting a
 * cross-origin browser request, but this must never be the only control on a
 * route — the rate limit and the Turnstile check are what stop a script.
 */
function crossOriginBrowserRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin !== new URL(request.url).origin;
}

async function passesTurnstile(request: Request, env: ChainEnv, token: unknown) {
  const secret = env.POP_TURNSTILE_SECRET?.trim();
  if (!secret) return true;
  if (typeof token !== "string" || token.length === 0) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) body.append("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const outcome = (await response.json()) as { success?: boolean };
  return outcome.success === true;
}

/* ---------------------------------- parsing --------------------------------- */

async function readJson(request: Request): Promise<unknown> {
  // `content-length` is absent on a chunked body, so it cannot be the only
  // check — read the body and measure what actually arrived.
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new RequestError("Request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RequestError("Request body is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("Request body must be valid JSON.");
  }
}

function parseInteger(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestError(`${name} is outside the accepted range.`);
  }
  return value;
}

function parseBytes32(value: unknown, name: string): Hex {
  if (!isHex(value) || value.length !== 66) throw new RequestError(`Invalid ${name}.`);
  return value;
}

function parseSubmission(value: unknown): ScoreSubmissionPayload {
  if (!value || typeof value !== "object") throw new RequestError("Missing score submission.");
  const input = value as Record<string, unknown>;
  if (!isHex(input.gameVersion) || input.gameVersion !== GAME_VERSION) {
    throw new RequestError("This run uses an unsupported game version.");
  }
  if (typeof input.player !== "string" || !isAddress(input.player)) {
    throw new RequestError("Invalid player wallet.");
  }

  const shots = parseInteger(input.shots, "Shots", 0, 10_000);
  return {
    runId: parseBytes32(input.runId, "run ID"),
    gameVersion: input.gameVersion,
    player: input.player,
    score: parseInteger(input.score, "Score", 0, 250_000_000),
    survivalSeconds: parseInteger(input.survivalSeconds, "Survival time", 0, 300),
    answered: parseInteger(input.answered, "Answered questions", 0, 1_000),
    shots,
    hits: parseInteger(input.hits, "Hits", 0, shots),
    seed: parseBytes32(input.seed, "run seed"),
    traceHash: parseBytes32(input.traceHash, "trace hash"),
    deadline: parseInteger(input.deadline, "Signature deadline", 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseRunProof(value: unknown) {
  if (!value || typeof value !== "object") throw new RequestError("This run has no server ticket.");
  const input = value as Record<string, unknown>;
  if (!isHex(input.ticket)) throw new RequestError("Invalid run ticket.");
  return {
    runId: parseBytes32(input.runId, "ticket run ID"),
    issuedAt: parseInteger(input.issuedAt, "Ticket time", 0, Number.MAX_SAFE_INTEGER),
    ticket: input.ticket,
  };
}

/* ------------------------------- chain config ------------------------------- */

interface OnchainConfig {
  verifier: Address;
  gameVersion: Hex;
  paused: boolean;
  weekId: bigint;
  fetchedAt: number;
}

let configCache: { key: string; value: OnchainConfig } | null = null;

/**
 * Cached for a minute. Without this, every game start spent two RPC calls
 * re-reading values that change perhaps once a week.
 */
async function readOnchainConfig(env: ChainEnv, contractAddress: Address): Promise<OnchainConfig> {
  const key = `${contractAddress}:${rpcUrls(env)[0]}`;
  const cached = configCache;
  if (cached && cached.key === key && Date.now() - cached.value.fetchedAt < CONFIG_CACHE_MS) {
    return cached.value;
  }

  const value = await withRpcFallback(env, async (client) => {
    const base = { address: contractAddress, abi: proofOfPatienceScoresAbi } as const;
    const [verifier, gameVersion, paused, weekId] = await Promise.all([
      client.readContract({ ...base, functionName: "verifier" }),
      client.readContract({ ...base, functionName: "activeGameVersion" }),
      client.readContract({ ...base, functionName: "paused" }),
      client.readContract({ ...base, functionName: "currentWeekId" }),
    ]);
    return { verifier, gameVersion, paused, weekId, fetchedAt: Date.now() };
  });

  configCache = { key, value };
  return value;
}

function assertVerifierMatches(config: OnchainConfig, verifierAddress: Address) {
  if (config.verifier.toLowerCase() !== verifierAddress.toLowerCase()) {
    throw new RequestError("The score verifier does not match the deployed contract.");
  }
  if (config.gameVersion !== GAME_VERSION) {
    throw new RequestError("The deployed contract expects a different game version.");
  }
}

/* -------------------------------- leaderboard ------------------------------- */

function toEntry(score: ScoreTuple): LeaderboardEntry {
  return {
    runId: score.runId,
    player: score.player,
    score: Number(score.score),
    survivalSeconds: Number(score.survivalSeconds),
    answered: Number(score.answered),
    submittedAt: Number(score.submittedAt),
  };
}

function rank(entries: LeaderboardEntry[]) {
  return entries
    .filter((entry) => entry.runId !== ZERO_RUN && entry.player !== ZERO_ADDRESS)
    .sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt)
    .slice(0, LEADERBOARD_LIMIT);
}

interface BoardSnapshot {
  deployBlock: string;
  cursor: string;
  allTime: Record<string, LeaderboardEntry>;
  weeks: Record<string, Record<string, LeaderboardEntry>>;
}

function emptySnapshot(cursor: bigint): BoardSnapshot {
  return {
    deployBlock: cursor.toString(),
    cursor: cursor.toString(),
    allTime: {},
    weeks: {},
  };
}

type MergedLog = { kind: "submit" | "voidAll" | "voidWeek"; log: Log };

/** Chain order: block, then transaction within the block, then log within the tx. */
function byChainOrder(a: MergedLog, b: MergedLog) {
  const ab = a.log.blockNumber ?? 0n;
  const bb = b.log.blockNumber ?? 0n;
  if (ab !== bb) return ab < bb ? -1 : 1;
  const at = a.log.transactionIndex ?? 0;
  const bt = b.log.transactionIndex ?? 0;
  if (at !== bt) return at - bt;
  return (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0);
}

/**
 * Builds both boards from `ScoreSubmitted` logs.
 *
 * This replaces scanning the contract's player arrays. The scan cost grew with
 * the number of players and was silently truncated past a fixed limit, so a
 * board with enough players stopped including new ones at all. Logs have no such
 * ceiling, and with a D1 snapshot each refresh only reads blocks since the last.
 *
 * Submissions and voids are merged and replayed in strict chain order. Applying
 * all submissions and then all voids (batched by type) would let a void that on
 * chain preceded a re-submission delete the newer, legitimate result. Every void
 * is also matched on `runId`, so a stale event from a reorg cannot remove an
 * entry it does not name.
 */
async function refreshFromLogs(
  env: ChainEnv,
  contractAddress: Address,
  previous: BoardSnapshot | null,
  deployBlock: bigint,
): Promise<{ snapshot: BoardSnapshot; complete: boolean }> {
  const snapshot: BoardSnapshot = previous && previous.deployBlock === deployBlock.toString()
    ? {
        deployBlock: previous.deployBlock,
        cursor: previous.cursor,
        allTime: { ...previous.allTime },
        weeks: { ...previous.weeks },
      }
    : emptySnapshot(deployBlock);

  return withRpcFallback(env, async (client) => {
    const head = await client.getBlockNumber();
    let from = BigInt(snapshot.cursor);
    if (from < deployBlock) from = deployBlock;

    let chunks = 0;
    let complete = true;
    while (from <= head) {
      if (chunks >= MAX_LOG_CHUNKS) {
        complete = false;
        break;
      }
      const to = from + LOG_CHUNK_BLOCKS > head ? head : from + LOG_CHUNK_BLOCKS;
      const [submitted, allVoided, weeklyVoided] = await Promise.all([
        client.getLogs({ address: contractAddress, event: SCORE_SUBMITTED_EVENT, fromBlock: from, toBlock: to }),
        client.getLogs({ address: contractAddress, event: ALL_TIME_VOIDED_EVENT, fromBlock: from, toBlock: to }),
        client.getLogs({ address: contractAddress, event: WEEKLY_VOIDED_EVENT, fromBlock: from, toBlock: to }),
      ]);

      const merged: MergedLog[] = [
        ...submitted.map((log) => ({ kind: "submit" as const, log })),
        ...allVoided.map((log) => ({ kind: "voidAll" as const, log })),
        ...weeklyVoided.map((log) => ({ kind: "voidWeek" as const, log })),
      ];
      merged.sort(byChainOrder);

      for (const { kind, log } of merged) {
        const args = (log as unknown as { args: Record<string, unknown> }).args;
        if (kind === "submit") {
          const result = args.result as ScoreTuple | undefined;
          const weekId = args.weekId as bigint | undefined;
          if (!result || weekId === undefined) continue;
          const entry = toEntry(result);
          const week = weekId.toString();

          const existing = snapshot.allTime[entry.player];
          if (!existing || entry.score > existing.score) snapshot.allTime[entry.player] = entry;

          const weekBoard = (snapshot.weeks[week] ??= {});
          const existingWeek = weekBoard[entry.player];
          if (!existingWeek || entry.score > existingWeek.score) weekBoard[entry.player] = entry;
        } else if (kind === "voidAll") {
          const player = args.player as Address | undefined;
          const runId = args.runId as Hex | undefined;
          // Only delete the entry the void actually names.
          if (player && snapshot.allTime[player]?.runId === runId) delete snapshot.allTime[player];
        } else {
          const player = args.player as Address | undefined;
          const weekId = args.weekId as bigint | undefined;
          const runId = args.runId as Hex | undefined;
          if (player && weekId !== undefined) {
            const week = snapshot.weeks[weekId.toString()];
            if (week && week[player]?.runId === runId) delete week[player];
          }
        }
      }

      snapshot.cursor = (to + 1n).toString();
      from = to + 1n;
      chunks += 1;
    }

    return { snapshot, complete };
  });
}

/** Fallback for a deployment with no durable storage or no configured deploy block. */
async function readBoardsByScan(
  env: ChainEnv,
  contractAddress: Address,
  weekId: bigint,
): Promise<{ weekly: LeaderboardEntry[]; allTime: LeaderboardEntry[]; complete: boolean }> {
  return withRpcFallback(env, async (client) => {
    const base = { address: contractAddress, abi: proofOfPatienceScoresAbi } as const;
    const [weeklyCount, allCount] = await Promise.all([
      client.readContract({ ...base, functionName: "weeklyPlayerCount", args: [weekId] }),
      client.readContract({ ...base, functionName: "allPlayerCount" }),
    ]);

    // Every page is a separate ~1,000,000-gas eth_call, so this is deliberately
    // bounded — but unlike the previous implementation, the truncation is
    // reported rather than silently producing a board that omits players.
    const maxScan = 2_000;
    const complete = Number(weeklyCount) <= maxScan && Number(allCount) <= maxScan;
    if (!complete) {
      console.warn(
        `Proof of Patience: leaderboard scan truncated at ${maxScan} (weekly=${weeklyCount}, all=${allCount}). ` +
          "Set POP_DEPLOY_BLOCK and bind DB to switch to log indexing.",
      );
    }

    async function readPages(count: number, week?: bigint) {
      const safe = Math.min(count, maxScan);
      const pages: LeaderboardEntry[] = [];
      for (let offset = 0; offset < safe; offset += 100) {
        const limit = Math.min(100, safe - offset);
        const page = (await (week === undefined
          ? client.readContract({
              ...base,
              functionName: "getAllTimeScores",
              args: [BigInt(offset), BigInt(limit)],
            })
          : client.readContract({
              ...base,
              functionName: "getWeeklyScores",
              args: [week, BigInt(offset), BigInt(limit)],
            }))) as readonly ScoreTuple[];
        pages.push(...page.map(toEntry));
      }
      return pages;
    }

    const [weekly, allTime] = await Promise.all([
      readPages(Number(weeklyCount), weekId),
      readPages(Number(allCount)),
    ]);
    return { weekly, allTime, complete };
  });
}

/* --------------------------------- handlers --------------------------------- */

async function handleConfig(env: ChainEnv) {
  const contractAddress = configuredAddress(env);
  const verifierKey = configuredKey(env.POP_VERIFIER_PRIVATE_KEY);
  const turnstileError = turnstileConfigurationError(env);
  const storageReady = env.DB !== undefined;

  let paused: boolean | undefined;
  if (contractAddress) {
    try {
      paused = (await readOnchainConfig(env, contractAddress)).paused;
    } catch {
      paused = undefined;
    }
  }

  return json(
    {
      enabled: contractAddress !== null,
      submissionEnabled:
        contractAddress !== null &&
        verifierKey !== null &&
        storageReady &&
        turnstileError === null &&
        paused !== true,
      reason: !contractAddress
        ? "The Hemi Mainnet score contract has not been configured yet."
        : paused === true
          ? "Score submissions are paused."
          : !verifierKey
            ? "Score submissions are paused while the verifier is configured."
            : !storageReady
              ? "Score submissions are paused while durable storage is configured."
              : turnstileError || undefined,
      chainId: HEMI_CHAIN_ID,
      chainName: hemiChain.name,
      rpcUrl: rpcUrls(env)[0],
      explorerUrl: HEMI_EXPLORER_URL,
      contractAddress: contractAddress || undefined,
      gameVersion: GAME_VERSION,
      paused,
      // Public key; only present when the complete Turnstile pair is configured.
      turnstileSiteKey:
        turnstileError === null
          ? env.POP_TURNSTILE_SITE_KEY?.trim() || undefined
          : undefined,
    },
    200,
    { "cache-control": "public, max-age=15" },
  );
}

async function handleRun(request: Request, env: ChainEnv) {
  if (crossOriginBrowserRequest(request)) {
    return json({ error: "Cross-origin requests are not accepted." }, 403);
  }
  const db = env.DB;
  if (!db) return json({ error: "Durable score storage is not configured." }, 503);
  const turnstileError = turnstileConfigurationError(env);
  if (turnstileError) return json({ error: turnstileError }, 503);
  if (!(await withinRateLimit(request, db, "run", 30))) {
    return json({ error: "Too many run tickets requested." }, 429);
  }

  const contractAddress = configuredAddress(env);
  const verifierKey = configuredKey(env.POP_VERIFIER_PRIVATE_KEY);
  if (!contractAddress || !verifierKey) {
    return json({ error: "Hemi score submissions are not enabled." }, 503);
  }

  const verifier = privateKeyToAccount(verifierKey);
  const config = await readOnchainConfig(env, contractAddress);
  assertVerifierMatches(config, verifier.address);
  if (config.paused) return json({ error: "Score submissions are paused." }, 503);

  const runId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = Math.floor(Date.now() / 1_000);
  const ticket = await verifier.signMessage({ message: runTicketMessage(runId, issuedAt) });

  await issueRunTicket(db, {
    runId,
    issuedAt,
    seed,
    expiresAt: issuedAt + RUN_TICKET_MAX_AGE,
  });

  return json({ runId, issuedAt, ticket, seed });
}

async function handleStatus(request: Request, env: ChainEnv) {
  const contractAddress = configuredAddress(env);
  const address = new URL(request.url).searchParams.get("address");
  if (!address || !isAddress(address)) throw new RequestError("A wallet address is required.");
  if (!contractAddress) return json({ address, nextEligibleAt: 0, blocked: false });

  const [nextEligibleAt, blocked] = await withRpcFallback(env, async (client) => {
    const base = { address: contractAddress, abi: proofOfPatienceScoresAbi } as const;
    return Promise.all([
      client.readContract({ ...base, functionName: "nextEligibleAt", args: [address] }),
      client.readContract({ ...base, functionName: "blockedPlayers", args: [address] }),
    ]);
  });

  return json(
    { address, nextEligibleAt: Number(nextEligibleAt), blocked },
    200,
    { "cache-control": "private, max-age=10" },
  );
}

async function handleLeaderboard(request: Request, env: ChainEnv, ctx: ExecutionContext) {
  const contractAddress = configuredAddress(env);
  if (!contractAddress) {
    return json({ enabled: false, weekly: [], allTime: [] } satisfies LeaderboardResponse);
  }

  // Cloudflare does not edge-cache a Worker-constructed response from its headers
  // alone, so the board is cached explicitly. This is what keeps a burst of page
  // loads from turning into a burst of RPC calls.
  const cacheKey = new Request(new URL("/api/chain/leaderboard", request.url).toString(), {
    method: "GET",
  });
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const config = await readOnchainConfig(env, contractAddress);
  const weekId = config.weekId;

  let weekly: LeaderboardEntry[];
  let allTime: LeaderboardEntry[];
  let complete = true;
  let source: "events" | "scan";

  // Log indexing needs D1 to persist the block cursor. Without it, every cache
  // miss would restart at the deploy block and could never catch up once the
  // chain is more than MAX_LOG_CHUNKS ahead. Fall back to the bounded scan.
  const canIndex = Boolean(env.POP_DEPLOY_BLOCK) && Boolean(env.DB);
  if (env.POP_DEPLOY_BLOCK && !env.DB) {
    console.warn(
      "Proof of Patience: POP_DEPLOY_BLOCK is set but DB is not bound. " +
        "Log indexing needs durable storage; falling back to the contract scan.",
    );
  }

  if (canIndex) {
    source = "events";
    const deployBlock = BigInt(env.POP_DEPLOY_BLOCK as string);
    const db = env.DB as D1Database;
    const stored = await readLeaderboardSnapshot(db, contractAddress);
    let previous: BoardSnapshot | null = null;
    if (stored) {
      try {
        previous = JSON.parse(stored.snapshotJson) as BoardSnapshot;
        // The separately stored integer is authoritative and cannot lose
        // precision at Hemi's practical block heights.
        previous.cursor = String(stored.cursor);
      } catch {
        console.warn("Proof of Patience: discarded an invalid leaderboard snapshot.");
      }
    }
    const { snapshot, complete: indexed } = await refreshFromLogs(
      env,
      contractAddress,
      previous,
      deployBlock,
    );
    complete = indexed;
    ctx.waitUntil(
      writeLeaderboardSnapshot(db, {
        contractAddress,
        cursor: Number(BigInt(snapshot.cursor)),
        snapshotJson: JSON.stringify(snapshot),
        updatedAt: Math.floor(Date.now() / 1_000),
      }),
    );
    allTime = Object.values(snapshot.allTime);
    weekly = Object.values(snapshot.weeks[weekId.toString()] ?? {});
  } else {
    source = "scan";
    const scanned = await readBoardsByScan(env, contractAddress, weekId);
    weekly = scanned.weekly;
    allTime = scanned.allTime;
    complete = scanned.complete;
  }

  const body: LeaderboardResponse = {
    enabled: true,
    source,
    weekId: Number(weekId),
    weekly: rank(weekly),
    allTime: rank(allTime),
    contractAddress,
    partial: complete ? undefined : true,
  };
  const response = json(body, 200, {
    "cache-control": `public, max-age=${BOARD_CACHE_SECONDS}, s-maxage=${BOARD_CACHE_SECONDS}`,
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleAttest(request: Request, env: ChainEnv) {
  if (crossOriginBrowserRequest(request)) {
    return json({ error: "Cross-origin requests are not accepted." }, 403);
  }
  const db = env.DB;
  if (!db) return json({ error: "Durable score storage is not configured." }, 503);
  const turnstileError = turnstileConfigurationError(env);
  if (turnstileError) return json({ error: turnstileError }, 503);
  if (!(await withinRateLimit(request, db, "attest", 10))) {
    return json({ error: "Too many attestations." }, 429);
  }

  const contractAddress = configuredAddress(env);
  const verifierKey = configuredKey(env.POP_VERIFIER_PRIVATE_KEY);
  if (!contractAddress || !verifierKey) {
    return json({ error: "Score attestations are not enabled." }, 503);
  }

  const body = (await readJson(request)) as {
    submission?: unknown;
    playerSignature?: unknown;
    runProof?: unknown;
    turnstileToken?: unknown;
  };
  if (!(await passesTurnstile(request, env, body.turnstileToken))) {
    return json({ error: "Could not confirm this request came from the game." }, 403);
  }

  const submission = parseSubmission(body.submission);
  const runProof = parseRunProof(body.runProof);
  const playerSignature = body.playerSignature;
  if (!isHex(playerSignature)) throw new RequestError("Invalid wallet signature.");
  if (runProof.runId !== submission.runId) throw new RequestError("The ticket does not match this run.");

  const now = Math.floor(Date.now() / 1_000);
  if (submission.deadline < now || submission.deadline > now + SIGNATURE_MAX_AGE) {
    throw new RequestError("The wallet signature has expired or lasts too long.");
  }
  if (runProof.issuedAt > now + CLOCK_TOLERANCE || now - runProof.issuedAt > RUN_TICKET_MAX_AGE) {
    throw new RequestError("The run ticket is outside its accepted time window.");
  }
  if (now - runProof.issuedAt + CLOCK_TOLERANCE < submission.survivalSeconds) {
    throw new RequestError("The claimed survival time is longer than the attested run.");
  }

  // The result must be reachable from the work it claims. This does not replay
  // the run — that is the V2 milestone — but it removes the case where a
  // caller simply names a number the game could never produce.
  const implausible = implausibleReason(submission);
  if (implausible) throw new RequestError(implausible);

  const validTicket = await verifyMessage({
    address: privateKeyToAccount(verifierKey).address,
    message: runTicketMessage(runProof.runId, runProof.issuedAt),
    signature: runProof.ticket,
  });
  if (!validTicket) throw new RequestError("The run ticket signature is invalid.");

  const issued = await readRunTicket(db, runProof.runId);
  if (!issued || issued.expiresAt < now) {
    throw new RequestError("This run ticket has expired or does not exist.");
  }
  if (issued.issuedAt !== runProof.issuedAt || issued.seed !== submission.seed) {
    throw new RequestError("This run does not match the server-issued ticket.");
  }

  const verifier = privateKeyToAccount(verifierKey);
  const config = await readOnchainConfig(env, contractAddress);
  assertVerifierMatches(config, verifier.address);
  if (config.paused) return json({ error: "Score submissions are paused." }, 503);

  const [eligibleAt, blocked] = await withRpcFallback(env, async (client) => {
    const base = { address: contractAddress, abi: proofOfPatienceScoresAbi } as const;
    return Promise.all([
      client.readContract({ ...base, functionName: "nextEligibleAt", args: [submission.player] }),
      client.readContract({ ...base, functionName: "blockedPlayers", args: [submission.player] }),
    ]);
  });
  if (blocked) return json({ error: "This wallet cannot record scores." }, 403);
  if (eligibleAt > BigInt(now)) {
    return json(
      { error: "This wallet is still in its 24-hour cooldown.", nextEligibleAt: Number(eligibleAt) },
      409,
    );
  }

  const typedData = scoreTypedData(submission, contractAddress);
  const payloadHash = hashTypedData(typedData);
  if (issued.payloadHash && issued.payloadHash !== payloadHash) {
    throw new RequestError("This run ticket already attested a different score.");
  }
  const validPlayer = await verifyTypedData({
    ...typedData,
    address: submission.player,
    signature: playerSignature,
  });
  if (!validPlayer) throw new RequestError("The wallet signature does not match this score.");

  // A retry after a lost response receives the exact signature issued before.
  if (issued.verifierSignature) {
    if (!isHex(issued.verifierSignature)) {
      throw new Error("Stored verifier signature is invalid.");
    }
    return json({ verifierSignature: issued.verifierSignature });
  }

  // The verifier signs the attestation envelope, not the player's payload. The
  // two used the same digest, which meant one signature satisfied both of the
  // contract's checks whenever the player happened to be the verifier.
  const verifierSignature = await verifier.signTypedData(
    attestationTypedData(submission, contractAddress),
  );
  const stored = await storeAttestation(db, {
    runId: runProof.runId,
    payloadHash,
    verifierSignature,
    attestedAt: now,
  });
  if (stored.status === "missing") {
    throw new RequestError("This run ticket expired before it could be attested.");
  }
  if (stored.status === "conflict" || !isHex(stored.verifierSignature)) {
    throw new RequestError("This run ticket already attested a different score.");
  }
  return json({ verifierSignature: stored.verifierSignature });
}

export async function handleChainRequest(
  request: Request,
  env: ChainEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/chain/")) return null;

  try {
    if (path === "/api/chain/config" && request.method === "GET") return await handleConfig(env);
    if (path === "/api/chain/run" && request.method === "POST") return await handleRun(request, env);
    if (path === "/api/chain/status" && request.method === "GET") return await handleStatus(request, env);
    if (path === "/api/chain/leaderboard" && request.method === "GET") {
      return await handleLeaderboard(request, env, ctx);
    }
    if (path === "/api/chain/attest" && request.method === "POST") return await handleAttest(request, env);
    return json({ error: "Method not allowed." }, 405, { allow: "GET, POST" });
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, 400);
    console.error("Proof of Patience chain API error", error);
    return json({ error: "The Hemi service could not complete this request. Try again shortly." }, 502);
  }
}
