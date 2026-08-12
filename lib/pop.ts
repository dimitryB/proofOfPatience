export const GAME_WIDTH = 1000;
export const GAME_HEIGHT = 620;
export const STAGE_Y = 548;
export const ROUND_SECONDS = 300;
export const REVIEW_INTERVAL_SECONDS = 60;
/** Questions that may reach the producer queue before the show goes off air. */
export const MAX_BACKLOG = 10;
/** Live callers stay capped separately so backlog capacity does not retune play. */
export const MAX_ACTIVE_QUESTIONS = 8;
/**
 * The guided opening: one slow caller, on its own, with the whole desk to
 * itself. This is the *only* place the difficulty curve is shaped by a
 * hard boundary rather than by `progress`, and it exists so a first-time
 * player has a full half-minute to learn that S·O·O·N is a sequence.
 *
 * There is deliberately no counterpart at the other end of the round. The
 * show used to be unloseable until 4:00 (`RESET_WINDOW_SECONDS`, removed):
 * a full backlog before then simply halved itself and play continued. That
 * made the first four minutes a formality and turned 4:00 into a cliff —
 * every loss in a measured run landed in the last sixty seconds, because
 * that was the first second a loss was permitted. Difficulty now ramps
 * continuously and the backlog is live from the first second.
 */
export const OPENING_SECONDS = 30;
export const DEBT_BURN_INTERVAL = 3;
export const LETTERS = ["S", "O", "O", "N"] as const;

/** Host desk anchor. Shared by the simulation, the aim maths and the renderer. */
export const DESK_X = GAME_WIDTH / 2;
export const DESK_Y = STAGE_Y + 22;

/**
 * Answer-letter muzzle velocity in logical pixels per second.
 *
 * Raised from 1 060: a six-caller board needs the host to be able to work it,
 * and a letter that takes half a second to arrive reads as a lob rather than an
 * answer. At this speed a shot crosses the whole field in ~0.27 s, which is
 * still four frames of ribbon trail at 60 Hz.
 */
export const SHOT_SPEED = 2_300;
/** Seconds between shots. One letter in flight at a time keeps SOON in order. */
export const FIRE_COOLDOWN = 0.06;
/** Card half-height used for hit tests and the floor contact line. */
export const CARD_HALF_HEIGHT = 31;
/** Fixed simulation step. The renderer's shot prediction steps at this rate too. */
export const SIM_STEP = 1 / 60;
/** Distance from the desk anchor at which a letter leaves the microphone. */
export const MUZZLE_OFFSET = 70;
/**
 * Half-angle of the aim-assist cone, radians.
 *
 * At the old 0.52 (~30°) the assist did essentially all of the aiming: with the
 * answer button held, a stale aim pointed anywhere near the board would snap
 * onto some answerable caller, so a 750 ms player and a 250 ms player cleared a
 * saturated board at the same rate — 1.15 callers/s each, measured. A game
 * cannot be hard for a careless player and fair for a careful one if the two
 * have identical throughput, which is why tightening this is what actually
 * separated the skill tiers in the playtest sweep.
 *
 * 0.22 rad (~13°) still covers ±90 px at the far end of the stage, so touch and
 * keyboard both stay comfortably viable — the keyboard policy, aiming at the
 * 3.2 rad/s the arrow keys allow, still survives about seven rounds in ten.
 */
export const AIM_ASSIST_CONE = 0.22;

/* ------------------------------------------------------------------ *
 * The gallery band and the card entrance
 * ------------------------------------------------------------------ */

/**
 * Height of the **gallery band** — the strip across the top of the frame that
 * belongs to broadcast graphics and that no caller card may ever enter.
 *
 * This is the second half of a spatial contract the frame already had at its
 * other end: `STAGE_Y` is the line below which a caller cannot go, and this is
 * the line above which it cannot go. `lib/render/overlay.ts` lays the countdown
 * clock and the announcement strap inside it, and because the simulation
 * guarantees no card is ever up here, that furniture can be an opaque, legible
 * broadcast object without ever printing over a caller. The desk lives below
 * `STAGE_Y`, so it is out of reach at the other end for the same reason.
 *
 * 78 px = the 4 % vertical safe margin (25) plus the clock plate (52), rounded
 * up by one so the strap can share the clock's baseline.
 */
export const GALLERY_BAND_H = 78;

