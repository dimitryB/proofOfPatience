import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as pop from "../lib/pop.ts";
import {
  LETTERS,
  MAX_ACTIVE_QUESTIONS,
  MAX_BACKLOG,
  OPENING_SECONDS,
  QUESTION_SPECS,
  ROUND_SECONDS,
  difficultyAt,
  expectedLetter,
  formatRoundTime,
  nextAmmoIndex,
  patienceTier,
  shouldBurnBacklog,
} from "../lib/pop.ts";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html", host: "localhost" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the POP community takeover", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Proof of Patience™ \(POP\) — MWM Community Takeover<\/title>/i);
  assert.match(html, /PROOF OF PATIENCE/);
  assert.match(html, /MIDWEEK WITH MAX/);
  assert.match(html, /COMMUNITY TAKEOVER/);
  assert.match(html, /HEMI MAINNET/);
  assert.match(html, /CONNECT WALLET/);
  assert.match(html, /id="leaderboards"/);
  assert.match(html, /GO LIVE/);
  assert.match(html, /10(?:<!-- -->)?-DEEP QUESTION BACKLOG/);
  assert.match(html, /WEN POP V2/);
  assert.doesNotMatch(html, /V2\.1|PRINCE OF SOON|wallet connection/i);
  assert.doesNotMatch(html, /LOCAL BUILD/);
});

test("keeps the confirmed ten-question catalog without overlaps", () => {
  assert.equal(QUESTION_SPECS.length, 10);
  const labels = QUESTION_SPECS.map((question) => question.label);
  assert.deepEqual(labels, [
    "WEN OG?",
    "WEN VBK?",
    "WEN ACTUAL DATE?",
    "WEN POP V2?",
    "WEN veHEMI REWARDS?",
    "zkPROOF WHITEPAPER?",
    "WEN POP CLAIM?",
    "PLOUTOS HACK?",
    "op-reth DONE?",
    "WHERE IS JUSTIN?",
  ]);
  assert.equal(labels.some((label) => /V2\.1/i.test(label)), false);
  assert.equal(labels.some((label) => /POP PAYOUTS|veHEMI PAYOUTS/i.test(label)), false);
});

test("preserves SOON sequencing and patience rewards", () => {
  assert.deepEqual(LETTERS, ["S", "O", "O", "N"]);
  assert.equal(expectedLetter(0), "S");
  assert.equal(expectedLetter(3), "N");
  assert.equal(expectedLetter(4), "S");
  assert.equal(nextAmmoIndex(3), 0);
  assert.equal(patienceTier(0), "PATIENT");
  assert.equal(patienceTier(3), "STILL LISTENING");
  assert.equal(patienceTier(9), "ZEN MODE");
  assert.equal(shouldBurnBacklog(3, 2), true);
  assert.equal(shouldBurnBacklog(3, 0), false);
});

test("supports a moderate five-minute survival curve", () => {
  assert.equal(ROUND_SECONDS, 300);
  assert.equal(MAX_BACKLOG, 10);
  assert.equal(MAX_ACTIVE_QUESTIONS, 8);
  assert.equal(formatRoundTime(300), "5:00");

  // `RESET_WINDOW_SECONDS` and `canResetRoadmap` used to be asserted here. The
  // Producer Override they described is gone: it made a full backlog harmless
  // until 4:00, so for four of the five minutes the round could not be lost at
  // all. A headless playtest over hundreds of seeded rounds put numbers on it —
  // with the override switched off, survival did not move (100 % for every
  // skill tier, because the backlog never left zero in the first place), so it
  // was protecting nothing and only removing the stakes. Losing is now possible
  // from the opening whistle, which is what makes the backlog meter mean
  // something the whole way through.

  // The removal is the product decision, so guard it directly: an immunity
  // window must not come back by accident under either of its old names.
  assert.equal("canResetRoadmap" in pop, false);
  assert.equal("RESET_WINDOW_SECONDS" in pop, false);

  const opening = difficultyAt(0);
  const middle = difficultyAt(150);
  const finale = difficultyAt(300);

  // The guided opening is the one part of the curve that must not get harder:
  // a single caller, alone on the board, for the first OPENING_SECONDS.
  assert.equal(opening.maxActive, 1);
  assert.equal(difficultyAt(OPENING_SECONDS - 0.1).maxActive, 1);
  assert.ok(difficultyAt(OPENING_SECONDS).maxActive > 1);

  assert.equal(finale.maxActive, MAX_ACTIVE_QUESTIONS);
  assert.ok(opening.maxActive <= middle.maxActive);
  assert.ok(middle.maxActive <= finale.maxActive);
  assert.ok(opening.speedScale < middle.speedScale);
  assert.ok(middle.speedScale < finale.speedScale);
  assert.ok(opening.spawnDelay > finale.spawnDelay);

  // `finale.speedScale <= 1` used to stand here, on the reasoning that a
  // moderate player needs "enough seconds per card to react". That bound is
  // what made the round unloseable, and it was measuring the wrong quantity.
  // What decides survivability is fall time against the time it takes to clear
  // a full board: a saturated board is served at roughly 1.15 callers/second,
  // so a full board of `maxActive` drains in maxActive / 1.15 seconds, and
  // while a caller's fall takes longer than that, NOTHING can ever reach the
  // floor at any arrival rate. The old finale gave a caller 16.6 s to fall
  // against a 7 s board clear — a 2.4x margin, hence 100 % survival.
  // So the real guardrail is asserted directly instead.
  const fallSeconds = (profile) => 402 / (37 * profile.speedScale);
  const clearSeconds = (profile) => profile.maxActive / 1.15;
  // The opening must stay generous: a lone caller falls for the best part of
  // half a minute, which is the "gentle guided caller" the README promises.
  assert.ok(fallSeconds(opening) > 20, `opening fall ${fallSeconds(opening)}`);
  // ...and the finale must be genuinely dangerous: comparable to board clear.
  assert.ok(fallSeconds(finale) < clearSeconds(finale) * 1.1, `finale fall ${fallSeconds(finale)}`);
  // But never so fast that a caller cannot be answered at all. A moderate
  // player needs a few seconds of sight on a caller even at the death.
  assert.ok(fallSeconds(finale) > 4, `finale fall ${fallSeconds(finale)}`);
});

test("keeps project-specific social metadata", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /Proof of Patience/);
  assert.match(layout, /og\.png/);
  assert.match(layout, /#ff4600/i);
});

test("keeps backlog graphics and copy bound to the gameplay limit", async () => {
  const [overlays, howTo] = await Promise.all([
    readFile(new URL("../app/components/StageOverlays.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/HowToModal.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(overlays, /QUEUE REACHED \$\{MAX_BACKLOG\}/);
  assert.match(howTo, /Array\.from\(\{ length: MAX_BACKLOG \}\)/);
  assert.doesNotMatch(`${overlays}\n${howTo}`, /queue reached eight|eight full slots/i);
});

test("links a confirmed score directly to the leaderboards", async () => {
  const scoreControl = await readFile(
    new URL("../app/components/OnchainScore.tsx", import.meta.url),
    "utf8",
  );
  assert.match(scoreControl, /VIEW LEADERBOARD/);
  assert.match(scoreControl, /href="#leaderboards"/);
  assert.match(scoreControl, /View transaction/);
});
