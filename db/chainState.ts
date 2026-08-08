export type D1Value = string | number | null | ArrayBuffer | ArrayBufferView;

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<Array<D1Result<T>>>;
}

interface RunTicketRow {
  run_id: string;
  issued_at: number;
  seed: string;
  expires_at: number;
  payload_hash: string | null;
  verifier_signature: string | null;
  attested_at: number | null;
}

export interface RunTicketRecord {
  runId: string;
  issuedAt: number;
  seed: string;
  expiresAt: number;
  payloadHash: string | null;
  verifierSignature: string | null;
  attestedAt: number | null;
}

function toRunTicket(row: RunTicketRow): RunTicketRecord {
  return {
    runId: row.run_id,
    issuedAt: Number(row.issued_at),
    seed: row.seed,
    expiresAt: Number(row.expires_at),
    payloadHash: row.payload_hash,
    verifierSignature: row.verifier_signature,
    attestedAt: row.attested_at === null ? null : Number(row.attested_at),
  };
}

export async function issueRunTicket(
  db: D1Database,
  input: { runId: string; issuedAt: number; seed: string; expiresAt: number },
) {
  await db.batch([
    db.prepare("DELETE FROM pop_run_tickets WHERE expires_at < ?").bind(input.issuedAt),
    db.prepare("DELETE FROM pop_rate_limits WHERE expires_at < ?").bind(input.issuedAt),
    db
      .prepare(
        `INSERT INTO pop_run_tickets
          (run_id, issued_at, seed, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(input.runId, input.issuedAt, input.seed, input.expiresAt),
  ]);
}

export async function readRunTicket(db: D1Database, runId: string) {
  const row = await db
    .prepare(
      `SELECT run_id, issued_at, seed, expires_at,
              payload_hash, verifier_signature, attested_at
         FROM pop_run_tickets
        WHERE run_id = ?`,
    )
    .bind(runId)
    .first<RunTicketRow>();
  return row ? toRunTicket(row) : null;
}

export type StoreAttestationResult =
  | { status: "stored"; verifierSignature: string }
  | { status: "conflict" }
  | { status: "missing" };

/**
 * Store exactly one attestation per run ID and return the winning signature.
 *
 * The conditional update is the serialization point. Concurrent requests for
 * the same payload both receive the stored signature; a different payload
 * loses and receives `conflict`.
 */
export async function storeAttestation(
  db: D1Database,
  input: {
    runId: string;
    payloadHash: string;
    verifierSignature: string;
    attestedAt: number;
  },
): Promise<StoreAttestationResult> {
  await db
    .prepare(
      `UPDATE pop_run_tickets
          SET payload_hash = ?, verifier_signature = ?, attested_at = ?
        WHERE run_id = ?
          AND expires_at >= ?
          AND verifier_signature IS NULL`,
    )
    .bind(
      input.payloadHash,
      input.verifierSignature,
      input.attestedAt,
      input.runId,
      input.attestedAt,
    )
    .run();

  const stored = await readRunTicket(db, input.runId);
  if (!stored || stored.expiresAt < input.attestedAt || !stored.verifierSignature) {
    return { status: "missing" };
  }
  if (stored.payloadHash !== input.payloadHash) return { status: "conflict" };
  return { status: "stored", verifierSignature: stored.verifierSignature };
}

/** Atomic fixed-window limiter shared by every Worker isolate and location. */
export async function consumeRateLimit(
  db: D1Database,
  input: { bucketKey: string; limit: number; nowMs: number },
) {
  const now = Math.floor(input.nowMs / 1_000);
  const windowStart = Math.floor(now / 60) * 60;
  const expiresAt = windowStart + 120;
  const row = await db
    .prepare(
      `INSERT INTO pop_rate_limits (bucket_key, window_start, count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key, window_start) DO UPDATE SET
         count = pop_rate_limits.count + 1,
         expires_at = excluded.expires_at
       WHERE pop_rate_limits.count < ?
       RETURNING count`,
    )
    .bind(input.bucketKey, windowStart, expiresAt, input.limit)
    .first<{ count: number }>();
  return row !== null;
}

interface SnapshotRow {
  cursor: number;
  snapshot_json: string;
}

export async function readLeaderboardSnapshot(db: D1Database, contractAddress: string) {
  const row = await db
    .prepare(
      `SELECT cursor, snapshot_json
         FROM pop_leaderboard_snapshots
        WHERE contract_address = ?`,
    )
    .bind(contractAddress.toLowerCase())
    .first<SnapshotRow>();
  return row
    ? { cursor: Number(row.cursor), snapshotJson: row.snapshot_json }
    : null;
}

/** A stale concurrent refresh may repeat work, but it cannot move the cursor backwards. */
export async function writeLeaderboardSnapshot(
  db: D1Database,
  input: {
    contractAddress: string;
    cursor: number;
    snapshotJson: string;
    updatedAt: number;
  },
) {
  await db
    .prepare(
      `INSERT INTO pop_leaderboard_snapshots
        (contract_address, cursor, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(contract_address) DO UPDATE SET
         cursor = excluded.cursor,
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at
       WHERE excluded.cursor >= pop_leaderboard_snapshots.cursor`,
    )
    .bind(
      input.contractAddress.toLowerCase(),
      input.cursor,
      input.snapshotJson,
      input.updatedAt,
    )
    .run();
}