/**
 * Spawn line: the card's **top bevel** sits five pixels below the gallery band,
 * so a caller is wholly inside the play field on the very first frame it is
 * drawn and there is no frame — not one — in which the top edge of the picture
 * slices a card in half.
 *
 * The old spawn was y = −46 with a 31 px half-height, so a card was cut by the
 * top edge for the whole 2.7 s it took to descend its own height at ~23 px/s;
 * with a spawn every three to four seconds, "a caller guillotined by the top
 * edge" was the frame's permanent state, and every capture caught it. Sliding
 * a card in from off-screen cannot be made to read as deliberate at these fall
 * speeds — the entrance *is* the fall — so the card is keyed in instead, on the
 * entry choreography `question.ts` already animates from `age`: alpha in over
 * 90 ms, an unfolding panel, glass, then the question typing on.
 */
export const SPAWN_Y = GALLERY_BAND_H + CARD_HALF_HEIGHT + 5;

/** A caller below this line is clear of the spawn zone. */
export const SPAWN_CLEAR_Y = SPAWN_Y + CARD_HALF_HEIGHT * 2;

export type SoonLetter = (typeof LETTERS)[number];
export type QuestionKind =
  | "og"
  | "vbk"
  | "date"
  | "popv2"
  | "vehemi"
  | "zkproof"
  | "claim"
  | "ploutos"
  | "reth"
  | "roadmap";

export interface QuestionSpec {
  kind: QuestionKind;
  label: string;
  shortLabel: string;
  speed: number;
  words: number;
  value: number;
  width: number;
  /**
   * Idle tint. Every entry carries `CARD_TINT`: colour is a state channel here,
   * not an identity one. See the note on `CARD_TINT`.
   */
  color: string;
  /** Identity signature: how this caller moves is what tells it apart. */
  motion: "straight" | "sway" | "zigzag";
}

export interface DifficultyProfile {
  label: "OPENING CHAT" | "AUDIENCE Q&A" | "HOT SEAT" | "FINAL QUESTION";
  speedScale: number;
  spawnDelay: number;
  maxActive: number;
  hitPadding: number;
}

/**
 * The one idle tint every caller card wears — warm bone, the neutral end of the
 * art direction's palette.
 *
 * Colour on this board is a **state** channel, not an identity channel. It used
 * to be both: the ten kinds carried ten different tints spanning bone, salmon,
 * pure white and hemi orange itself, which spent the only axis the game has for
 * "this caller is answerable" (hemi) and "this caller is about to land"
 * (hemi pushed hot) on telling apart questions the player already tells apart
 * by reading them. A card at #ff4600 idle and a card locked on were the same
 * colour; a card at #ffffff outshone every genuine highlight in the set.
 *
 * Identity is carried by the things that actually differ: the question text
 * baked into the card, its width, its word count, and its motion signature —
 * straight, sway or zigzag — which is readable at a glance from across the
 * field. Every catalogue entry and every label is unchanged.
 */
export const CARD_TINT = "#efe7e0";

export const QUESTION_SPECS: QuestionSpec[] = [
  {
    kind: "og",
    label: "WEN OG?",
    shortLabel: "OG",
    speed: 38,
    words: 1,
    value: 120,
    width: 152,
    color: CARD_TINT,
    motion: "straight",
  },
  {
    kind: "vbk",
    label: "WEN VBK?",
    shortLabel: "VBK",
    speed: 34,
    words: 1,
    value: 150,
    width: 160,
    color: CARD_TINT,
    motion: "sway",
  },
  {
    kind: "date",
    label: "WEN ACTUAL DATE?",
    shortLabel: "DATE",
    speed: 42,
    words: 1,
    value: 180,
    width: 214,
    color: CARD_TINT,
    motion: "zigzag",
  },
  {
    kind: "popv2",
    label: "WEN POP V2?",
    shortLabel: "POP V2",
    speed: 32,
    words: 2,
    value: 300,
    width: 184,
    color: CARD_TINT,
    motion: "sway",
  },
  {
    kind: "vehemi",
    label: "WEN veHEMI REWARDS?",
    shortLabel: "veHEMI",
    speed: 35,
    words: 1,
    value: 190,
    width: 242,
    color: CARD_TINT,
    motion: "straight",
  },
  {
    kind: "zkproof",
    label: "zkPROOF WHITEPAPER?",
    shortLabel: "zkPROOF",
    speed: 30,
    words: 2,
    value: 340,
    width: 236,
    color: CARD_TINT,
    motion: "zigzag",
  },
  {
    kind: "claim",
    label: "WEN POP CLAIM?",
    shortLabel: "CLAIM",
    speed: 39,
    words: 1,
    value: 210,
    width: 198,
    color: CARD_TINT,
    motion: "sway",
  },
  {
    kind: "ploutos",
    label: "PLOUTOS HACK?",
    shortLabel: "PLOUTOS",
    speed: 43,
    words: 1,
    value: 225,
    width: 190,
    color: CARD_TINT,
    motion: "zigzag",
  },
  {
    kind: "reth",
    label: "op-reth DONE?",
    shortLabel: "op-reth",
    speed: 31,
    words: 2,
    value: 320,
    width: 184,
    color: CARD_TINT,
    motion: "straight",
  },
  {
    kind: "roadmap",
    label: "WEN ROADMAP?",
    shortLabel: "ROADMAP",
    speed: 45,
    words: 1,
    value: 250,
    width: 214,
    color: CARD_TINT,
    motion: "zigzag",
  },
];

