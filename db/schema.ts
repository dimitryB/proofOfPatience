import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Server-issued run tickets and their optional verifier attestation.
 *
 * Keeping the attestation on the ticket makes `/api/chain/attest` idempotent:
 * a lost HTTP response can return the exact signature that was already issued,
 * while a different payload cannot reuse the same run ID.
 */
export const popRunTickets = sqliteTable(
  "pop_run_tickets",
  {
    runId: text("run_id").primaryKey(),
    issuedAt: integer("issued_at").notNull(),
    seed: text("seed").notNull(),
    expiresAt: integer("expires_at").notNull(),
    payloadHash: text("payload_hash"),
    verifierSignature: text("verifier_signature"),
    attestedAt: integer("attested_at"),
  },
  (table) => [index("idx_pop_run_tickets_expires_at").on(table.expiresAt)],
);

/** One fixed-window counter per route/IP/minute. */
export const popRateLimits = sqliteTable(
  "pop_rate_limits",
  {
    bucketKey: text("bucket_key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_pop_rate_limits_bucket_window",
      columns: [table.bucketKey, table.windowStart],
    }),
    index("idx_pop_rate_limits_expires_at").on(table.expiresAt),
  ],
);

/** Durable cursor plus JSON snapshot for the event-indexed leaderboard. */
export const popLeaderboardSnapshots = sqliteTable("pop_leaderboard_snapshots", {
  contractAddress: text("contract_address").primaryKey(),
  cursor: integer("cursor").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
