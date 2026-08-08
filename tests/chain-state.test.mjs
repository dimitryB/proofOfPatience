import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Miniflare } from "miniflare";

import {
  consumeRateLimit,
  issueRunTicket,
  readLeaderboardSnapshot,
  readRunTicket,
  storeAttestation,
  writeLeaderboardSnapshot,
} from "../db/chainState.ts";

async function testDatabase() {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = await miniflare.getD1Database("DB");
  const migration = await readFile(new URL("../drizzle/0000_pop_chain_state.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.prepare(statement).run();
  }
  return { db, miniflare };
}

test("run tickets retain one idempotent attestation", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, {
    runId: "run-1",
    issuedAt: 1_000,
    seed: "seed-1",
    expiresAt: 2_000,
  });
  assert.equal((await readRunTicket(db, "run-1"))?.seed, "seed-1");

  const first = await storeAttestation(db, {
    runId: "run-1",
    payloadHash: "0xaaa",
    verifierSignature: "0xsignature-one",
    attestedAt: 1_500,
  });
  const retry = await storeAttestation(db, {
    runId: "run-1",
    payloadHash: "0xaaa",
    verifierSignature: "0xsignature-two",
    attestedAt: 1_501,
  });

  assert.deepEqual(first, { status: "stored", verifierSignature: "0xsignature-one" });
  assert.deepEqual(retry, { status: "stored", verifierSignature: "0xsignature-one" });
});

test("a run ticket cannot attest a different payload", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, {
    runId: "run-2",
    issuedAt: 1_000,
    seed: "seed-2",
    expiresAt: 2_000,
  });
  await storeAttestation(db, {
    runId: "run-2",
    payloadHash: "0xaaa",
    verifierSignature: "0xsignature-one",
    attestedAt: 1_500,
  });

  assert.deepEqual(
    await storeAttestation(db, {
      runId: "run-2",
      payloadHash: "0xbbb",
      verifierSignature: "0xsignature-two",
      attestedAt: 1_501,
    }),
    { status: "conflict" },
  );
});

test("rate limits are shared fixed-window counters", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 10_000 }), true);
  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 11_000 }), true);
  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 12_000 }), false);
  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 61_000 }), true);
});

test("leaderboard snapshots never move their cursor backwards", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await writeLeaderboardSnapshot(db, {
    contractAddress: "0xABC",
    cursor: 20,
    snapshotJson: '{"version":2}',
    updatedAt: 2,
  });
  await writeLeaderboardSnapshot(db, {
    contractAddress: "0xabc",
    cursor: 10,
    snapshotJson: '{"version":1}',
    updatedAt: 3,
  });

  assert.deepEqual(await readLeaderboardSnapshot(db, "0xAbC"), {
    cursor: 20,
    snapshotJson: '{"version":2}',
  });
});