export function expectedLetter(progress: number): SoonLetter {
  return LETTERS[progress % LETTERS.length];
}

export function nextAmmoIndex(index: number) {
  return (index + 1) % LETTERS.length;
}

export function completedWords(progress: number) {
  return Math.floor(progress / LETTERS.length);
}

export function wordProgress(progress: number) {
  return progress % LETTERS.length;
}

/* ------------------------------------------------------------------ *
 * Targeting — ONE rule, shared by the projectile and the reticle
 * ------------------------------------------------------------------ */

/**
 * The minimum a caller has to expose for the aim maths to work on it. Both the
 * simulation (`app/page.tsx`) and the lock reticle (`lib/render/scene.ts`) feed
 * their own card objects straight in; neither owns a second copy of the rule.
 */
export interface AimCard {
  id: number;
  x: number;
  y: number;
  width: number;
  progress: number;
  total: number;
}

/** True when this caller is waiting for exactly the letter currently loaded. */
export function answersTo(card: AimCard, letter: string): boolean {
  return card.progress < card.total && expectedLetter(card.progress) === letter;
}

/** Shortest signed difference between two angles, in (−π, π]. */
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/**
 * Aim assist. The angle the host *actually* fires at, which is the raw aim
 * snapped onto the nearest caller waiting for the loaded letter, inside
 * `AIM_ASSIST_CONE`. Firing without going through this is what let the barrel
 * and the letter disagree.
 */
export function assistedAimAngle(
  aim: number,
  letter: string,
  cards: readonly AimCard[],
): number {
  let resolved = aim;
  let smallest = AIM_ASSIST_CONE;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!answersTo(card, letter)) continue;
    const angle = Math.atan2(card.y - DESK_Y, card.x - DESK_X);
    const difference = Math.abs(angleDelta(aim, angle));
    if (difference < smallest) {
      smallest = difference;
      resolved = angle;
    }
  }
  return resolved;
}

/** Half-extents of a caller's strike box at the current difficulty padding. */
export function strikeHalfWidth(card: AimCard, hitPadding: number): number {
  return card.width / 2 + hitPadding;
}
export function strikeHalfHeight(hitPadding: number): number {
  return CARD_HALF_HEIGHT + 3 + hitPadding * 0.35;
}

/** Does a point sit inside a caller's strike box? The projectile's own test. */
export function insideStrikeBox(card: AimCard, x: number, y: number, hitPadding: number): boolean {
  return (
    Math.abs(x - card.x) <= strikeHalfWidth(card, hitPadding) &&
    Math.abs(y - card.y) <= strikeHalfHeight(hitPadding)
  );
}

/** Longest a traced letter can stay on the field: the frame diagonal, stepped. */
const MAX_TRACE_STEPS = Math.ceil(
  Math.hypot(GAME_WIDTH + 80, GAME_HEIGHT + 80) / (SHOT_SPEED * SIM_STEP) + 2,
);

/**
 * Which caller a letter fired along `angle` strikes first — the *projectile's*
 * answer, not a cone test.
 *
 * This walks the same fixed step the simulation walks, spawns at the same
 * muzzle offset, tests the same strike boxes in the same array order and takes
 * the same first hit, so the lock reticle and the letter can never disagree
 * about which card is about to be answered. It also means an unrelated caller
 * parked in front of the one you are aiming at is reported as the card you will
 * actually hit, which is exactly what the player needs to know.
 *
 * The board is treated as frozen for the flight (≈0.13–0.22 s): the prediction
 * answers "if I fire now", which is the question the reticle is asking.
 *
 * Returns the struck card's id, or −1 when the letter leaves the field clean.
 */
export function traceShot(
  angle: number,
  cards: readonly AimCard[],
  hitPadding: number,
): number {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let x = DESK_X + cos * MUZZLE_OFFSET;
  let y = DESK_Y + sin * MUZZLE_OFFSET;
  const dx = cos * SHOT_SPEED * SIM_STEP;
  const dy = sin * SHOT_SPEED * SIM_STEP;

  for (let step = 0; step < MAX_TRACE_STEPS; step += 1) {
    x += dx;
    y += dy;
    for (let i = 0; i < cards.length; i += 1) {
      if (insideStrikeBox(cards[i], x, y, hitPadding)) return cards[i].id;
    }
    if (x <= -40 || x >= GAME_WIDTH + 40 || y <= -50 || y >= GAME_HEIGHT + 30) break;
  }
  return -1;
}

/**
 * The caller the lock reticle must mark: what a letter fired *right now* would
 * hit, aim assist included. `-1` when the shot would sail past everything.
 */
export function predictedTarget(
  aim: number,
  letter: string,
  cards: readonly AimCard[],
  hitPadding: number,
): number {
  return traceShot(assistedAimAngle(aim, letter, cards), cards, hitPadding);
}

/**
 * Callers per second the show books, at 0:00 and at 5:00.
 *
 * The ramp is written on the **arrival rate** rather than on the delay between
 * spawns, because arrival is the quantity that composes with how fast the host
 * can actually answer. A linear ramp on `spawnDelay` looks like it tightens the
 * show and does almost nothing: from 4.4 s to 2.5 s it moves arrivals from 0.23
 * to 0.40 per second against a measured service rate of about 1.15, so the
 * round never leaves 20-35 % utilisation and the board never fills.
 *
 * 1.32 arrivals/s at 5:00 is a utilisation of about 1.15 — slightly *over* what
 * a good player can serve, which is what makes the finale a genuine test rather
 * than a formality.
 */
const SPAWN_RATE_OPENING = 0.31;
const SPAWN_RATE_FINALE = 1.32;

/**
 * How the arrival ramp is shaped between those two numbers. Below 1 the show
 * tightens early and then flattens, which is what spreads the failures across
 * the last two minutes instead of stacking them all into the final sixty
 * seconds; the value was picked off a measured sweep, not by eye.
 */
const SPAWN_RAMP_SHAPE = 0.75;

/**
 * Difficulty curve.
 *
 * The governing quantity is **fall time against board-clear time**, and the
 * previous curve had those two the wrong way round.
 *
 * A saturated board is served at roughly 1.15 callers per second (measured, and
 * near-identical for every skill tier, because aim assist does most of the
 * aiming). So a full board of `maxActive` callers is cleared in about
 * `maxActive / 1.15` seconds — 7 s at the cap of eight. The old curve gave a
 * caller 16.6 s to reach the floor at 4:15. While clearing the whole board
 * takes less than half the time a single caller needs to fall, **nothing can
 * ever land**, at any arrival rate: the queue is bounded by the cap and the
 * player always drains it with time to spare. That, and not the Producer
 * Override or the aim assist or the backlog relief, is why the round could not
 * be lost — measured with every one of those switched off, survival stayed at
 * 100 % for all three skill tiers.
 *
 * So the curve now closes that gap from both ends: arrivals ramp to just past
 * the service rate, and fall time comes down to where it is comparable to
 * board-clear time. Density then rises smoothly instead of sitting at 0.4, and
 * because several callers are live at once, *which* caller the player picks
 * finally matters — which is the only thing that separates a good player from
 * a careless one.
 *
 * Measured profile (drop 402 px, mean base speed ≈ 37 px/s, service ≈ 1.15/s):
 *
 * | t    | spawn | speed | fall  | clear | cap | util | live callers |
 * | ---- | ----- | ----- | ----- | ----- | --- | ---- | ------------ |
 * | 0:15 | 3.11s | 0.49  | 22.5s |  0.9s |  1  | 0.28 | 0.3          |
 * | 1:15 | 1.93s | 0.83  | 13.1s |  3.5s |  4  | 0.45 | 0.6          |
 * | 2:30 | 1.30s | 1.25  |  8.7s |  5.2s |  6  | 0.67 | 1.9          |
 * | 3:30 | 1.03s | 1.59  |  6.8s |  6.1s |  7  | 0.84 | 3.0          |
 * | 4:30 | 0.84s | 1.93  |  5.6s |  7.0s |  8  | 1.03 | 3.8          |
 *
 * The opening is deliberately untouched: one caller, alone, falling for a full
 * 22 s. It is forgiving because it is *easy*, not because losing is switched
 * off — there is no longer any window in which a full backlog does not end the
 * show.
 */
export function difficultyAt(elapsed: number): DifficultyProfile {
  const progress = Math.max(0, Math.min(1, elapsed / ROUND_SECONDS));
  const label =
    elapsed < 30
      ? "OPENING CHAT"
      : elapsed < 120
        ? "AUDIENCE Q&A"
        : elapsed < 240
          ? "HOT SEAT"
          : "FINAL QUESTION";

  const arrivals =
    SPAWN_RATE_OPENING +
    (SPAWN_RATE_FINALE - SPAWN_RATE_OPENING) * Math.pow(progress, SPAWN_RAMP_SHAPE);

  return {
    label,
    // 22.5 s to fall at the top of the show, 5.2 s by the closing seconds.
    speedScale: 0.4 + progress * 1.7,
    spawnDelay: 1 / arrivals,
    // One caller for the guided opening, then a step every 34 s to the cap.
    // This is what keeps the early show gentle no matter how tight the cadence
    // gets: with a cap of one, the spawn timer simply waits for the board.
    maxActive:
      elapsed < OPENING_SECONDS
        ? 1
        : Math.min(MAX_ACTIVE_QUESTIONS, 2 + Math.floor((elapsed - OPENING_SECONDS) / 34)),
    hitPadding: 30 - progress * 12,
  };
}

/* ------------------------------------------------------------------ *
 * Board layout — spawn placement and overlap separation
 * ------------------------------------------------------------------ */

/** Anything the layout maths needs to keep two callers off each other. */
export interface BoardCard {
  x: number;
  y: number;
  width: number;
}

/** Clear air demanded between two card edges before they count as separated. */
export const SEPARATION_GAP_X = 14;
/** Clear air demanded above and below a card before its neighbours are free. */
export const SEPARATION_GAP_Y = 10;
/** Distance a card's centre keeps from the frame edge. */
export const EDGE_MARGIN = 8;

/** Left-most centre a card of this width may occupy. */
function leftLimit(width: number): number {
  return width / 2 + EDGE_MARGIN;
}
function rightLimit(width: number): number {
  return GAME_WIDTH - width / 2 - EDGE_MARGIN;
}

/**
 * Horizontal spawn placement. Picks the candidate whose *edges* clear the
 * callers already on air by the widest margin, so a six-card board spreads
 * across the stage instead of stacking into one column. Deterministic: the
 * caller supplies the stream.
 *
 * Edge clearance, not centre distance, is the quantity that matters: a 242 px
 * veHEMI card and a 152 px OG card 130 px apart look identical to a centre test
 * and are wildly different on screen.
 */
export function pickSpawnX(
  width: number,
  taken: readonly BoardCard[],
  random: () => number,
): number {
  const min = leftLimit(width);
  const max = Math.max(min, rightLimit(width));
  const span = Math.max(1, max - min);
  let bestX = min + random() * span;
  let bestGap = -Infinity;
  for (let index = 0; index < 7; index += 1) {
    const x = min + random() * span;
    let gap = GAME_WIDTH;
    for (let other = 0; other < taken.length; other += 1) {
      const card = taken[other];
      // Only callers still near the top of the drop can collide with a spawn.
      if (card.y > SPAWN_CLEAR_Y) continue;
      const clearance = Math.abs(x - card.x) - (width + card.width) / 2;
      if (clearance < gap) gap = clearance;
    }
    if (gap > bestGap) {
      bestGap = gap;
      bestX = x;
    }
  }
  return bestX;
}

/**
 * Keeps caller cards off each other, for real.
 *
 * The spawn spread alone cannot hold: `sway` swings a card ±38 px and `zigzag`
 * ±58 px after it is placed, so two callers that spawned clear of each other
 * walk into the same column a few seconds later — which is how
 * "WEN ACTUAL DATE?" ended up printing over "zkPROOF WHITEPAPER?" and eating
 * its leading glyph. This runs *after* motion, every step, so the guarantee
 * survives sway, zigzag and maximum density.
 *
 * It is a positional (Gauss–Seidel) solve on one axis: any two cards whose
 * bodies overlap vertically are pushed apart horizontally until their edges
 * clear, each taking half the correction, with the frame edges applied as hard
 * limits after every pass. The correction is weighted by how much the two cards
 * actually overlap vertically, so a card sliding past well above another is not
 * yanked sideways for no reason — and because the solve is re-derived from the
 * motion positions each step rather than accumulated, it is stable and
 * deterministic and introduces no drift.
 *
 * When a row genuinely cannot fit (eight wide callers at one height), the solve
 * degrades to the minimum-overlap arrangement instead of failing.
 */
export function separateQuestions(cards: readonly BoardCard[], iterations = 10): void {
  const count = cards.length;
  if (count < 2) return;
  // Bodies genuinely overlap below this; the push is at full strength there.
  const bodyY = CARD_HALF_HEIGHT * 2;
  // …and eases in over the clearance band above it, so a caller drifting past
  // another is not yanked sideways the instant it comes into range.
  const spanY = bodyY + SEPARATION_GAP_Y;

  for (let pass = 0; pass < iterations; pass += 1) {
    for (let i = 0; i < count - 1; i += 1) {
      const a = cards[i];
      for (let j = i + 1; j < count; j += 1) {
        const b = cards[j];
        const dy = Math.abs(a.y - b.y);
        if (dy >= spanY) continue;
        const need = (a.width + b.width) / 2 + SEPARATION_GAP_X;
        const dx = b.x - a.x;
        const distance = Math.abs(dx);
        if (distance >= need) continue;
        const weight = dy <= bodyY ? 1 : (spanY - dy) / SEPARATION_GAP_Y;
        // Ties break on array order, which is spawn order: stable across steps.
        const direction = distance > 1e-3 ? (dx > 0 ? 1 : -1) : 1;
        const push = (need - distance) * 0.5 * weight;
        a.x -= direction * push;
        b.x += direction * push;
      }
    }
    for (let i = 0; i < count; i += 1) {
      const card = cards[i];
      const min = leftLimit(card.width);
      const max = Math.max(min, rightLimit(card.width));
      card.x = Math.max(min, Math.min(max, card.x));
    }
  }
}

/** Do two callers currently print over each other? Used by the QA bridge. */
export function questionsOverlap(a: BoardCard, b: BoardCard): boolean {
  return (
    Math.abs(a.y - b.y) < CARD_HALF_HEIGHT * 2 &&
    Math.abs(a.x - b.x) < (a.width + b.width) / 2
  );
}

/**
 * Backlog after an MWM break. Every break archives exactly one question.
 *
 * The 4:00 break used to clear the backlog outright, to hand the finale a
 * survivable starting position now that its safety net had expired. With the
 * net gone there is no cliff to cushion, and a free wipe one minute from the
 * end was worth more than everything the player did in the preceding minute —
 * so every break is now worth the same, and the relief is a flat rate the
 * player can plan around rather than a lottery that pays out at 4:00.
 */
export function backlogAfterReview(backlog: number): number {
  return Math.max(0, backlog - 1);
}

/** Bonus for answering a caller with no wrong letters and no landings since the last. */
export function perfectChainBonus(combo: number) {
  if (combo < 3) return 0;
  return 150 + Math.min(combo, 12) * 50;
}

export function questionPool(elapsed: number) {
  if (elapsed < 40) return QUESTION_SPECS.slice(0, 3);
  if (elapsed < 120) return QUESTION_SPECS.slice(0, 7);
  return QUESTION_SPECS;
}

export function scoreForAnswer(spec: QuestionSpec, combo: number) {
  return spec.value * Math.max(1, combo);
}

export function patienceTier(combo: number) {
  if (combo >= 9) return "ZEN MODE";
  if (combo >= 6) return "VERY PATIENT";
  if (combo >= 3) return "STILL LISTENING";
  return "PATIENT";
}

export function shouldBurnBacklog(answered: number, backlog: number) {
  return backlog > 0 && answered > 0 && answered % DEBT_BURN_INTERVAL === 0;
}

export function formatRoundTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
