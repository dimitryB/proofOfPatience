/**
 * POP — the in-canvas broadcast graphics package.
 *
 * This is the layer that decides whether the frame reads as *a television show*
 * or as a web page with a canvas in it. Everything here is furniture a real
 * gallery would burn in over the programme feed: an animated lower third, a
 * community-chatter crawl, a hardware countdown, a patience readout, a queued
 * announcement system, a slow-mode indicator and two production slates.
 *
 * ── Composition ───────────────────────────────────────────────────────────
 *
 * Nothing may cover the play field's working areas, so the package is laid out
 * against the *set*, not against the frame. Three exclusion volumes are treated
 * as hard geometry and never drawn into:
 *
 *   desk    x ∈ deskX ± 262, y ≥ stageY         the slab, nosing and fascia
 *   boom    x ∈ deskX ± 92,  y ≥ stageY − 58    the microphone on its yoke
 *   cards   full width, GALLERY_BAND_H ≤ y ≤ stageY
 *
 * The card volume is the whole play field, so the only truly safe real estate
 * is at its two ends: the **gallery band** across the top, which the simulation
 * guarantees no caller ever enters (`GALLERY_BAND_H` / `SPAWN_Y` in lib/pop.ts),
 * and the floor apron below `stageY`. The announcement strap is the one element
 * that must always be readable and must never hide a caller, so it lives in the
 * band, on the countdown's baseline, capped to a single line:
 *
 *   ┌ gallery band ── no caller card may ever be here ─────────────────────┐
 *   │ y  25  countdown (left)   announcement strap   patience readout (rt) │
 *   └ y  78 ──────────────────────────────────────────────────────────────┘
 *   y  85   chat slow-mode chip (under the countdown, transient)
 *   y 136                                          timecode / REC tally (rt)
 *   y 456   ticker — full width, the lowest element that still clears the boom
 *   y 492   lower third — on the stage line, camera-left of the boom, transient
 *   ──────  stage line ────────────────────────────────────────────────────
 *   y 554   score bug (left floor)             production slate (right floor)
 *
 * Everything is aligned to a 4 % safe area and one type scale, so the package
 * reads as a designed system rather than a pile of widgets.
 *
 * ── Craft rules honoured ──────────────────────────────────────────────────
 *
 *  - No `Math.random`: every decoration (screw seating, handle assignment,
 *    chatter order, mote velocities) is drawn from the injected `Rng`.
 *  - No `window`/`document` at module scope. Surfaces are created lazily on
 *    the first draw, so the module imports cleanly during a server render and
 *    degrades to a chrome-only fallback if no offscreen canvas exists.
 *  - Text is measured once and memoised, per-character advances included, and
 *    monospaced runs are laid out from a single cached advance — so tracked
 *    broadcast type and per-frame numerals cost no `measureText` at all.
 *  - Every panel, plate, cap and sweep is baked once into an offscreen surface
 *    and blitted (9-sliced where the width is dynamic). Colour strings are
 *    pre-resolved into alpha ramps and heat LUTs; the hot paths allocate
 *    nothing, build no CSS strings and open no gradients.
 *  - Bright pixels are painted as genuine small highlights — hairlines, LED
 *    segment cores, knockout badges, wipe heads — because the post chain
 *    blooms them. No fake soft-blob glow anywhere.
 *  - `scene.quality` selects a tier table; `scene.reducedMotion` removes the
 *    crawl, the blinks, the shakes, the tear and ~70 % of the motes while
 *    keeping every piece of information and the exact same composition.
 */

import {
  clamp,
  clamp01,
  createSpring,
  damp,
  ease,
  lerp,
  mixColor,
  shade,
  smoothstep,
  withAlpha,
} from "../engine/core";
// The one piece of game geometry this package needs: the height of the band at
// the top of the frame that the simulation guarantees is free of caller cards,
// exactly as `SceneContext.stageY` is the line it guarantees they stop at.
import { GALLERY_BAND_H } from "../pop";
import type {
  Noise,
  OverlayRenderer,
  OverlayState,
  QualityTier,
  RenderDeps,
  Rng,
  SceneContext,
  ScenePhase,
  Spring,
  TextureBakery,
} from "./types";

/* ------------------------------------------------------------------ *
 * Palette — hemi orange is the only saturated hue
 * ------------------------------------------------------------------ */

const CHARCOAL = "#080604";
const CHARCOAL_LIFT = "#161210";
const ALUMINIUM = "#8d8781";
const ALUMINIUM_DARK = "#4b4642";
const BONE = "#efe7e0";
const HEMI = "#ff4600";
const HEMI_HOT = "#ff2a00";

/** Bone pushed a few percent toward the accent — used for alarm body copy. */
const BONE_WARM = mixColor(BONE, HEMI, 0.12, "oklab");

const TAU = Math.PI * 2;

/**
 * Pre-built alpha ramps. Building a CSS string is not free and these tints are
 * assigned dozens of times per frame, so every translucent colour used in a
 * hot path is resolved once at init into a 33-step table.
 */
function ramp(color: string, steps = 33): readonly string[] {
  const table = new Array<string>(steps);
  for (let i = 0; i < steps; i++) table[i] = withAlpha(color, i / (steps - 1));
  return table;
}

const BONE_A = ramp(BONE);
const HEMI_A = ramp(HEMI);
const HOT_A = ramp(HEMI_HOT);
const ALU_A = ramp(ALUMINIUM);
const ALU_DARK_A = ramp(ALUMINIUM_DARK);
const INK_A = ramp(CHARCOAL);
const WHITE_A = ramp("#ffffff");

/** Index into an alpha ramp. Clamps, so callers never have to. */
function aa(table: readonly string[], alpha: number): string {
  return table[(clamp01(alpha) * (table.length - 1) + 0.5) | 0];
}

/**
 * Bone → hemi → hot ramp for the countdown numerals and the combo push, mixed
 * in OKLab so the midpoint keeps its chroma instead of sagging into mud.
 * `HEAT_CORE` is the same ramp lifted toward its own light: the LED die inside
 * a lit segment, which is what the bloom pass actually catches.
 */
const HEAT: readonly string[] = (() => {
  const n = 25;
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = t < 0.5 ? mixColor(BONE, HEMI, t * 2, "oklab") : mixColor(HEMI, HEMI_HOT, (t - 0.5) * 2, "oklab");
  }
  return out;
})();

const HEAT_CORE: readonly string[] = HEAT.map((c) => shade(c, 0.45));

function heatIndex(t: number): number {
  return (clamp01(t) * (HEAT.length - 1) + 0.5) | 0;
}
function heat(t: number): string {
  return HEAT[heatIndex(t)];
}

/* ------------------------------------------------------------------ *
 * Type — one scale, three faces
 * ------------------------------------------------------------------ */

const SANS = '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif';
const DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Broadcast type scale, in logical pixels. */
const T_MICRO = 6.5;
const T_TINY = 7.5;
const T_SMALL = 9;
const T_BODY = 11;
const T_LEAD = 13;
const T_TITLE = 15.5;

function sans(weight: number, size: number): string {
  return `${weight} ${size}px ${SANS}`;
}
function display(weight: number, size: number): string {
  return `${weight} ${size}px ${DISPLAY}`;
}
function mono(weight: number, size: number): string {
  return `${weight} ${size}px ${MONO}`;
}

/* Every font in the package, resolved once — the strings double as cache keys. */
const F_KICKER = mono(700, T_MICRO);
const F_META = mono(600, T_SMALL);
const F_METAB = mono(800, T_SMALL);
const F_CHAT = sans(500, T_BODY);
const F_HANDLE = mono(700, T_SMALL + 0.5);
const F_STRAP = sans(800, T_TITLE);
const F_STRAP_SM = sans(800, T_LEAD);
const F_IDENT = display(900, T_TITLE + 1.5);
const F_SUB = mono(700, T_SMALL + 0.5);
const F_SCORE = mono(800, 17);
const F_TIER = mono(800, T_TINY);

/** Combo numerals are quantised to four faces; the tier ramp is a transform. */
const COMBO_SIZES = [21, 25, 29, 33] as const;
const COMBO_FONTS = [
  display(900, COMBO_SIZES[0]),
  display(900, COMBO_SIZES[1]),
  display(900, COMBO_SIZES[2]),
  display(900, COMBO_SIZES[3]),
] as const;

/* ------------------------------------------------------------------ *
 * Small maths and formatting
 * ------------------------------------------------------------------ */

/**
 * Peak displacement produced by a unit velocity impulse on a spring at rest —
 * the same closed form the engine camera uses. It lets every UI pulse be
 * authored as "peak = 1" instead of a magic velocity tuned per stiffness.
 *
 * Under-damped: x(t) = (v₀/ω_d)·e^(−ζωt)·sin(ω_d·t), maximal at t = θ/ω_d with
 * θ = atan2(ω_d, ζω). At ζ ≥ 1 the peak of v₀·t·e^(−ωt) sits at t = 1/ω.
 */
function impulsePeak(stiffness: number, damping: number, mass = 1): number {
  const w = Math.sqrt(stiffness / mass);
  const z = damping / (2 * Math.sqrt(stiffness * mass));
  if (z >= 1) return 1 / (w * Math.E);
  const wd = w * Math.sqrt(1 - z * z);
  const theta = Math.atan2(wd, z * w);
  return (Math.exp((-z * w * theta) / wd) * Math.sin(theta)) / wd;
}

/** A spring used as a one-shot pulse whose peak is 1 for `fire(1)`. */
interface Pulse {
  readonly value: number;
  fire(strength?: number): void;
  update(dt: number): void;
}

function createPulse(stiffness: number, damping: number): Pulse {
  const spring: Spring = createSpring({ stiffness, damping, mass: 1 });
  const gain = 1 / impulsePeak(stiffness, damping, 1);
  return {
    get value(): number {
      return spring.value;
    },
    fire(strength = 1): void {
      spring.impulse(strength * gain);
    },
    update(dt: number): void {
      spring.update(dt);
    },
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, Math.abs(w) * 0.5, Math.abs(h) * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

/** A slab with one clipped corner — the broadcast chamfer. */
function chamferRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cut: number,
): void {
  const c = Math.min(cut, Math.abs(w) * 0.5, Math.abs(h) * 0.5);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

function pad2(value: number): string {
  const v = value < 0 ? 0 : value > 99 ? 99 : value | 0;
  return v < 10 ? "0" + v : "" + v;
}

/** Thin-space grouped integer for the score bug. */
function groupNumber(value: number): string {
  const v = Math.max(0, Math.round(value));
  if (v < 1000) return "" + v;
  const s = "" + v;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += " ";
    out += s[i];
  }
  return out;
}

/** SMPTE-style timecode at 30 fps, non-drop. Pure broadcast set dressing. */
function timecode(seconds: number): string {
  const t = Math.max(0, seconds);
  const whole = Math.floor(t);
  const frames = Math.floor((t - whole) * 30);
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = whole % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(frames)}`;
}

/* ------------------------------------------------------------------ *
 * Text metrics
 *
 * `measureText` is a layout call; running one inside a draw loop is the
 * easiest way to lose a frame budget. Proportional runs memoise their
 * per-character advances on `${font}|${text}`; monospaced runs — which is
 * every readout whose string changes each frame — resolve from a single
 * cached advance per font, so the caches can never grow with the game state.
 * ------------------------------------------------------------------ */

const MEASURE_LIMIT = 512;
const widthCache = new Map<string, number>();
const advanceCache = new Map<string, Float64Array>();
const runCache = new Map<string, Run>();
const monoAdvanceCache = new Map<string, number>();
const fontSizeCache = new Map<string, number>();
const hasLetterCache = new Map<string, boolean>();

/* ------------------------------------------------------------------ *
 * Tracking
 *
 * Canvas has no letter-spacing, so every run here is laid out glyph by glyph.
 * Doing that on raw advances is what fractured words: the white a pair of
 * glyphs leaves between them is `advance − right-ink + tracking + left-ink`, so
 * a narrow letter in a wide box — a capital I above all — opens a hole in the
 * middle of a word that has nothing to do with the tracking asked for.
 *
 * Measured (pop-qa/probeType.mjs), ink gap between drawn glyphs, before → after:
 *
 * | run                            | widest inside a word | word gap ÷ letter gap |
 * | ------------------------------ | -------------------- | --------------------- |
 * | MIDWEEK WITH MAX  (17 px, 1.1) | 0.201 em → 0.172 em  | 2.13 → 3.20           |
 * | COMMUNITY TAKEOVER (9.5, 1.7)  | 0.255 em → 0.236 em  | 3.65 → 5.28           |
 * | HEMI STUDIOS…     (6.5, 1.5)   | 0.217 em → 0.147 em  | 4.83 → 8.60           |
 * | PRODUCTION        (6.5, 1.9)   | 0.279 em → 0.147 em  | (single word)         |
 * | ACTIVE CALLERS    (7.5, 1.6)   | 0.282 em → 0.229 em  | 3.42 → 5.29           |
 * | announcement body (13, 0.5)    | 0.133 em → 0.133 em  | 2.31 → 3.66           |
 *
 * Note what the numbers say about the original finding: the word gap already
 * beat the letter gap everywhere, by 2.1× to 4.8×, so "the inter-letter gap
 * inside a word exceeds the inter-word gap" was not literally true. What *was*
 * true is that a fifth to a quarter of an em of white was opening inside words.
 *
 * A fifth of an em of white inside a word is a word break to the eye; a quarter
 * of an em certainly is. Three moves fix it and they are all applied below:
 *
 *  1. **Tracking is capped in ems**, not px. 1.9 px on a 6.5 px face is 0.29 em
 *     of tracking — nothing about that is the "tight tracking" this show's type
 *     is supposed to have. The cap is 0.16 em.
 *  2. **Word boundaries get an explicit extra gap** that scales with the
 *     tracking, so the thing the eye uses to find word ends can never end up in
 *     competition with the thing that separates letters.
 *  3. **Words are never laid out on the monospace grid.** `fillMono` used one
 *     "0" advance for every glyph, so a capital I got a full digit cell of
 *     white beside it. Numerals keep the grid — a counter must not shuffle as
 *     its digits change — and anything containing a letter is set on its own
 *     advances.
 *
 * A fourth move, optical evening against `actualBoundingBox*`, was built and
 * then removed: this platform returns those ink extents **rounded to whole
 * pixels** (measured on the ident face at 17 px: left ∈ {−1, 0}, right ∈
 * {5, 11, 12, 13, 14, 16, 19}), which is ±0.06 em of quantisation at 17 px and
 * ±0.15 em at 6.5 px. A correction computed from that is noise, and on one
 * measured run it made the spacing *worse* — widest gap inside a word 1.73 px →
 * 2.39 px. Spacing here stays on advance metrics, which are exact.
 * ------------------------------------------------------------------ */

/** Hard ceiling on tracking, as a fraction of the em. */
const MAX_TRACK_EM = 0.16;
/** Extra white at a word boundary, as a fraction of the em… */
const WORD_GAP_EM = 0.18;
/** …and never less than this multiple of the letter tracking. */
const WORD_GAP_RATIO = 2.2;
/**
 * Tracking on the lower-third ident. 1.1 px on the 17 px display face measured
 * the worst word-to-letter ratio in the package (2.13:1) because the face's own
 * side bearings around a capital I already leave 2.33 px, and the tracking put
 * another 1.1 px on top of it — 0.20 em of white in the middle of "MIDWEEK".
 * At 0.6 px the title is tighter, which is what a broadcast ident wants anyway.
 */
const IDENT_TRACK = 0.6;

interface Run {
  /** Distance from each glyph's pen position to the next glyph's. */
  steps: Float64Array;
  /** Laid-out width of the whole run. */
  total: number;
}

function textWidth(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = font + "|" + text;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const w = ctx.measureText(text).width;
  if (widthCache.size >= MEASURE_LIMIT) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

/** Pixel size out of a CSS font shorthand. */
function fontSize(font: string): number {
  const hit = fontSizeCache.get(font);
  if (hit !== undefined) return hit;
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  const size = match ? Number(match[1]) : 12;
  fontSizeCache.set(font, size);
  return size;
}

function hasLetter(text: string): boolean {
  const hit = hasLetterCache.get(text);
  if (hit !== undefined) return hit;
  let found = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      found = true;
      break;
    }
  }
  if (hasLetterCache.size >= MEASURE_LIMIT) hasLetterCache.clear();
  hasLetterCache.set(text, found);
  return found;
}

function advancesFor(ctx: CanvasRenderingContext2D, font: string, text: string): Float64Array {
  const key = font + "|" + text;
  const hit = advanceCache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const out = new Float64Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = ctx.measureText(text[i]).width;
  if (advanceCache.size >= MEASURE_LIMIT) advanceCache.clear();
  advanceCache.set(key, out);
  return out;
}

/**
 * The laid-out run: one advance per glyph, tracking capped in ems, word
 * boundaries given their own explicit gap. Everything else here consumes this,
 * so the fill, the ghost, the stroke, the caret and the measurement can never
 * disagree about where a glyph sits.
 */
function runFor(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  tracking: number,
): Run {
  const key = font + "|" + tracking + "|" + text;
  const hit = runCache.get(key);
  if (hit !== undefined) return hit;

  const n = text.length;
  const adv = advancesFor(ctx, font, text);
  const size = fontSize(font);
  const letter = Math.min(Math.max(0, tracking), size * MAX_TRACK_EM);
  const wordExtra = Math.max(size * WORD_GAP_EM, letter * WORD_GAP_RATIO);
  const steps = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    steps[i] = adv[i] + letter + (text[i] === " " ? wordExtra : 0);
  }

  let total = n > 0 ? adv[n - 1] : 0;
  for (let i = 0; i < n - 1; i++) total += steps[i];
  const made: Run = { steps, total };
  if (runCache.size >= MEASURE_LIMIT) runCache.clear();
  runCache.set(key, made);
  return made;
}

function trackedWidth(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  tracking: number,
): number {
  if (text.length === 0) return 0;
  return runFor(ctx, font, text, tracking).total;
}

/* ------------------------------------------------------------------ *
 * Fitting
 *
 * No plate in this package sizes itself by eye. Every run that goes onto a
 * plate is measured against the box it is going into, and the box wins: the
 * face steps down half a point at a time until the run fits, and only when the
 * face reaches its legibility floor is the tail trimmed with a real ellipsis.
 *
 * The lower third was the reason: "MIDWEEK WITH MAX" was set at a fixed 17 px
 * against a plate whose width was a constant, so the only thing keeping the
 * ident inside its own slab was that the two numbers happened to agree at one
 * viewport. Nothing measured anything, so nothing could report a clip.
 * ------------------------------------------------------------------ */

interface Fitted {
  font: string;
  text: string;
  width: number;
}

const fitCache = new Map<string, Fitted>();

/** The same CSS font shorthand at a different pixel size. */
function withSize(font: string, size: number): string {
  return font.replace(/\d+(?:\.\d+)?px/, `${Math.round(size * 4) / 4}px`);
}

function fitRun(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  tracking: number,
  maxW: number,
  minRatio = 0.7,
): Fitted {
  const key = font + "|" + tracking + "|" + Math.round(maxW) + "|" + text;
  const hit = fitCache.get(key);
  if (hit) return hit;

  let made: Fitted = { font, text, width: trackedWidth(ctx, font, text, tracking) };
  if (maxW > 0 && made.width > maxW && text.length > 0) {
    const floor = Math.max(6, fontSize(font) * minRatio);
    let size = fontSize(font);
    let face = font;
    let width = made.width;
    while (width > maxW && size > floor + 0.01) {
      size = Math.max(floor, size - 0.5);
      face = withSize(font, size);
      width = trackedWidth(ctx, face, text, tracking);
    }
    let line = text;
    while (width > maxW && line.length > 1) {
      line = line.slice(0, -1).trimEnd();
      width = trackedWidth(ctx, face, line + "…", tracking);
    }
    if (line !== text) line += "…";
    made = { font: face, text: line, width: trackedWidth(ctx, face, line, tracking) };
  }
  if (fitCache.size >= MEASURE_LIMIT) fitCache.clear();
  fitCache.set(key, made);
  return made;
}

/** Draws a pre-fitted run. `align` matches `fillTracked`. */
function fillFitted(
  ctx: CanvasRenderingContext2D,
  fit: Fitted,
  x: number,
  y: number,
  tracking: number,
  align: -1 | 0 | 1,
  limit = fit.text.length,
): void {
  fillTracked(ctx, fit.font, fit.text, x, y, tracking, align, limit);
}

/**
 * Proportional broadcast type on an explicit tracking. `align` is −1 left,
 * 0 centred, 1 right; `limit` reveals only the first N characters (the lower
 * third's type-on). Returns the laid-out width.
 */
function fillTracked(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: -1 | 0 | 1,
  limit = text.length,
): number {
  if (text.length === 0) return 0;
  const run = runFor(ctx, font, text, tracking);
  const total = run.total;
  ctx.font = font;
  let cx = align < 0 ? x : align === 0 ? x - total * 0.5 : x - total;
  const n = Math.min(text.length, Math.max(0, limit));
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch !== " ") ctx.fillText(ch, cx, y);
    cx += run.steps[i];
  }
  return total;
}

/** Outline pass with identical tracking, so a rim lands on its own glyphs. */
function strokeTracked(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: -1 | 0 | 1,
): void {
  if (text.length === 0) return;
  const run = runFor(ctx, font, text, tracking);
  ctx.font = font;
  let cx = align < 0 ? x : align === 0 ? x - run.total * 0.5 : x - run.total;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== " ") ctx.strokeText(ch, cx, y);
    cx += run.steps[i];
  }
}

/** Where the caret sits after `limit` characters of a tracked run. */
function trackedCaretX(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  x: number,
  tracking: number,
  limit: number,
): number {
  const run = runFor(ctx, font, text, tracking);
  let cx = x;
  const n = Math.min(text.length, Math.max(0, limit));
  for (let i = 0; i < n; i++) cx += run.steps[i];
  return cx;
}

/** One advance per monospaced font — every glyph in the family shares it. */
function monoAdvance(ctx: CanvasRenderingContext2D, font: string): number {
  const hit = monoAdvanceCache.get(font);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const w = ctx.measureText("0").width;
  monoAdvanceCache.set(font, w);
  return w;
}

/**
 * The tabular grid is worth keeping for numerals — a counter must not shuffle
 * as its digits change — but it is exactly wrong for words: every narrow letter
 * gets a full digit cell of white beside it. So any run containing a letter is
 * laid out proportionally and optically, and only pure numeric runs stay on the
 * grid.
 */
function monoWidth(ctx: CanvasRenderingContext2D, font: string, text: string, tracking: number): number {
  if (text.length === 0) return 0;
  if (hasLetter(text)) return trackedWidth(ctx, font, text, tracking);
  const size = fontSize(font);
  const letter = Math.min(Math.max(0, tracking), size * MAX_TRACK_EM);
  return text.length * monoAdvance(ctx, font) + letter * (text.length - 1);
}

function fillMono(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: -1 | 0 | 1,
): number {
  if (text.length === 0) return 0;
  if (hasLetter(text)) return fillTracked(ctx, font, text, x, y, tracking, align);
  const size = fontSize(font);
  const letter = Math.min(Math.max(0, tracking), size * MAX_TRACK_EM);
  const step = monoAdvance(ctx, font) + letter;
  const total = text.length * step - letter;
  ctx.font = font;
  let cx = align < 0 ? x : align === 0 ? x - total * 0.5 : x - total;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== " ") ctx.fillText(ch, cx, y);
    cx += step;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * Offscreen surfaces
 * ------------------------------------------------------------------ */

interface Surface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  /** Backing-store size, device pixels. */
  w: number;
  h: number;
  /** Logical size. */
  lw: number;
  lh: number;
  /** Realised device pixels per logical pixel. */
  k: number;
}

/**
 * Creates a bake target already transformed into logical units. Returns null
 * during a server render (no OffscreenCanvas, no document), where the callers
 * fall back to painting a simplified chrome straight into the frame.
 */
function createSurface(lw: number, lh: number, k: number): Surface | null {
  const w = Math.max(1, Math.round(lw * k));
  const h = Math.max(1, Math.round(lh * k));
  let ctx: CanvasRenderingContext2D | null = null;
  let canvas: CanvasImageSource | null = null;

  if (typeof OffscreenCanvas === "function") {
    const off = new OffscreenCanvas(w, h);
    const c = off.getContext("2d");
    // The two 2D context interfaces are API-identical for everything used here.
    if (c) {
      canvas = off;
      ctx = c as unknown as CanvasRenderingContext2D;
    }
  }
  if (!ctx && typeof document !== "undefined" && typeof document.createElement === "function") {
    const el = document.createElement("canvas");
    el.width = w;
    el.height = h;
    const c = el.getContext("2d");
    if (c) {
      canvas = el;
      ctx = c;
    }
  }
  if (!ctx || !canvas) return null;

  ctx.setTransform(w / lw, 0, 0, h / lh, 0, 0);
  return { canvas, ctx, w, h, lw, lh, k: w / lw };
}

/** A baked plate that can be drawn at any width by 9-slicing its end caps. */
interface Panel {
  surface: Surface;
  /** Cap width in logical units. All horizontal detail lives inside the caps. */
  cap: number;
}

function drawPanel(ctx: CanvasRenderingContext2D, panel: Panel, x: number, y: number, w: number): void {
  const s = panel.surface;
  if (w <= 0) return;
  const cap = Math.min(panel.cap, w * 0.5);
  const srcCap = panel.cap * s.k;
  const h = s.lh;
  ctx.drawImage(s.canvas, 0, 0, srcCap, s.h, x, y, cap, h);
  const midSrc = s.w - srcCap * 2;
  const midDst = w - cap * 2;
  if (midSrc > 0.5 && midDst > 0.5) {
    ctx.drawImage(s.canvas, srcCap, 0, midSrc, s.h, x + cap, y, midDst, h);
  }
  ctx.drawImage(s.canvas, s.w - srcCap, 0, srcCap, s.h, x + w - cap, y, cap, h);
}

function blit(ctx: CanvasRenderingContext2D, s: Surface, x: number, y: number): void {
  ctx.drawImage(s.canvas, 0, 0, s.w, s.h, x, y, s.lw, s.lh);
}

/* ------------------------------------------------------------------ *
 * Quality tiers
 * ------------------------------------------------------------------ */

interface Tier {
  /** Device pixels per logical pixel in the baked art, before DPR. */
  bake: number;
  /** Material grain baked into the smoked-glass plates. */
  grain: boolean;
  /** Brushed aluminium along bezels and rails. */
  brushed: boolean;
  /** Machine screws on the clock bezel. */
  screws: boolean;
  /** Registration marks at the safe-area corners. */
  registration: boolean;
  /** Specular sweeps across badges and the "good" announcement. */
  sweeps: boolean;
  /** Text drop-ghost, for legibility over a busy plate. */
  textGhost: boolean;
  /** Pooled decoration motes (hard cap). */
  motes: number;
  /** Unlit LED segments are drawn as well as the lit ones. */
  ghostSegments: boolean;
  /** Analogue signal tear across the crawl on heavy camera trauma. */
  tear: boolean;
}

const TIERS: Record<QualityTier, Tier> = {
  low: {
    bake: 1,
    grain: false,
    brushed: false,
    screws: false,
    registration: false,
    sweeps: false,
    textGhost: false,
    motes: 0,
    ghostSegments: false,
    tear: false,
  },
  medium: {
    bake: 1.25,
    grain: false,
    brushed: true,
    screws: false,
    registration: true,
    sweeps: true,
    textGhost: true,
    motes: 20,
    ghostSegments: true,
    tear: false,
  },
  high: {
    bake: 1.6,
    grain: true,
    brushed: true,
    screws: true,
    registration: true,
    sweeps: true,
    textGhost: true,
    motes: 36,
    ghostSegments: true,
    tear: true,
  },
  ultra: {
    bake: 2,
    grain: true,
    brushed: true,
    screws: true,
    registration: true,
    sweeps: true,
    textGhost: true,
    motes: 48,
    ghostSegments: true,
    tear: true,
  },
};

/* ------------------------------------------------------------------ *
 * Baked art
 * ------------------------------------------------------------------ */

/**
 * The smoked-glass slab every strap, chip and lower third is built on.
 *
 * All horizontal structure (the rail gutter, the corner specular, the trailing
 * notches) is confined to the caps, so the stretched middle is a pure vertical
 * gradient and the 9-slice is invisible. The top hairline is a genuine
 * one-pixel highlight: the post chain will bloom it, which is what sells
 * "machined glass edge" rather than "1px border".
 */
function bakePanel(
  h: number,
  k: number,
  tier: Tier,
  bakery: TextureBakery,
  noise: Noise,
): Panel | null {
  const lw = 700;
  const cap = 30;
  const surface = createSurface(lw, h, k);
  if (!surface) return null;
  const ctx = surface.ctx;

  // Body: top-lit. The set's key is overhead, so the slab is brightest along
  // its upper edge and sinks into charcoal at the bottom.
  const body = ctx.createLinearGradient(0, 0, 0, h);
  body.addColorStop(0, withAlpha(shade(CHARCOAL_LIFT, 0.1), 0.9));
  body.addColorStop(0.16, withAlpha(CHARCOAL_LIFT, 0.86));
  body.addColorStop(0.72, withAlpha(shade(CHARCOAL, 0.12), 0.87));
  body.addColorStop(1, withAlpha(CHARCOAL, 0.93));
  ctx.fillStyle = body;
  chamferRect(ctx, 0, 0, lw, h, 9);
  ctx.fill();

  // Brushed aluminium along the top 2 px — the machined edge of the slab.
  if (tier.brushed) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, lw, 2.2);
    ctx.clip();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = bakery.pattern(ctx, "brushed-metal", "repeat");
    ctx.fillRect(0, 0, lw, 2.2);
    ctx.restore();
  }

  // Material grain: without it a large flat slab reads as vector art.
  if (tier.grain) {
    ctx.save();
    chamferRect(ctx, 0, 0, lw, h, 9);
    ctx.clip();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = bakery.pattern(ctx, "noise-fine", "repeat");
    ctx.fillRect(0, 0, lw, h);
    ctx.restore();
  }

  // Top hairline and the shadowed underside.
  ctx.fillStyle = aa(BONE_A, 0.17);
  ctx.fillRect(0, 0, lw, 1);
  ctx.fillStyle = aa(INK_A, 0.55);
  ctx.fillRect(0, h - 1, lw, 1);
  ctx.fillStyle = aa(BONE_A, 0.05);
  ctx.fillRect(0, h - 2, lw, 1);

  // Left cap: the gutter the tone accent drops into, plus a corner specular.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cap, h);
  ctx.clip();
  const spec = ctx.createRadialGradient(4, 0, 0, 4, 0, 34);
  spec.addColorStop(0, aa(BONE_A, 0.1));
  spec.addColorStop(1, aa(BONE_A, 0));
  ctx.fillStyle = spec;
  ctx.fillRect(0, 0, cap, h);
  ctx.fillStyle = aa(INK_A, 0.5);
  ctx.fillRect(4.4, 1, 1.2, h - 2);
  ctx.restore();

  // Right cap: machined notches, the visual "end of the plate".
  ctx.fillStyle = aa(ALU_A, 0.22);
  ctx.fillRect(lw - 13, 5, 1, h - 14);
  ctx.fillStyle = aa(ALU_A, 0.1);
  ctx.fillRect(lw - 9, 5, 1, h - 14);

  // A whisper of unevenness along the top edge so the gradient is not perfect.
  ctx.save();
  for (let i = 0; i < 14; i++) {
    const x = (i / 14) * lw;
    const n = noise.fbm2(x * 0.01, h * 0.03, 3);
    ctx.globalAlpha = 0.02 + 0.03 * clamp01(n * 0.5 + 0.5);
    ctx.fillStyle = BONE;
    ctx.fillRect(x, 1, lw / 14, 0.7);
  }
  ctx.restore();

  return { surface, cap };
}

/**
 * The countdown housing: a rack-mounted display module. Aluminium bezel with a
 * real top highlight and bottom shadow, a recessed window with an inner
 * shadow, cover glass with an off-axis specular, and machine screws.
 */
function bakeClockPlate(
  w: number,
  h: number,
  k: number,
  tier: Tier,
  bakery: TextureBakery,
  rng: Rng,
): Surface | null {
  const surface = createSurface(w, h, k);
  if (!surface) return null;
  const ctx = surface.ctx;

  const bezel = ctx.createLinearGradient(0, 0, 0, h);
  bezel.addColorStop(0, withAlpha(shade(ALUMINIUM_DARK, 0.16), 0.95));
  bezel.addColorStop(0.5, withAlpha(shade(ALUMINIUM_DARK, -0.42), 0.95));
  bezel.addColorStop(1, withAlpha(shade(CHARCOAL, 0.2), 0.96));
  ctx.fillStyle = bezel;
  roundRect(ctx, 0, 0, w, h, 4);
  ctx.fill();

  if (tier.brushed) {
    ctx.save();
    roundRect(ctx, 0, 0, w, h, 4);
    ctx.clip();
    ctx.globalAlpha = 0.26;
    ctx.fillStyle = bakery.pattern(ctx, "brushed-metal", "repeat");
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  ctx.fillStyle = aa(BONE_A, 0.24);
  ctx.fillRect(1, 0.5, w - 2, 0.9);
  ctx.fillStyle = aa(INK_A, 0.6);
  ctx.fillRect(1, h - 1.2, w - 2, 1.2);

  // Recessed display window.
  const inset = 4.5;
  const wx = inset;
  const wy = inset;
  const ww = w - inset * 2;
  const wh = h - inset * 2;
  const glass = ctx.createLinearGradient(0, wy, 0, wy + wh);
  glass.addColorStop(0, withAlpha("#050403", 0.97));
  glass.addColorStop(0.55, withAlpha("#0b0908", 0.97));
  glass.addColorStop(1, withAlpha("#040302", 0.98));
  ctx.fillStyle = glass;
  roundRect(ctx, wx, wy, ww, wh, 2.4);
  ctx.fill();

  ctx.save();
  roundRect(ctx, wx, wy, ww, wh, 2.4);
  ctx.clip();
  // Inner shadow: three decreasing strokes; cheap, and it reads as depth.
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = aa(INK_A, 0.5 - i * 0.15);
    ctx.lineWidth = 1;
    roundRect(ctx, wx + 0.5 + i, wy + 0.5 + i, ww - 1 - i * 2, wh - 1 - i * 2, 2.4);
    ctx.stroke();
  }
  // Cover-glass specular: a shallow diagonal wedge across the upper third.
  const sheen = ctx.createLinearGradient(wx, wy, wx + ww * 0.7, wy + wh);
  sheen.addColorStop(0, aa(BONE_A, 0.055));
  sheen.addColorStop(0.42, aa(BONE_A, 0.014));
  sheen.addColorStop(0.43, aa(BONE_A, 0));
  ctx.fillStyle = sheen;
  ctx.fillRect(wx, wy, ww, wh);
  ctx.restore();

  // Machine screws, deterministically seated so the panel is not symmetric.
  if (tier.screws) {
    const seat = rng.fork(0x5c2e);
    for (let i = 0; i < 2; i++) {
      const cx = i === 0 ? 2.6 : w - 2.6;
      const cy = h * 0.5 + seat.range(-1.2, 1.2);
      const a = seat.range(0, Math.PI);
      ctx.fillStyle = aa(INK_A, 0.75);
      ctx.beginPath();
      ctx.arc(cx, cy, 1.7, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = aa(BONE_A, 0.24);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * 1.3, cy - Math.sin(a) * 1.3);
      ctx.lineTo(cx + Math.cos(a) * 1.3, cy + Math.sin(a) * 1.3);
      ctx.stroke();
    }
  }
  return surface;
}

/**
 * A floor slate: the thin production plates in the bottom corners. Matte, a
 * hemi tab on the outboard edge, a hairline rule between its two rows and a
 * drain gutter along the bottom.
 *
 * The row labels never change, so they are baked in with the plate rather than
 * laid out character by character on every frame — the same reasoning that
 * puts the CHAT block in the ticker cap.
 */
function bakeSlate(
  w: number,
  h: number,
  k: number,
  tier: Tier,
  bakery: TextureBakery,
  mirrored: boolean,
  labels: readonly [string, string],
): Surface | null {
  const surface = createSurface(w, h, k);
  if (!surface) return null;
  const ctx = surface.ctx;

  ctx.save();
  if (mirrored) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }

  const body = ctx.createLinearGradient(0, 0, 0, h);
  body.addColorStop(0, withAlpha(shade(CHARCOAL_LIFT, 0.05), 0.88));
  body.addColorStop(1, withAlpha(CHARCOAL, 0.92));
  ctx.fillStyle = body;
  chamferRect(ctx, 0, 0, w, h, 7);
  ctx.fill();

  if (tier.grain) {
    ctx.save();
    chamferRect(ctx, 0, 0, w, h, 7);
    ctx.clip();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = bakery.pattern(ctx, "noise-coarse", "repeat");
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  ctx.fillStyle = aa(BONE_A, 0.14);
  ctx.fillRect(0, 0, w, 1);
  ctx.fillStyle = aa(INK_A, 0.6);
  ctx.fillRect(0, h - 1, w, 1);

  // Leading tab: the slate's identity colour.
  ctx.fillStyle = aa(HEMI_A, 0.85);
  ctx.fillRect(0, 0, 2.4, h);
  ctx.fillStyle = aa(HOT_A, 0.5);
  ctx.fillRect(0, 0, 2.4, h * 0.34);

  // Row rule and the trailing rack notch.
  ctx.fillStyle = aa(BONE_A, 0.075);
  ctx.fillRect(8, Math.round(h * 0.44) + 0.5, w - 18, 1);
  ctx.fillStyle = aa(ALU_A, 0.16);
  ctx.fillRect(w - 5, 4, 1, h - 12);

  ctx.restore(); // mirror

  // Labels are drawn unmirrored, after the plate, and measured against it —
  // a baked plate that outgrows its own art cannot be caught at run time.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = aa(ALU_A, 0.75);
  const box = w - 22;
  fillFitted(ctx, fitRun(ctx, F_KICKER, labels[0], 1.6, box), 11, 13, 1.6, -1);
  fillFitted(ctx, fitRun(ctx, F_KICKER, labels[1], 1.6, box), 11, 31, 1.6, -1);
  return surface;
}

/**
 * The ticker chrome: the strip the crawl runs inside. Baked at the exact strip
 * width so the top rail, the sunken channel and the shadowed underside stay
 * pixel-crisp. Crawl type and the end fades are composited over it every frame
 * inside the scroll buffer.
 */
function bakeTickerChrome(
  w: number,
  h: number,
  k: number,
  tier: Tier,
  bakery: TextureBakery,
): Surface | null {
  const surface = createSurface(w, h, k);
  if (!surface) return null;
  const ctx = surface.ctx;

  const body = ctx.createLinearGradient(0, 0, 0, h);
  body.addColorStop(0, withAlpha(shade(CHARCOAL_LIFT, 0.02), 0.84));
  body.addColorStop(0.4, withAlpha(CHARCOAL, 0.8));
  body.addColorStop(1, withAlpha(shade(CHARCOAL, 0.06), 0.86));
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, w, h);

  if (tier.grain) {
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.11;
    ctx.fillStyle = bakery.pattern(ctx, "noise-fine", "repeat");
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Top rail: aluminium hairline over a hemi thread — the show's accent.
  ctx.fillStyle = aa(BONE_A, 0.16);
  ctx.fillRect(0, 0, w, 1);
  ctx.fillStyle = aa(HEMI_A, 0.5);
  ctx.fillRect(0, 1, w, 0.8);
  ctx.fillStyle = aa(INK_A, 0.7);
  ctx.fillRect(0, h - 1.4, w, 1.4);
  ctx.fillStyle = aa(BONE_A, 0.045);
  ctx.fillRect(0, h - 2.2, w, 0.8);

  // Sunken channel shadow immediately under the rail: sells the recess.
  const channel = ctx.createLinearGradient(0, 1.8, 0, 8);
  channel.addColorStop(0, aa(INK_A, 0.42));
  channel.addColorStop(1, aa(INK_A, 0));
  ctx.fillStyle = channel;
  ctx.fillRect(0, 1.8, w, 6.2);

  return surface;
}

/** Left cap of the ticker: a solid hemi block with knockout type. */
function bakeChatCap(w: number, h: number, k: number, tier: Tier): Surface | null {
  const surface = createSurface(w, h, k);
  if (!surface) return null;
  const ctx = surface.ctx;

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, shade(HEMI, 0.18));
  g.addColorStop(0.55, HEMI);
  g.addColorStop(1, shade(HEMI_HOT, -0.22));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Machined bright edge along the top; the post chain blooms this.
  ctx.fillStyle = aa(WHITE_A, 0.5);
  ctx.fillRect(0, 0, w, 1);
  ctx.fillStyle = aa(INK_A, 0.4);
  ctx.fillRect(0, h - 1, w, 1);
  // Trailing bevel where the cap meets the channel.
  ctx.fillStyle = aa(INK_A, 0.35);
  ctx.fillRect(w - 2, 0, 2, h);
  ctx.fillStyle = aa(WHITE_A, 0.14);
  ctx.fillRect(w - 2.6, 0, 0.6, h);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = CHARCOAL;
  fillMono(ctx, mono(800, T_SMALL), "CHAT", w * 0.5 - 3.5, h * 0.5 + 3.4, 1.5, 0);
  if (tier.sweeps) {
    ctx.fillStyle = withAlpha(CHARCOAL, 0.78);
    ctx.beginPath();
    ctx.arc(w - 11, h * 0.5, 2.1, 0, TAU);
    ctx.fill();
  }
  return surface;
}

/** Right cap: an aluminium end plate with travel chevrons. */
function bakeEndCap(w: number, h: number, k: number): Surface | null {
  const surface = createSurface(w, h, k);
  if (!surface) return null;
  const ctx = surface.ctx;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, withAlpha(shade(ALUMINIUM_DARK, -0.1), 0.95));
  g.addColorStop(1, withAlpha(shade(CHARCOAL, 0.14), 0.96));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = aa(BONE_A, 0.2);
  ctx.fillRect(0, 0, w, 1);
  ctx.fillStyle = aa(INK_A, 0.55);
  ctx.fillRect(0, h - 1, w, 1);
  ctx.fillStyle = aa(INK_A, 0.4);
  ctx.fillRect(0, 0, 1.4, h);

  ctx.strokeStyle = aa(ALU_A, 0.75);
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  for (let i = 0; i < 2; i++) {
    const x = w * 0.5 - 3.5 + i * 6;
    ctx.beginPath();
    ctx.moveTo(x + 2.4, h * 0.5 - 3.4);
    ctx.lineTo(x - 1.4, h * 0.5);
    ctx.lineTo(x + 2.4, h * 0.5 + 3.4);
    ctx.stroke();
  }
  return surface;
}

/** A one-sided specular sweep, stretched to whatever it has to cross. */
function bakeSweep(k: number, tint: string): Surface | null {
  const lw = 160;
  const lh = 64;
  const surface = createSurface(lw, lh, k);
  if (!surface) return null;
  const ctx = surface.ctx;
  const g = ctx.createLinearGradient(0, 0, lw, 0);
  g.addColorStop(0, withAlpha(tint, 0));
  g.addColorStop(0.42, withAlpha(tint, 0.1));
  g.addColorStop(0.6, withAlpha(tint, 0.85));
  g.addColorStop(0.68, withAlpha(tint, 0.2));
  g.addColorStop(1, withAlpha(tint, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, lw, lh);
  return surface;
}

/* ------------------------------------------------------------------ *
 * Seven-segment numerals
 *
 * Real hardware, drawn as real hardware: seven tapered bars per cell, unlit
 * segments still faintly present (an LED panel is never truly black), and a
 * brighter die inside each lit bar so the post chain's bloom threshold catches
 * the emitter rather than the whole glyph.
 * ------------------------------------------------------------------ */

//                     0   1   2   3    4    5    6    7  8    9
const SEG_MASK = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111] as const;

/** Traces one tapered segment bar centred at (cx, cy). */
function segPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  length: number,
  thick: number,
  horizontal: boolean,
): void {
  const half = length * 0.5;
  const t = thick * 0.5;
  ctx.beginPath();
  if (horizontal) {
    ctx.moveTo(cx - half, cy);
    ctx.lineTo(cx - half + t, cy - t);
    ctx.lineTo(cx + half - t, cy - t);
    ctx.lineTo(cx + half, cy);
    ctx.lineTo(cx + half - t, cy + t);
    ctx.lineTo(cx - half + t, cy + t);
  } else {
    ctx.moveTo(cx, cy - half);
    ctx.lineTo(cx + t, cy - half + t);
    ctx.lineTo(cx + t, cy + half - t);
    ctx.lineTo(cx, cy + half);
    ctx.lineTo(cx - t, cy + half - t);
    ctx.lineTo(cx - t, cy - half + t);
  }
  ctx.closePath();
}

interface SegStyle {
  lit: string;
  core: string;
  off: string;
  drawOff: boolean;
}

function drawSeg(
  ctx: CanvasRenderingContext2D,
  on: boolean,
  cx: number,
  cy: number,
  length: number,
  thick: number,
  horizontal: boolean,
  style: SegStyle,
): void {
  if (!on && !style.drawOff) return;
  segPath(ctx, cx, cy, length, thick, horizontal);
  ctx.fillStyle = on ? style.lit : style.off;
  ctx.fill();
  if (on) {
    segPath(ctx, cx, cy, length - thick * 0.9, thick * 0.42, horizontal);
    ctx.fillStyle = style.core;
    ctx.fill();
  }
}

/**
 * Draws one digit inside a (w × h) cell anchored at (x, y). `squash` is a
 * 1-at-rest vertical scale used for the mechanical tick on a value change.
 */
function drawDigit(
  ctx: CanvasRenderingContext2D,
  digit: number,
  x: number,
  y: number,
  w: number,
  h: number,
  style: SegStyle,
  squash: number,
): void {
  const mask = SEG_MASK[digit < 0 ? 0 : digit > 9 ? 9 : digit | 0];
  const thick = Math.max(1.6, h * 0.115);
  const lh = w - thick * 1.15;
  const lv = h * 0.5 - thick * 1.15;

  ctx.save();
  if (squash !== 1) {
    const px = x + w * 0.5;
    const py = y + h * 0.5;
    ctx.translate(px, py);
    ctx.scale(1, squash);
    ctx.translate(-px, -py);
  }

  const cxL = x + thick * 0.55;
  const cxR = x + w - thick * 0.55;
  const cxM = x + w * 0.5;
  const cyT = y + thick * 0.55;
  const cyM = y + h * 0.5;
  const cyB = y + h - thick * 0.55;
  const cyUp = y + h * 0.25 + thick * 0.1;
  const cyDn = y + h * 0.75 - thick * 0.1;

  drawSeg(ctx, (mask & 1) !== 0, cxM, cyT, lh, thick, true, style); // a
  drawSeg(ctx, (mask & 2) !== 0, cxR, cyUp, lv, thick, false, style); // b
  drawSeg(ctx, (mask & 4) !== 0, cxR, cyDn, lv, thick, false, style); // c
  drawSeg(ctx, (mask & 8) !== 0, cxM, cyB, lh, thick, true, style); // d
  drawSeg(ctx, (mask & 16) !== 0, cxL, cyDn, lv, thick, false, style); // e
  drawSeg(ctx, (mask & 32) !== 0, cxL, cyUp, lv, thick, false, style); // f
  drawSeg(ctx, (mask & 64) !== 0, cxM, cyM, lh, thick, true, style); // g

  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * The community chatter corpus
 *
 * Thirty-five lines of in-world chat. The show is a five-minute roadmap
 * hostage situation and the audience has opinions about timelines.
 * ------------------------------------------------------------------ */

const CHATTER: readonly string[] = [
  "wen soon",
  "ser it has been four minutes since the last update",
  "just give us a date. any date. a wrong date.",
  "my patience is proof of nothing",
  "roadmap says Q-soon, which is not a quarter",
  "is 'soon' a unit of time or a lifestyle",
  "asked in january, still vibing",
  "he said soon with such confidence",
  "unmute the chat, i have follow-up questions",
  "op-reth wen? asking for four thousand friends",
  "i named my dog Soon so he is always coming",
  "the veHEMI rewards are in the mail apparently",
  "we are so early it has become embarrassing",
  "can we get a countdown that actually counts down",
  "refreshed the docs forty times today, personal best",
  "someone please check on justin",
  "SOON is not a date chat, i checked",
  "proof of patience: currently unproven",
  "not impatient, just chronologically curious",
  "tell me it ships and i will log off forever",
  "the tunnel has a light and the light says soon",
  "my bags are packed and slowly composting",
  "zkproof? more like zkpromise",
  "day four hundred and twelve of asking nicely",
  "the claim button remains theoretical",
  "ok but WEN though",
  "going to bed, ping me when it ships",
  "patience is a position size",
  "i have read the whitepaper. it was a vibe.",
  "clapping politely into the void",
  "hemi devs typing... for eleven months",
  "VBK when? blink twice if it is this year",
  "i will accept a hand-drawn gantt chart",
  "we do not need a product, we need a timestamp",
  "still here. still soon. still fine. totally fine.",
];

const HANDLES: readonly string[] = [
  "0xPATIENT",
  "wenser",
  "gm_only",
  "hemi_holder",
  "vbk_enjoyer",
  "soon_tm",
  "proofofvibes",
  "op_reth_fan",
  "justin_where",
  "chainsaw_max",
  "tunnelvision",
  "zk_curious",
  "notfinancial",
  "roadmapper",
  "quarterfour",
  "still_early",
  "dev_typing",
  "claim_denied",
  "one_more_sprint",
  "block_by_block",
];

interface TickerItem {
  handle: string;
  text: string;
  handleWidth: number;
  textWidth: number;
  /** Handle + gap + message + trailing separator block. */
  stride: number;
}

/* ------------------------------------------------------------------ *
 * Announcements
 * ------------------------------------------------------------------ */

type Tone = "info" | "good" | "bad" | "alert";

interface ToneStyle {
  kicker: string;
  accent: readonly string[];
  font: string;
  tracking: number;
  /** Entry duration. "bad" is a hard cut and gets almost none. */
  inSeconds: number;
  hazard: boolean;
  sweep: boolean;
  /** Width of the left severity rule. */
  rule: number;
}

const TONE: Record<Tone, ToneStyle> = {
  info: {
    kicker: "PRODUCTION",
    accent: ALU_A,
    font: F_STRAP_SM,
    tracking: 0.5,
    inSeconds: 0.34,
    hazard: false,
    sweep: false,
    rule: 2.4,
  },
  good: {
    kicker: "CONFIRMED",
    accent: HEMI_A,
    font: F_STRAP,
    tracking: 0.6,
    inSeconds: 0.38,
    hazard: false,
    sweep: true,
    rule: 3.2,
  },
  bad: {
    kicker: "FAULT",
    accent: HOT_A,
    font: F_STRAP,
    tracking: 0.7,
    inSeconds: 0.07,
    hazard: false,
    sweep: false,
    rule: 5,
  },
  alert: {
    kicker: "CONTROL ROOM",
    accent: HOT_A,
    font: F_STRAP,
    tracking: 1.1,
    inSeconds: 0.42,
    hazard: true,
    sweep: true,
    rule: 6,
  },
};

interface AnnouncementLayout {
  line: string;
  font: string;
  width: number;
}

interface QueuedAnnouncement {
  text: string;
  tone: Tone;
  hold: number;
}

/* ------------------------------------------------------------------ *
 * Decoration motes — a tiny pooled emitter the overlay owns outright
 * ------------------------------------------------------------------ */

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  hot: number;
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  w: number;
  h: number;
  stageY: number;
  safeL: number;
  safeR: number;
  safeT: number;
  safeB: number;
  clock: Rect;
  /** The patience readout, on the clock's baseline at the other end of the row. */
  streak: Rect;
  /**
   * The gallery graphics channel. One box, three tenants, in priority order:
   * announcement strap → show ident → chat crawl (the resting state).
   */
  channel: Rect;
  /** The crawl strip inside the channel, under its header row. */
  crawl: Rect;
  slateL: Rect;
  slateR: Rect;
}

const CLOCK_W = 198;
const CLOCK_H = 52;
const TICKER_H = 28;
const STREAK_W = 150;
const SLATE_W = 192;
const SLATE_H = 40;
const CHAT_CAP_W = 62;
const END_CAP_W = 24;
/** Header row inside the channel: feed state camera-left, timecode camera-right. */
const CHANNEL_HEAD_H = 20;

/* ------------------------------------------------------------------ *
 * The grid
 *
 * The simulation hands the presentation two guarantees and they are the whole
 * layout: a caller card is spawned below `GALLERY_BAND_H` and removed at
 * `stageY`, so the band above 78 and the band below 548 are the only places in
 * the frame where an opaque graphic can be put without printing over a live
 * caller. Everything else is play field, and the play field belongs to the
 * game.
 *
 * The bottom band is spoken for — the desk is a 524 px-wide object in the
 * middle of it, leaving only the two floor-slate columns outboard of it — so
 * every remaining piece of broadcast furniture has to share the 78 px at the
 * top. That is one row, not two, which is why the crawl, the announcement strap
 * and the show ident are not three plates any more: they are one graphics
 * channel with a priority stack, exactly as a real gallery runs one downstream
 * keyer. The chat state and the timecode ride in that channel's header rather
 * than floating in the picture.
 *
 * Previously the crawl sat at y 456, the lower third at 492 and the slow chip
 * at 85 — all three inside the play field, all three guaranteed to be printed
 * over by a descending caller. Verified against 08-lategame.
 * ------------------------------------------------------------------ */

function computeLayout(w: number, h: number, stageY: number): Layout {
  const mx = Math.round(w * 0.04);
  // 3.5 %: the gallery band is only 78 px deep and the row has to fit inside it
  // with its plate, not just its type.
  const my = Math.round(h * 0.035);
  const safeL = mx;
  const safeR = w - mx;
  const safeT = my;
  const safeB = h - my;

  // The whole top row lives inside the band the simulation keeps clear.
  const rowH = Math.max(38, Math.min(CLOCK_H, GALLERY_BAND_H - safeT - 4));
  const streakW = Math.round(clamp(STREAK_W, 116, (safeR - safeL) * 0.2));
  const clock = { x: safeL, y: safeT, w: CLOCK_W, h: rowH };
  const streak = { x: safeR - streakW, y: safeT, w: streakW, h: rowH };
  const chanX = Math.round(clock.x + clock.w + 14);
  const chanW = Math.max(200, Math.round(streak.x - 14 - chanX));

  return {
    w,
    h,
    stageY,
    safeL,
    safeR,
    safeT,
    safeB,
    clock,
    streak,
    channel: { x: chanX, y: safeT, w: chanW, h: rowH },
    // The crawl is a trough sunk into the channel plate, not a plate of its own.
    crawl: {
      x: chanX + 4,
      y: safeT + Math.max(CHANNEL_HEAD_H, rowH - TICKER_H - 4),
      w: chanW - 8,
      h: Math.min(TICKER_H, rowH - CHANNEL_HEAD_H),
    },
    slateL: { x: safeL, y: Math.round(stageY + 6), w: SLATE_W, h: SLATE_H },
    slateR: { x: safeR - SLATE_W, y: Math.round(stageY + 6), w: SLATE_W, h: SLATE_H },
  };
}

/** Round-time marks at which the gallery re-identifies the show. */
const IDENT_STOPS = [110, 215] as const;
const LOWER_IN = 0.92;
const LOWER_OUT = 0.5;
const STATIC_DWELL = 5.5;
const STATIC_FADE = 0.45;

/* ------------------------------------------------------------------ *
 * The renderer
 * ------------------------------------------------------------------ */

export function createOverlayRenderer(deps: RenderDeps): OverlayRenderer {
  const { rng, noise, bakery, camera } = deps;

  /* -- deterministic decoration ---------------------------------- */
  const decorRng = rng.fork(0x0de7);
  const tickerRng = rng.fork(0x71c4);
  const moteRng = rng.fork(0x30de);

  /* -- frame state ----------------------------------------------- */
  let layout = computeLayout(1000, 620, 548);
  let quality: QualityTier = "high";
  let tier = TIERS.high;
  let reduced = false;
  let time = 0;
  let flashLift = 0;

  /* -- baked art ------------------------------------------------- */
  const panels = new Map<number, Panel | null>();
  let bakeK = 0;
  let artQuality: QualityTier | null = null;
  let clockPlate: Surface | null = null;
  let slateLeft: Surface | null = null;
  let slateRight: Surface | null = null;
  let tickerChrome: Surface | null = null;
  let chatCap: Surface | null = null;
  let endCap: Surface | null = null;
  let sweepBone: Surface | null = null;
  let sweepHemi: Surface | null = null;
  let tickerBuffer: Surface | null = null;
  let tickerChromeW = 0;
  let tickerFadeLeft: CanvasGradient | null = null;
  let tickerFadeRight: CanvasGradient | null = null;

  /* -- countdown ------------------------------------------------- */
  const digitPulses: Pulse[] = [
    createPulse(420, 22),
    createPulse(420, 22),
    createPulse(420, 22),
    createPulse(420, 22),
  ];
  const secondPulse = createPulse(260, 17);
  const lastDigits = [-1, -1, -1, -1];
  let lastWholeSecond = -1;
  let roundLength = 300;
  let urgency = 0;
  /** Time the numerals last showed; seeded high so frame 1 is never hot. */
  let timeShown = 1e9;

  /* -- patience readout ------------------------------------------ */
  const comboPop = createPulse(520, 19);
  const comboLevel: Spring = createSpring({ stiffness: 120, damping: 20 });
  let lastCombo = 0;
  let comboShake = 0;
  let comboSweep = 2;
  let tierIndex = 0;
  let lastTierIndex = 0;

  /* -- score bug ------------------------------------------------- */
  const scorePop = createPulse(460, 21);
  let scoreShown = 0;
  let lastScore = 0;
  let deltaValue = 0;
  let deltaAge = 99;

  /* -- announcements --------------------------------------------- */
  const queue: QueuedAnnouncement[] = [];
  const announceLayouts = new Map<string, AnnouncementLayout>();
  let active: QueuedAnnouncement | null = null;
  let activeLayout: AnnouncementLayout | null = null;
  let annPhase: "off" | "in" | "hold" | "out" = "off";
  let annT = 0;
  let annHold = 0;
  let annShudder = 0;
  let lastExternal = "";
  let lastExternalAge = 0;
  /** The line the simulation currently has raised, if the gallery took it. */
  let externalLine = "";

  /* -- lower third ----------------------------------------------- */
  let lowerPhase: "off" | "in" | "hold" | "out" = "off";
  let lowerT = 0;
  let lowerHold = 0;
  let lowerStatus = "LIVE · CHAT UNMUTED";
  let identStop = 0;
  let lastPhase: ScenePhase = "idle";

  /* -- slow mode ------------------------------------------------- */
  const slowVis: Spring = createSpring({ stiffness: 190, damping: 22 });
  let slowWindow = 1;
  let lastSlowSeconds = 0;

  /* -- ticker ---------------------------------------------------- */
  let items: TickerItem[] = [];
  let head = 0;
  let headX = CHAT_CAP_W;
  let tickerReady = false;
  let staticIndex = 0;
  let staticT = STATIC_FADE;

  /* -- motes ----------------------------------------------------- */
  const motes: Mote[] = [];
  let moteCount = 0;

  /* ================================================================ *
   * Art lifecycle
   * ================================================================ */

  function devicePixelScale(): number {
    const g = globalThis as { devicePixelRatio?: number };
    return typeof g.devicePixelRatio === "number" && g.devicePixelRatio > 0 ? g.devicePixelRatio : 1;
  }

  function ensureArt(): void {
    const k = clamp(tier.bake * clamp(devicePixelScale(), 1, 2), 1, 3);
    if (artQuality === quality && bakeK === k) return;
    artQuality = quality;
    bakeK = k;
    panels.clear();
    clockPlate = bakeClockPlate(CLOCK_W, CLOCK_H, k, tier, bakery, decorRng);
    slateLeft = bakeSlate(SLATE_W, SLATE_H, k, tier, bakery, false, ["PATIENCE POINTS", ""]);
    slateRight = bakeSlate(SLATE_W, SLATE_H, k, tier, bakery, true, ["ACTIVE CALLERS", "SEGMENT"]);
    chatCap = bakeChatCap(CHAT_CAP_W, TICKER_H, k, tier);
    endCap = bakeEndCap(END_CAP_W, TICKER_H, k);
    sweepBone = bakeSweep(k, BONE);
    sweepHemi = bakeSweep(k, HEMI);
    tickerChromeW = 0;
    tickerBuffer = null;
    tickerFadeLeft = null;
    tickerFadeRight = null;
  }

  function panelFor(h: number): Panel | null {
    const key = Math.round(h);
    const hit = panels.get(key);
    if (hit !== undefined) return hit;
    const made = bakePanel(key, bakeK, tier, bakery, noise);
    panels.set(key, made);
    return made;
  }

  function ensureTickerSurfaces(): void {
    const w = Math.round(layout.crawl.w);
    if (tickerChromeW === w && tickerBuffer) return;
    tickerChromeW = w;
    tickerChrome = bakeTickerChrome(w, TICKER_H, bakeK, tier, bakery);
    tickerBuffer = createSurface(w, TICKER_H, bakeK);
    tickerFadeLeft = null;
    tickerFadeRight = null;
    if (tickerBuffer) {
      const c = tickerBuffer.ctx;
      const l = c.createLinearGradient(CHAT_CAP_W, 0, CHAT_CAP_W + 30, 0);
      l.addColorStop(0, "rgba(0,0,0,1)");
      l.addColorStop(1, "rgba(0,0,0,0)");
      tickerFadeLeft = l;
      const r = c.createLinearGradient(w - END_CAP_W - 40, 0, w - END_CAP_W, 0);
      r.addColorStop(0, "rgba(0,0,0,0)");
      r.addColorStop(1, "rgba(0,0,0,1)");
      tickerFadeRight = r;
    }
  }

  /**
   * Builds the crawl once: pairs every chatter line with a handle, measures
   * both halves and precomputes the stride. After this the crawl never
   * measures anything again, however long the show runs.
   */
  function ensureTicker(ctx: CanvasRenderingContext2D): void {
    if (tickerReady) return;
    tickerReady = true;
    const order: number[] = [];
    for (let i = 0; i < CHATTER.length; i++) order.push(i);
    // Deterministic Fisher-Yates, so the crawl is not authoring order.
    for (let i = order.length - 1; i > 0; i--) {
      const j = tickerRng.int(0, i);
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    items = order.map((idx) => {
      const handle = HANDLES[tickerRng.int(0, HANDLES.length - 1)];
      const text = CHATTER[idx];
      // Both halves draw in a single fillText each: at eight visible items a
      // per-character layout would cost ~200 text draws a frame for nothing —
      // monospaced type already carries its own tracking.
      const hw = textWidth(ctx, F_HANDLE, handle);
      const tw = textWidth(ctx, F_CHAT, text);
      return { handle, text, handleWidth: hw, textWidth: tw, stride: hw + 11 + tw + 30 };
    });
    head = 0;
    headX = CHAT_CAP_W;
  }

  /* ================================================================ *
   * Announcement queue
   * ================================================================ */

  function layoutAnnouncement(
    ctx: CanvasRenderingContext2D,
    text: string,
    tone: Tone,
  ): AnnouncementLayout {
    const key = tone + "|" + text;
    const hit = announceLayouts.get(key);
    if (hit) return hit;

    const style = TONE[tone];
    // One line, always: the strap fills the channel, and the channel may not
    // grow out of the gallery band. Condensed to fit, ellipsised at the floor.
    const maxW = layout.channel.w - (style.hazard ? 84 : 60);
    const fit = fitRun(ctx, style.font, text, style.tracking, maxW, 0.68);
    const made: AnnouncementLayout = { line: fit.text, font: fit.font, width: fit.width };
    if (announceLayouts.size > 240) announceLayouts.clear();
    announceLayouts.set(key, made);
    return made;
  }

  function enqueue(text: string, tone: Tone, seconds: number): void {
    const clean = text.trim();
    if (clean.length === 0) return;
    // Never let the same line stack up behind itself.
    if (active && active.text === clean && annPhase !== "out") return;
    for (const q of queue) if (q.text === clean && q.tone === tone) return;
    queue.push({ text: clean, tone, hold: clamp(seconds, 0.6, 12) });
    // Bounded: drop the oldest low-priority item rather than the newest signal.
    while (queue.length > 5) {
      let drop = 0;
      for (let i = 0; i < queue.length - 1; i++) {
        if (queue[i].tone === "info") {
          drop = i;
          break;
        }
      }
      queue.splice(drop, 1);
    }
  }

  /**
   * Takes the simulation's line off air the instant the simulation drops it.
   *
   * The strap's own in/hold/out runs on rendered frames, which is right for the
   * animation and wrong for the expiry: a fast-forward, a stalled tab or a
   * phase change moves the game on without moving those frames, and the gallery
   * was left holding a card the show had finished with. 06-midgame still read
   * "MWM COMMUNITY TAKEOVER BEGINS IN 3…" at 2:46 remaining, 132 s after the
   * simulation had retired it. Expiry now belongs to the simulation clock; only
   * the animation belongs to the frame clock.
   */
  function retireExternal(): void {
    if (externalLine.length === 0) return;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].text === externalLine) queue.splice(i, 1);
    }
    if (active && active.text === externalLine && annPhase !== "out") {
      annPhase = "out";
      annT = 0;
    }
    externalLine = "";
  }

  function advanceAnnouncement(dt: number): void {
    annShudder = Math.max(0, annShudder - dt * 5.5);
    if (annPhase === "off") {
      const next = queue.shift();
      if (next) {
        active = next;
        activeLayout = null;
        annPhase = "in";
        annT = 0;
        // A backed-up queue drains faster; the gallery does not dwell.
        annHold = next.hold * (queue.length >= 2 ? 0.62 : queue.length >= 1 ? 0.82 : 1);
        if ((next.tone === "bad" || next.tone === "alert") && !reduced) annShudder = 1;
      }
      return;
    }
    annT += dt;
    if (annPhase === "in") {
      const style = active ? TONE[active.tone] : TONE.info;
      if (annT >= style.inSeconds) {
        annPhase = "hold";
        annT = 0;
      }
    } else if (annPhase === "hold") {
      if (annT >= annHold) {
        annPhase = "out";
        annT = 0;
      }
    } else if (annT >= 0.3) {
      annPhase = "off";
      annT = 0;
      active = null;
      activeLayout = null;
    }
  }

  /* ================================================================ *
   * Lower third scheduling
   * ================================================================ */

  function showLowerThird(hold: number): void {
    if (lowerPhase === "in" || lowerPhase === "hold") {
      lowerHold = Math.max(lowerHold, hold);
      return;
    }
    lowerPhase = "in";
    lowerT = 0;
    lowerHold = hold;
  }

  function advanceLowerThird(dt: number): void {
    if (lowerPhase === "off") return;
    lowerT += dt;
    if (lowerPhase === "in" && lowerT >= LOWER_IN) {
      lowerPhase = "hold";
      lowerT = 0;
    } else if (lowerPhase === "hold" && lowerT >= lowerHold) {
      lowerPhase = "out";
      lowerT = 0;
    } else if (lowerPhase === "out" && lowerT >= LOWER_OUT) {
      lowerPhase = "off";
      lowerT = 0;
    }
  }

  /* ================================================================ *
   * Motes
   * ================================================================ */

  function emitMotes(x: number, y: number, count: number, hot: number): void {
    const cap = tier.motes;
    if (cap === 0) return;
    // Reduced motion keeps the beat but drops ~70 % of the population.
    const n = Math.round(count * (reduced ? 0.3 : 1));
    for (let i = 0; i < n && moteCount < cap; i++) {
      const a = moteRng.range(-2.5, -0.7);
      const speed = moteRng.range(14, 52) * (reduced ? 0.6 : 1);
      const m: Mote = {
        x: x + moteRng.range(-9, 9),
        y: y + moteRng.range(-5, 5),
        vx: Math.cos(a) * speed * 0.5 + moteRng.range(-10, 10),
        vy: Math.sin(a) * speed,
        life: 0,
        maxLife: moteRng.range(0.35, 0.9),
        size: moteRng.range(0.9, 2.1),
        hot,
      };
      if (moteCount < motes.length) motes[moteCount] = m;
      else motes.push(m);
      moteCount++;
    }
  }

  function updateMotes(dt: number): void {
    for (let i = 0; i < moteCount; i++) {
      const m = motes[i];
      m.life += dt;
      if (m.life >= m.maxLife) {
        // Swap-remove keeps the pool dense with no allocation.
        motes[i] = motes[moteCount - 1];
        motes[moteCount - 1] = m;
        moteCount--;
        i--;
        continue;
      }
      m.vy += 26 * dt; // embers rise, stall, then fall back
      m.vx *= 1 - 1.6 * dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
    }
  }

  function drawMotes(ctx: CanvasRenderingContext2D): void {
    if (moteCount === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < moteCount; i++) {
      const m = motes[i];
      const t = m.life / m.maxLife;
      const a = (1 - t) * (1 - t) * 0.85;
      ctx.fillStyle = m.hot > 0.5 ? aa(HOT_A, a) : aa(BONE_A, a * 0.8);
      const s = m.size * (1 - t * 0.4);
      ctx.fillRect(m.x - s * 0.5, m.y - s * 0.5, s, s * 1.7);
    }
    ctx.restore();
  }

  /* ================================================================ *
   * Scene and state synchronisation
   * ================================================================ */

  function applyScene(scene: SceneContext): void {
    time = scene.rawTime;
    reduced = scene.reducedMotion;
    if (scene.quality !== quality) {
      quality = scene.quality;
      tier = TIERS[quality];
    }
    if (scene.width !== layout.w || scene.height !== layout.h || scene.stageY !== layout.stageY) {
      layout = computeLayout(scene.width, scene.height, scene.stageY);
      // Strap wrapping is a function of the safe width, so its cache is stale.
      announceLayouts.clear();
      activeLayout = null;
      tickerChromeW = 0;
      tickerBuffer = null;
    }
  }

  function comboTierOf(combo: number): number {
    return combo >= 9 ? 3 : combo >= 6 ? 2 : combo >= 3 ? 1 : 0;
  }

  /** M:SS (or MM:SS) split into four slots; slot 0 is unused below ten minutes. */
  const digitScratch = [0, 0, 0, 0];
  function clockDigits(seconds: number): number[] {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    digitScratch[0] = Math.floor(m / 10) % 10;
    digitScratch[1] = m % 10;
    digitScratch[2] = Math.floor(r / 10);
    digitScratch[3] = r % 10;
    return digitScratch;
  }

  function syncState(state: OverlayState, scene: SceneContext): void {
    /* Round length is inferred from the largest remaining time ever seen, so
       the drain arc is correct without the overlay knowing the game rules. */
    if (state.timeRemaining > roundLength) roundLength = state.timeRemaining;

    /* Countdown: the tick fires on the boundary the numerals actually cross. */
    const whole = Math.ceil(Math.max(0, state.timeRemaining));
    if (whole !== lastWholeSecond) {
      const digits = clockDigits(state.timeRemaining);
      if (lastWholeSecond >= 0 && whole < lastWholeSecond) {
        secondPulse.fire(1);
        for (let i = 0; i < 4; i++) if (digits[i] !== lastDigits[i]) digitPulses[i].fire(1);
      }
      for (let i = 0; i < 4; i++) lastDigits[i] = digits[i];
      lastWholeSecond = whole;
    }
    timeShown = state.timeRemaining;

    /* Patience streak. */
    if (state.combo !== lastCombo) {
      if (state.combo > lastCombo) {
        comboPop.fire(1);
        comboSweep = 0;
        if (!reduced) comboShake = Math.min(1, 0.35 + state.combo * 0.06);
        const idx = comboTierOf(state.combo);
        if (idx > lastTierIndex) {
          const s = layout.streak;
          emitMotes(s.x + s.w - 42, s.y + 34, 6 + idx * 4, idx >= 2 ? 1 : 0);
        }
        lastTierIndex = idx;
      } else {
        lastTierIndex = comboTierOf(state.combo);
      }
      lastCombo = state.combo;
    }
    tierIndex = comboTierOf(state.combo);
    comboLevel.set(tierIndex);

    /* Score. */
    if (state.score !== lastScore) {
      if (state.score > lastScore) {
        deltaValue = state.score - lastScore;
        deltaAge = 0;
        scorePop.fire(1);
      }
      lastScore = state.score;
    }

    /* Slow mode: remember the window so the bar drains over the real span. */
    if (state.slowSeconds > lastSlowSeconds + 0.05) slowWindow = Math.max(state.slowSeconds, 0.5);
    lastSlowSeconds = state.slowSeconds;
    slowVis.set(state.slowSeconds > 0 ? 1 : 0);

    /* Announcements pushed through OverlayState rather than announce(). A
       restarted age with unchanged text means the game re-fired the same line. */
    const external = state.announcement ?? "";
    if (external.length > 0) {
      const restarted = state.announcementAge < lastExternalAge - 0.001;
      if (external !== lastExternal || restarted) {
        if (externalLine !== external) retireExternal();
        enqueue(external, state.announcementTone, 2.6);
        lastExternal = external;
        externalLine = external;
      }
      lastExternalAge = state.announcementAge;
    } else {
      lastExternal = "";
      lastExternalAge = 0;
      // Nothing is being announced: the channel drops back to its resting
      // state — the chat crawl — rather than holding the last card it was given.
      retireExternal();
    }

    /* Lower-third scheduling: identify at the top of the show, re-identify a
       couple of times mid-round, and sign off on the result. */
    if (scene.phase !== lastPhase) {
      if (scene.phase === "playing") {
        identStop = 0;
        roundLength = Math.max(1, state.timeRemaining);
        // Same rule as the mid-round marks: identify at the top of the show,
        // not the first time a frame is drawn after the show has moved on.
        if (scene.elapsed <= LOWER_IN + 7 + LOWER_OUT) showLowerThird(7);
      } else if (scene.phase === "won" || scene.phase === "lost") {
        showLowerThird(6);
      }
      lastPhase = scene.phase;
    }
    if (scene.phase === "playing") {
      while (identStop < IDENT_STOPS.length && scene.elapsed >= IDENT_STOPS[identStop]) {
        const stop = IDENT_STOPS[identStop];
        identStop++;
        // Only if the mark is still live. A fast-forward, a stalled tab or a
        // restored session can hand the gallery a cue that expired minutes ago,
        // and re-running it then is what caught the ident mid type-on at t=135
        // in 06-midgame. A missed cue is dropped, never replayed late.
        if (scene.elapsed - stop <= LOWER_IN + 4.2 + LOWER_OUT) showLowerThird(4.2);
      }
    }

    lowerStatus =
      scene.phase === "won"
        ? "SEGMENT CLEARED · CHAT SATISFIED"
        : scene.phase === "lost"
          ? "SEGMENT LOST · CHAT UNCONVINCED"
          : state.slowSeconds > 0
            ? "SLOW MODE ENGAGED"
            : state.timeRemaining <= 30
              ? "FINAL SECONDS · STAY WITH IT"
              : state.activeQuestions >= 3
                ? "QUEUE BACKED UP"
                : "LIVE · CHAT UNMUTED";
  }

  /* ================================================================ *
   * Module: countdown clock
   * ================================================================ */

  function drawClock(ctx: CanvasRenderingContext2D, state: OverlayState): void {
    const r = layout.clock;
    if (clockPlate) blit(ctx, clockPlate, r.x, r.y);
    else {
      ctx.fillStyle = aa(INK_A, 0.85);
      roundRect(ctx, r.x, r.y, r.w, r.h, 4);
      ctx.fill();
    }

    const remaining = Math.max(0, state.timeRemaining);
    const hot = urgency;
    const pulse = clamp01(secondPulse.value);
    const litIndex = heatIndex(hot * 0.85 + pulse * 0.12);
    const lit = HEAT[litIndex];
    const core = hot > 0.02 ? HEAT_CORE[litIndex] : BONE;
    const finalWindow = remaining <= 30;

    /* --- drain dial ------------------------------------------------
       Above 30 s it reads the whole round in aluminium; under 30 s it
       switches to the final window, goes hot and visibly races. */
    const dialX = r.x + 24;
    const dialY = r.y + r.h * 0.5;
    const dialR = 14.5;
    const frac = finalWindow
      ? clamp01(remaining / 30)
      : clamp01(roundLength > 0 ? remaining / roundLength : 0);

    ctx.save();
    ctx.lineCap = "butt";
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = aa(ALU_DARK_A, 0.55);
    ctx.beginPath();
    ctx.arc(dialX, dialY, dialR, 0, TAU);
    ctx.stroke();

    ctx.lineWidth = finalWindow ? 3.1 : 2.6;
    ctx.strokeStyle = finalWindow ? heat(0.55 + hot * 0.45) : aa(ALU_A, 0.8);
    ctx.beginPath();
    ctx.arc(dialX, dialY, dialR, -Math.PI * 0.5, -Math.PI * 0.5 + TAU * frac);
    ctx.stroke();

    // Per-second pulse: a real ring that expands and dies, not a glow blob.
    if (finalWindow && pulse > 0.01) {
      ctx.lineWidth = 1.4 * pulse;
      ctx.strokeStyle = aa(HOT_A, pulse * 0.7);
      ctx.beginPath();
      ctx.arc(dialX, dialY, dialR + 2 + (1 - pulse) * 9, 0, TAU);
      ctx.stroke();
    }

    // Sweep tip — a genuine highlight for the bloom pass to find.
    const tip = -Math.PI * 0.5 + TAU * frac;
    ctx.fillStyle = finalWindow ? aa(HOT_A, 0.95) : aa(BONE_A, 0.75);
    ctx.beginPath();
    ctx.arc(dialX + Math.cos(tip) * dialR, dialY + Math.sin(tip) * dialR, finalWindow ? 2.1 : 1.5, 0, TAU);
    ctx.fill();
    ctx.restore();

    /* --- numerals ------------------------------------------------- */
    const digits = clockDigits(remaining);
    const twoDigitMinutes = digits[0] > 0;
    const cellH = 24;
    const cellW = 13.5;
    const gap = 3.2;
    const colonW = 7;
    /* Cells, not gaps: the group is `n` digit cells, `n − 1` gaps between them,
       and the colon column. The old expression counted one cell too few — 38.5
       px for a group that lays out at 55.2 — so the seconds digit was drawn
       3.7 px off the right edge of its own plate on every frame of every
       capture. Measured on 08-lategame: plate ends at x 238, glyph at 242. */
    const cells = twoDigitMinutes ? 4 : 3;
    const groupW = cells * cellW + (cells - 1) * gap + colonW + gap * 0.4;
    let cx = r.x + r.w - 13 - groupW;
    const cy = r.y + r.h * 0.5 - cellH * 0.5 + 1.5;

    const style: SegStyle = {
      lit,
      core,
      off: aa(BONE_A, 0.045 + hot * 0.02),
      drawOff: tier.ghostSegments,
    };

    for (let i = twoDigitMinutes ? 0 : 1; i < 4; i++) {
      if (i === 2) {
        // Colon blinks on the second: 1 Hz, well under the flash ceiling.
        const sub = remaining - Math.floor(remaining);
        const on = reduced || remaining <= 0 || sub > 0.5;
        ctx.fillStyle = on ? lit : aa(BONE_A, 0.06);
        const dot = 2.6;
        ctx.fillRect(cx + colonW * 0.5 - dot * 0.5, cy + cellH * 0.3 - dot * 0.5, dot, dot);
        ctx.fillRect(cx + colonW * 0.5 - dot * 0.5, cy + cellH * 0.7 - dot * 0.5, dot, dot);
        cx += colonW + gap * 0.4;
      }
      drawDigit(ctx, digits[i], cx, cy, cellW, cellH, style, 1 - clamp01(digitPulses[i].value) * 0.16);
      cx += cellW + gap;
    }

    /* --- labels and drain bar ------------------------------------- */
    ctx.fillStyle = finalWindow ? heat(0.5 + hot * 0.5) : aa(ALU_A, 0.72);
    fillMono(ctx, F_KICKER, finalWindow ? "FINAL SECONDS" : "TIME REMAINING", r.x + 44, r.y + 15, 1.7, -1);

    // Redundant with the dial on purpose: broadcast clocks over-communicate.
    const barX = r.x + 44;
    const barW = r.w - 58;
    ctx.fillStyle = aa(INK_A, 0.6);
    ctx.fillRect(barX, r.y + 19.5, barW, 1.6);
    ctx.fillStyle = finalWindow ? heat(0.6 + hot * 0.4) : aa(ALU_A, 0.5);
    ctx.fillRect(barX, r.y + 19.5, barW * frac, 1.6);
    if (finalWindow) {
      ctx.fillStyle = aa(WHITE_A, 0.5 * pulse);
      ctx.fillRect(barX + barW * frac - 1.5, r.y + 19, 3, 2.6);
    }

    // Under 30 s the housing itself gains a hot rim, motivated by the display.
    if (hot > 0.01) {
      ctx.strokeStyle = aa(HOT_A, 0.18 * hot + 0.16 * hot * pulse);
      ctx.lineWidth = 1.2;
      roundRect(ctx, r.x + 0.6, r.y + 0.6, r.w - 1.2, r.h - 1.2, 4);
      ctx.stroke();
    }

    // A scene flash lifts every hairline in the package by a hair.
    if (flashLift > 0.01) {
      ctx.fillStyle = aa(BONE_A, flashLift * 0.25);
      ctx.fillRect(r.x + 1, r.y + 0.5, r.w - 2, 0.9);
    }
  }

  /* ================================================================ *
   * Module: patience readout
   * ================================================================ */

  function drawCombo(ctx: CanvasRenderingContext2D, state: OverlayState): void {
    const r = layout.streak;
    const right = r.x + r.w - 12;
    const level = clamp(comboLevel.value, 0, 3);
    const pop = clamp01(comboPop.value);
    const shakeX = comboShake > 0 ? Math.sin(time * 62) * comboShake * 3.4 : 0;
    const push = level / 3;

    ctx.save();
    ctx.translate(shakeX, 0);

    /* --- the plate -------------------------------------------------
       The label used to be aluminium at 0.7 alpha printed straight onto the
       truss, which is why "PATIENCE STREAK" measured all but invisible on 06
       while its own value sat next to it at 21 px. It is the same smoked-glass
       slab the rest of the kit is built on now, so the type has a ground to be
       legible against and the readout reads as one object. */
    const panel = panelFor(r.h);
    if (panel) drawPanel(ctx, panel, r.x, r.y, r.w);
    else {
      ctx.fillStyle = aa(INK_A, 0.88);
      chamferRect(ctx, r.x, r.y, r.w, r.h, 9);
      ctx.fill();
    }
    ctx.fillStyle = aa(HEMI_A, tierIndex >= 1 ? 0.95 : 0.7);
    ctx.fillRect(r.x, r.y, 2.4, r.h);
    ctx.fillStyle = aa(HOT_A, 0.55);
    ctx.fillRect(r.x, r.y, 2.4, r.h * 0.34);

    /* --- label ------------------------------------------------------ */
    const kicker = fitRun(ctx, F_KICKER, "PATIENCE STREAK", 1.8, r.w - 24);
    ctx.fillStyle = aa(BONE_A, 0.92);
    fillFitted(ctx, kicker, r.x + 12, r.y + 14, 1.8, -1);
    ctx.fillStyle = aa(BONE_A, 0.13);
    ctx.fillRect(r.x + 12, r.y + 18, r.w - 24, 1);

    /* --- the multiplier -------------------------------------------
       The face is quantised to four sizes so the metric cache can never
       grow; the smooth tier ramp and the pop are a transform. */
    const numeral = "×" + Math.max(1, state.combo);
    const baseFont = COMBO_FONTS[tierIndex];
    const baseSize = COMBO_SIZES[tierIndex];
    // Ceiling comes from the plate, not from taste: the numeral's cap has to
    // clear the label rule above it and its bracket has to stay on the slab.
    const room = (r.h - 22) * 0.94;
    const targetSize = Math.min(room, lerp(COMBO_SIZES[0], COMBO_SIZES[3], smoothstep(push)));
    const scale = (targetSize / baseSize) * (1 + pop * 0.09);
    const baseW = trackedWidth(ctx, baseFont, numeral, 0.5);
    const numW = baseW * scale;
    const numH = targetSize * (1 + pop * 0.09);
    const baseY = r.y + r.h - 7;

    // Brackets appear at tier 2 and close in as the streak climbs.
    if (tierIndex >= 2) {
      const inset = lerp(8, 4, push);
      const bx0 = right - numW - inset - 7;
      const bx1 = right + 7;
      const by0 = baseY - numH * 0.82;
      const by1 = baseY + numH * 0.2;
      ctx.strokeStyle = aa(HEMI_A, 0.55 + 0.3 * push);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(bx0 + 6, by0);
      ctx.lineTo(bx0, by0);
      ctx.lineTo(bx0, by1);
      ctx.lineTo(bx0 + 6, by1);
      ctx.moveTo(bx1 - 6, by0);
      ctx.lineTo(bx1, by0);
      ctx.lineTo(bx1, by1);
      ctx.lineTo(bx1 - 6, by1);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(right, baseY);
    ctx.scale(scale, scale);
    if (tier.textGhost) {
      ctx.fillStyle = aa(INK_A, 0.55);
      fillTracked(ctx, baseFont, numeral, 1, 1.2, 0.5, 1);
    }
    ctx.fillStyle = tierIndex >= 2 ? heat(0.45 + push * 0.55) : BONE;
    fillTracked(ctx, baseFont, numeral, 0, 0, 0.5, 1);
    // Tier 3 earns a hot rim on the numeral: a hairline, not a halo.
    if (tierIndex >= 3) {
      ctx.strokeStyle = aa(HOT_A, 0.5 + 0.3 * Math.sin(time * 4));
      ctx.lineWidth = 0.9 / scale;
      strokeTracked(ctx, baseFont, numeral, 0, 0, 0.5, 1);
    }
    ctx.restore();

    // Specular sweep across the numeral on each increment.
    if (tier.sweeps && sweepBone && comboSweep < 1) {
      const p = ease.outQuad(comboSweep);
      const sheet = tierIndex >= 2 && sweepHemi ? sweepHemi : sweepBone;
      ctx.save();
      ctx.beginPath();
      ctx.rect(right - numW - 4, baseY - numH * 0.82, numW + 8, numH * 1.02);
      ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (1 - comboSweep) * 0.75;
      const sw = numW + 40;
      ctx.drawImage(sheet.canvas, right - numW - 20 + p * (sw + 20) - sw, baseY - numH * 0.9, sw, numH * 1.2);
      ctx.restore();
    }

    /* --- tier badge -------------------------------------------------
       Fitted to whatever the numeral has left it, so a long tier name can
       never run under the multiplier. */
    const badgeMax = Math.max(24, right - numW - 12 - (r.x + 12));
    const badge = fitRun(ctx, F_TIER, state.comboTier, 1.5, badgeMax);
    const badgeY = r.y + 34;
    if (tierIndex >= 3) {
      // ZEN MODE: a filled hemi slab with knockout type.
      const bw = badge.width + 14;
      ctx.fillStyle = heat(0.35 + 0.25 * Math.sin(time * 3.1));
      chamferRect(ctx, r.x + 12, badgeY - 8.6, bw, 12, 4);
      ctx.fill();
      ctx.fillStyle = aa(WHITE_A, 0.45);
      ctx.fillRect(r.x + 12, badgeY - 8.6, bw, 0.9);
      ctx.fillStyle = CHARCOAL;
      fillFitted(ctx, badge, r.x + 19, badgeY, 1.5, -1);
    } else {
      ctx.fillStyle = tierIndex >= 1 ? aa(HEMI_A, 0.92) : aa(BONE_A, 0.7);
      fillFitted(ctx, badge, r.x + 12, badgeY, 1.5, -1);
      if (tierIndex >= 1) {
        ctx.fillStyle = aa(HEMI_A, 0.45);
        ctx.fillRect(r.x + 12, badgeY + 2.8, badge.width, 1);
      }
    }

    /* --- pips: a hardware tally of the streak ---------------------- */
    const pips = 9;
    const pipGap = 2;
    const pipW = 4;
    const px = r.x + 12;
    const py = r.y + r.h - 10;
    for (let i = 0; i < pips; i++) {
      const on = state.combo > i;
      const x = px + i * (pipW + pipGap);
      ctx.fillStyle = on
        ? i >= 8
          ? aa(HOT_A, 0.95)
          : i >= 5
            ? aa(HEMI_A, 0.9)
            : aa(BONE_A, 0.85)
        : aa(BONE_A, 0.13);
      // Parallelograms, so the tally reads as a meter and not as checkboxes.
      ctx.beginPath();
      ctx.moveTo(x + 1.4, py);
      ctx.lineTo(x + pipW, py);
      ctx.lineTo(x + pipW - 1.4, py + 4.6);
      ctx.lineTo(x, py + 4.6);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /* ================================================================ *
   * Module: announcement strap
   * ================================================================ */

  function drawAnnouncement(ctx: CanvasRenderingContext2D): void {
    if (!active || annPhase === "off") return;
    const tone = active.tone;
    const style = TONE[tone];
    if (!activeLayout) activeLayout = layoutAnnouncement(ctx, active.text, tone);
    const lay = activeLayout;

    // The strap *is* the channel: same box every time, so a takeover reads as
    // one graphic changing rather than a second plate arriving on top of the
    // first. The channel lives wholly inside the gallery band, which the
    // simulation guarantees no caller can enter.
    const ch = layout.channel;
    const h = ch.h;
    const textX = style.rule + (style.hazard ? 42 : 16);
    const w = ch.w;
    const x = ch.x;
    const y = ch.y;

    /* --- entry and exit ------------------------------------------- */
    let reveal = 1;
    let slide = 0;
    let alpha = 1;
    let cut = 0;
    if (annPhase === "in") {
      const p = clamp01(annT / style.inSeconds);
      if (tone === "bad") {
        // Hard cut: full width on frame one, no ease, a flashed plate instead.
        cut = 1 - p;
      } else {
        reveal = ease.outQuint(p);
        slide = (1 - reveal) * -9;
        alpha = smoothstep(0, 0.45, p);
      }
    } else if (annPhase === "out") {
      const p = ease.inQuad(clamp01(annT / 0.3));
      slide = p * -7;
      alpha = 1 - p;
    }

    const shudder = annShudder > 0 ? Math.round(Math.sin(time * 95) * annShudder * 2.2) : 0;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x + shudder, y + slide);

    // The wipe: everything is clipped to the growing plate.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-1, -2, w * reveal + 1, h + 4);
    ctx.clip();

    const panel = panelFor(h);
    if (panel) drawPanel(ctx, panel, 0, 0, w);
    else {
      ctx.fillStyle = aa(INK_A, 0.88);
      chamferRect(ctx, 0, 0, w, h, 9);
      ctx.fill();
    }

    /* --- tone furniture ------------------------------------------- */
    ctx.fillStyle = aa(style.accent, 0.95);
    ctx.fillRect(0, 0, style.rule, h);
    if (tone !== "info") {
      ctx.fillStyle = aa(WHITE_A, 0.35);
      ctx.fillRect(0, 0, style.rule, 1.2);
    }

    if (tone === "bad") {
      // Warning rule: a hard top bar plus a hatched shoulder along the base.
      ctx.fillStyle = aa(HOT_A, 0.9);
      ctx.fillRect(0, 0, w, 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(style.rule, h - 4, w - style.rule, 4);
      ctx.clip();
      ctx.fillStyle = aa(HOT_A, 0.5);
      for (let d = -8; d < w + 8; d += 10) {
        ctx.beginPath();
        ctx.moveTo(d, h - 4);
        ctx.lineTo(d + 4, h - 4);
        ctx.lineTo(d, h);
        ctx.lineTo(d - 4, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    if (style.hazard) {
      // Hazard motif: diagonal stripes in the leading cap, drifting slowly.
      const capW = 28;
      const drift = reduced ? 0 : (time * 22) % 14;
      ctx.save();
      ctx.beginPath();
      ctx.rect(style.rule, 0, capW, h);
      ctx.clip();
      ctx.fillStyle = aa(INK_A, 0.7);
      ctx.fillRect(style.rule, 0, capW, h);
      ctx.fillStyle = aa(HOT_A, 0.8);
      for (let d = -h - 14; d < capW + h + 14; d += 14) {
        const dd = style.rule + d + drift;
        ctx.beginPath();
        ctx.moveTo(dd, 0);
        ctx.lineTo(dd + 7, 0);
        ctx.lineTo(dd + 7 - h, h);
        ctx.lineTo(dd - h, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = aa(INK_A, 0.55);
      ctx.fillRect(style.rule + capW, 0, 1, h);
    }

    /* --- typographic hierarchy ------------------------------------ */
    const kickY = 17;
    ctx.fillStyle = tone === "info" ? aa(ALU_A, 0.9) : aa(style.accent, 0.95);
    fillMono(ctx, F_KICKER, style.kicker, textX, kickY, 1.9, -1);
    ctx.fillStyle = aa(style.accent, 0.35);
    ctx.fillRect(textX, kickY + 4, 16, 1);

    const bodyY = kickY + 23;
    if (tier.textGhost) {
      ctx.fillStyle = aa(INK_A, 0.65);
      fillTracked(ctx, lay.font, lay.line, textX + 1, bodyY + 1, style.tracking, -1);
    }
    ctx.fillStyle = tone === "bad" || tone === "alert" ? BONE_WARM : BONE;
    fillTracked(ctx, lay.font, lay.line, textX, bodyY, style.tracking, -1);

    /* --- accent passes -------------------------------------------- */
    if (style.sweep && tier.sweeps && sweepHemi && annPhase === "in") {
      const p = ease.outQuad(clamp01(annT / (style.inSeconds + 0.22)));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (1 - p) * 0.7;
      const sw = w * 0.55;
      ctx.drawImage(sweepHemi.canvas, -sw + p * (w + sw), 0, sw, h);
      ctx.restore();
    }

    // "bad" arrives as a cut: two frames of blown plate, then nothing.
    if (cut > 0.01) {
      ctx.fillStyle = aa(BONE_A, cut * 0.45);
      ctx.fillRect(0, 0, w, h);
    }

    // Alert keeps a slow rim pulse while it holds. 2 Hz; off in reduced motion.
    if (tone === "alert" && !reduced) {
      ctx.strokeStyle = aa(HOT_A, 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(time * TAU * 2)));
      ctx.lineWidth = 1.1;
      chamferRect(ctx, 0.6, 0.6, w - 1.2, h - 1.2, 9);
      ctx.stroke();
    }

    ctx.restore(); // wipe clip

    // The wipe head: a bright leading edge travelling with the clip.
    if (reveal < 1 && reveal > 0.01) {
      const hx = w * reveal;
      ctx.fillStyle = aa(style.accent, 0.9);
      ctx.fillRect(hx - 2.5, 0, 2.5, h);
      ctx.fillStyle = aa(WHITE_A, 0.55);
      ctx.fillRect(hx - 1, 0, 1, h);
    }

    ctx.restore();
  }

  /* ================================================================ *
   * Module: the channel at rest
   *
   * With nothing to announce and no ident running, the channel shows what a
   * gallery actually leaves on a spare keyer: the chat crawl, with a header
   * row carrying the state of the feed and the timecode. Both used to be
   * separate floating plates inside the play field — the slow chip at y 85 and
   * the timecode at y 136 — where a descending caller printed straight over
   * them.
   * ================================================================ */

  /* Priority stack. Each tenant is clipped to what the tenant above it has not
     yet wiped over, so a takeover in progress shows the channel changing hands
     rather than two graphics printing through one another. */

  /** Logical width of the channel the announcement strap is covering. */
  function announcementCover(): number {
    if (!active || annPhase === "off") return 0;
    const w = layout.channel.w;
    return annPhase === "in" && active.tone !== "bad"
      ? w * clamp01(ease.outQuint(clamp01(annT / TONE[active.tone].inSeconds)))
      : w;
  }

  /** …and by the show ident. */
  function identCover(): number {
    return lowerPhase === "off" ? 0 : layout.channel.w * clamp01(lowerTimings().slab);
  }

  function drawChannelRest(
    ctx: CanvasRenderingContext2D,
    state: OverlayState,
    scene: SceneContext,
  ): void {
    const ch = layout.channel;
    const cover = Math.min(ch.w, Math.max(announcementCover(), identCover()));
    if (cover >= ch.w - 0.5) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(ch.x + cover, ch.y - 3, ch.w - cover, ch.h + 6);
    ctx.clip();

    const panel = panelFor(ch.h);
    if (panel) drawPanel(ctx, panel, ch.x, ch.y, ch.w);
    else {
      ctx.fillStyle = aa(INK_A, 0.88);
      chamferRect(ctx, ch.x, ch.y, ch.w, ch.h, 9);
      ctx.fill();
    }
    ctx.fillStyle = aa(HEMI_A, 0.9);
    ctx.fillRect(ch.x, ch.y, 3, ch.h);

    /* --- header row -----------------------------------------------
       The kicker sits exactly where the announcement strap's kicker sits, so a
       takeover replaces the row rather than arriving beside it. */
    const hx = ch.x + 19;
    const hy = ch.y + 14;
    const slow = clamp01(slowVis.value);
    const secs = Math.max(0, state.slowSeconds);
    const live = slow < 0.02;

    const kick = fitRun(ctx, F_KICKER, "PRODUCTION", 1.9, ch.w * 0.3);
    ctx.fillStyle = aa(ALU_A, 0.9);
    fillFitted(ctx, kick, hx, hy, 1.9, -1);
    ctx.fillStyle = aa(HEMI_A, 0.35);
    ctx.fillRect(hx, hy + 4, 16, 1);

    if (!live) {
      const label = fitRun(ctx, F_KICKER, "CHAT SLOW MODE", 1.6, ch.w * 0.28);
      ctx.fillStyle = aa(BONE_A, 0.95);
      fillFitted(ctx, label, hx + kick.width + 22, hy, 1.6, -1);
      // Draining bar, on the header baseline, between the label and the clock.
      const barX = hx + kick.width + 22 + label.width + 12;
      const barW = Math.max(24, ch.w * 0.2);
      const frac = clamp01(slowWindow > 0 ? secs / slowWindow : 0);
      ctx.globalAlpha = clamp01(slow * 1.6);
      ctx.fillStyle = aa(INK_A, 0.7);
      ctx.fillRect(barX, hy - 5, barW, 3);
      ctx.fillStyle = aa(HEMI_A, 0.9);
      ctx.fillRect(barX, hy - 5, barW * frac, 3);
      if (frac > 0.01) {
        ctx.fillStyle = aa(WHITE_A, 0.5);
        ctx.fillRect(barX + barW * frac - 1, hy - 5.6, 1.4, 4.2);
      }
      // Quarter ticks, so the bar reads as a scale rather than a progress bar.
      ctx.fillStyle = aa(BONE_A, 0.14);
      for (let i = 1; i < 4; i++) ctx.fillRect(barX + (barW * i) / 4, hy - 6.6, 1, 1.5);
      ctx.fillStyle = aa(HEMI_A, 0.95);
      fillMono(ctx, F_KICKER, secs >= 10 ? secs.toFixed(0) + "s" : secs.toFixed(1) + "s", barX + barW + 8, hy, 0.8, -1);
      ctx.globalAlpha = 1;
    }

    /* --- timecode, camera-right on the same baseline -------------- */
    const right = ch.x + ch.w - 12;
    const tc = timecode(scene.rawTime);
    const tcW = monoWidth(ctx, F_KICKER, tc, 1.1);
    ctx.fillStyle = aa(ALU_A, 0.75);
    fillMono(ctx, F_KICKER, tc, right, hy, 1.1, 1);
    // REC tally: 0.5 Hz, solid under reduced motion.
    const on = reduced || Math.sin(scene.rawTime * Math.PI) > -0.4;
    ctx.fillStyle = on ? aa(HOT_A, 0.9) : aa(HOT_A, 0.2);
    ctx.beginPath();
    ctx.arc(right - tcW - 9, hy - 2.4, 2.4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = aa(ALU_A, 0.6);
    fillMono(ctx, F_KICKER, "REC", right - tcW - 15, hy, 1.1, 1);

    drawTicker(ctx);
    ctx.restore();
  }

  /* ================================================================ *
   * Module: ticker
   * ================================================================ */

  function drawCrawl(bctx: CanvasRenderingContext2D, w: number): void {
    const crawlLeft = CHAT_CAP_W;
    const crawlRight = w - END_CAP_W;
    bctx.save();
    bctx.beginPath();
    bctx.rect(crawlLeft, 0, crawlRight - crawlLeft, TICKER_H);
    bctx.clip();
    bctx.textBaseline = "alphabetic";

    const baseline = TICKER_H * 0.5 + 4;
    let idx = head;
    let x = headX;
    let guard = 0;
    const maxIterations = items.length * 2 + 4;
    while (x < crawlRight + 8 && guard < maxIterations) {
      const item = items[idx];
      if (x + item.stride > crawlLeft - 8) {
        // Handle: mono, hemi — the source of the line.
        bctx.font = F_HANDLE;
        bctx.fillStyle = aa(HEMI_A, 0.95);
        bctx.fillText(item.handle, x, baseline);

        // Message: sans, bone. This one has to survive a busy plate.
        const tx = x + item.handleWidth + 11;
        bctx.font = F_CHAT;
        if (tier.textGhost) {
          bctx.fillStyle = aa(INK_A, 0.75);
          bctx.fillText(item.text, tx + 0.7, baseline + 0.7);
        }
        bctx.fillStyle = aa(BONE_A, 0.88);
        bctx.fillText(item.text, tx, baseline);

        // Separator diamond.
        const sx = tx + item.textWidth + 15;
        bctx.fillStyle = aa(ALU_A, 0.55);
        bctx.beginPath();
        bctx.moveTo(sx, baseline - 6.4);
        bctx.lineTo(sx + 2.6, baseline - 3.8);
        bctx.lineTo(sx, baseline - 1.2);
        bctx.lineTo(sx - 2.6, baseline - 3.8);
        bctx.closePath();
        bctx.fill();
      }
      x += item.stride;
      idx = (idx + 1) % items.length;
      guard++;
    }
    bctx.restore();
  }

  /* Reduced motion holds one line instead of scrolling it, so that line is the
     only chat run in the package that has to fit a box. Trimmed once per line
     and cached on the request: the crawl's own type stays on a single fillText
     per half, which is why it is not laid out through `fitRun`. */
  const staticFit = { key: "", out: "" };

  function fitStatic(bctx: CanvasRenderingContext2D, text: string, room: number): string {
    const key = Math.round(room) + "|" + text;
    if (staticFit.key === key) return staticFit.out;
    let out = text;
    if (textWidth(bctx, F_CHAT, out) > room) {
      while (out.length > 1 && textWidth(bctx, F_CHAT, out + "…") > room) out = out.slice(0, -1);
      out = out.trimEnd() + "…";
    }
    staticFit.key = key;
    staticFit.out = out;
    return out;
  }

  /** Reduced motion: one line, held, cross-faded. No scroll, no strobe. */
  function drawStaticLine(bctx: CanvasRenderingContext2D, w: number): void {
    const left = CHAT_CAP_W + 14;
    const right = w - END_CAP_W - 10;
    bctx.save();
    bctx.beginPath();
    bctx.rect(left - 6, 0, right - left + 6, TICKER_H);
    bctx.clip();
    bctx.textBaseline = "alphabetic";
    const baseline = TICKER_H * 0.5 + 4;
    const item = items[staticIndex % items.length];
    // Symmetric fade in and out, so a line never cuts to black.
    bctx.globalAlpha = Math.min(
      clamp01(staticT / STATIC_FADE),
      clamp01((STATIC_DWELL - staticT) / STATIC_FADE),
    );
    bctx.font = F_HANDLE;
    bctx.fillStyle = aa(HEMI_A, 0.95);
    bctx.fillText(item.handle, left, baseline);
    const textX = left + item.handleWidth + 11;
    bctx.font = F_CHAT;
    bctx.fillStyle = aa(BONE_A, 0.88);
    bctx.fillText(fitStatic(bctx, item.text, right - textX), textX, baseline);
    bctx.restore();
  }

  function drawTicker(ctx: CanvasRenderingContext2D): void {
    const r = layout.crawl;
    ensureTickerSurfaces();
    const buffer = tickerBuffer;

    if (!buffer) {
      // Server render or no offscreen support: the strip still exists, it just
      // loses its fades. Composition is identical; only the edges are hard.
      ctx.fillStyle = aa(INK_A, 0.82);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = aa(BONE_A, 0.16);
      ctx.fillRect(r.x, r.y, r.w, 1);
      return;
    }

    ensureTicker(buffer.ctx);
    const b = buffer.ctx;
    const w = buffer.lw;
    b.clearRect(0, 0, w, TICKER_H);
    if (tickerChrome) b.drawImage(tickerChrome.canvas, 0, 0, tickerChrome.w, tickerChrome.h, 0, 0, w, TICKER_H);

    if (reduced) drawStaticLine(b, w);
    else drawCrawl(b, w);

    // Soft edge fades: erase the composite (chrome and type together) so the
    // strip dissolves into the set rather than ending on a hard rectangle.
    b.save();
    b.globalCompositeOperation = "destination-out";
    if (tickerFadeLeft) {
      b.fillStyle = tickerFadeLeft;
      b.fillRect(CHAT_CAP_W, 0, 32, TICKER_H);
    }
    if (tickerFadeRight) {
      b.fillStyle = tickerFadeRight;
      b.fillRect(w - END_CAP_W - 42, 0, 42, TICKER_H);
    }
    b.restore();

    // Caps go on after the fade, so they stay solid and the crawl appears to
    // emerge from behind the CHAT block.
    if (chatCap) b.drawImage(chatCap.canvas, 0, 0, chatCap.w, chatCap.h, 0, 0, CHAT_CAP_W, TICKER_H);
    if (endCap) b.drawImage(endCap.canvas, 0, 0, endCap.w, endCap.h, w - END_CAP_W, 0, END_CAP_W, TICKER_H);

    /* A hard knock on the rig tears the feed: the strip is presented in two
       bands with a horizontal offset between them for a few frames. It is the
       only glitch in the package, and reduced motion removes it entirely. */
    const trauma = tier.tear && !reduced ? camera.trauma * camera.trauma : 0;
    if (trauma > 0.14) {
      const split = Math.round((0.35 + 0.3 * (noise.n2(time * 9, 4.3) * 0.5 + 0.5)) * TICKER_H);
      const shift = noise.n2(time * 13, 21.7) * trauma * 5;
      const topH = split * buffer.k;
      ctx.drawImage(buffer.canvas, 0, 0, buffer.w, topH, r.x, r.y, r.w, split);
      ctx.drawImage(
        buffer.canvas,
        0,
        topH,
        buffer.w,
        buffer.h - topH,
        r.x + shift,
        r.y + split,
        r.w,
        r.h - split,
      );
    } else {
      ctx.drawImage(buffer.canvas, 0, 0, buffer.w, buffer.h, r.x, r.y, r.w, r.h);
    }

    // Contact shadow, so the strip sits on the set instead of floating over it.
    ctx.fillStyle = aa(INK_A, 0.3);
    ctx.fillRect(r.x + 6, r.y + r.h, r.w - 12, 2);
  }

  /* ================================================================ *
   * Module: lower third
   * ================================================================ */

  /**
   * Staggered broadcast entry: each element owns a window inside the 0.92 s
   * in-animation, so the ident builds rather than simply appears. Out runs the
   * same stack in reverse, fastest element first. Shared with `channelCover`,
   * so the crawl underneath is uncovered by exactly the slab that covers it.
   */
  function lowerTimings(): { rail: number; slab: number; title: number; sub: number; pill: number } {
    if (lowerPhase === "in") {
      const t = lowerT;
      return {
        rail: ease.outQuint(clamp01(t / 0.3)),
        slab: ease.outQuint(clamp01((t - 0.1) / 0.44)),
        title: ease.outQuad(clamp01((t - 0.34) / 0.42)),
        sub: ease.outCubic(clamp01((t - 0.5) / 0.3)),
        pill: ease.outBack(clamp01((t - 0.62) / 0.28)),
      };
    }
    if (lowerPhase === "out") {
      const t = clamp01(lowerT / LOWER_OUT);
      return {
        rail: 1 - ease.inQuad(clamp01((t - 0.6) / 0.4)),
        slab: 1 - ease.inQuint(clamp01((t - 0.3) / 0.55)),
        title: 1 - ease.inQuad(clamp01((t - 0.15) / 0.4)),
        sub: 1 - ease.inQuad(clamp01((t - 0.1) / 0.35)),
        pill: 1 - ease.inQuad(clamp01(t / 0.35)),
      };
    }
    return { rail: 1, slab: 1, title: 1, sub: 1, pill: 1 };
  }

  function drawLowerThird(ctx: CanvasRenderingContext2D): void {
    if (lowerPhase === "off") return;
    const r = layout.channel;
    // Whatever the strap has already taken is not the ident's to draw on.
    const taken = announcementCover();
    if (taken >= r.w - 0.5) return;
    const { rail: railT, slab: slabT, title: titleT, sub: subT, pill: pillT } = lowerTimings();

    const slabW = r.w * clamp01(slabT);
    const railW = r.w * clamp01(railT);

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + taken, r.y - 4, r.w - taken, r.h + 8);
    ctx.clip();
    ctx.translate(r.x, r.y);

    // The rail: a bone hairline that wipes out first and retracts last.
    if (railW > 0.5) {
      ctx.fillStyle = aa(BONE_A, 0.5);
      ctx.fillRect(0, r.h - 1, railW, 1);
      ctx.fillStyle = aa(HEMI_A, 0.75);
      ctx.fillRect(0, r.h - 1, Math.min(railW, 46), 1);
    }

    if (slabW > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-1, -2, slabW + 1, r.h + 4);
      ctx.clip();

      const panel = panelFor(r.h);
      if (panel) drawPanel(ctx, panel, 0, 0, r.w);
      else {
        ctx.fillStyle = aa(INK_A, 0.9);
        chamferRect(ctx, 0, 0, r.w, r.h, 9);
        ctx.fill();
      }

      // Identity rule.
      ctx.fillStyle = aa(HEMI_A, 0.95);
      ctx.fillRect(0, 0, 4, r.h);
      ctx.fillStyle = aa(HOT_A, 0.6);
      ctx.fillRect(0, 0, 4, r.h * 0.3);

      /* Every run on this plate is measured against the plate before it is
         drawn. The title used to be set at a fixed 17 px inside a slab whose
         width was a constant that happened to be big enough; nothing checked,
         so nothing could report the day it stopped being big enough. */
      const pillW = monoWidth(ctx, F_KICKER, lowerStatus, 1.3) + 26;
      const textL = 18;
      const textMax = Math.max(40, r.w - textL - pillW - 20);

      const kicker = fitRun(ctx, F_KICKER, "HEMI STUDIOS · STAGE THREE", 1.5, textMax);
      ctx.fillStyle = aa(ALU_A, 0.85);
      fillFitted(ctx, kicker, textL, 15, 1.5, -1);

      /* Title, typed on character by character. */
      const title = fitRun(ctx, F_IDENT, "MIDWEEK WITH MAX", IDENT_TRACK, textMax);
      const reveal = Math.ceil(title.text.length * clamp01(titleT));
      if (tier.textGhost) {
        ctx.fillStyle = aa(INK_A, 0.7);
        fillFitted(ctx, title, textL + 1, 35.2, IDENT_TRACK, -1, reveal);
      }
      ctx.fillStyle = BONE;
      fillFitted(ctx, title, textL, 34, IDENT_TRACK, -1, reveal);
      if (titleT > 0 && titleT < 1) {
        // Type-on caret. Solid under reduced motion.
        const cx = trackedCaretX(ctx, title.font, title.text, textL, IDENT_TRACK, reveal);
        ctx.fillStyle = aa(HEMI_A, reduced ? 1 : 0.55 + 0.45 * Math.sin(time * 18));
        ctx.fillRect(cx, 23, 2, 12);
      }

      /* Sub-line, clipped up from below — inside its own row, never off the
         bottom of the plate. */
      const sub = fitRun(ctx, F_SUB, "COMMUNITY TAKEOVER", 1.7, textMax);
      const subTop = 38;
      const subRow = Math.min(13, r.h - subTop - 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, subTop, r.w, subRow * clamp01(subT));
      ctx.clip();
      ctx.fillStyle = aa(ALU_A, 0.95);
      fillFitted(ctx, sub, textL, subTop + 9 + (1 - clamp01(subT)) * 8, 1.7, -1);
      ctx.restore();

      ctx.restore(); // slab clip
    }

    /* Live status pill — outside the slab clip, and always last in and first out. */
    if (pillT > 0.01) {
      const pw = monoWidth(ctx, F_KICKER, lowerStatus, 1.3) + 26;
      const px = r.w - pw - 10;
      const py = r.h * 0.5 - 6.5;
      const s = clamp01(pillT);
      ctx.save();
      ctx.translate(px + pw * 0.5, py + 6.5);
      ctx.scale(s, s);
      ctx.translate(-(px + pw * 0.5), -(py + 6.5));
      ctx.fillStyle = aa(INK_A, 0.9);
      roundRect(ctx, px, py, pw, 13, 6.5);
      ctx.fill();
      ctx.strokeStyle = aa(HEMI_A, 0.5);
      ctx.lineWidth = 0.9;
      roundRect(ctx, px + 0.45, py + 0.45, pw - 0.9, 12.1, 6.5);
      ctx.stroke();
      // Live dot: 0.5 Hz, solid under reduced motion.
      const on = reduced || Math.sin(time * Math.PI) > -0.35;
      ctx.fillStyle = on ? aa(HOT_A, 0.98) : aa(HOT_A, 0.28);
      ctx.beginPath();
      ctx.arc(px + 9, py + 6.5, 2.6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = aa(BONE_A, 0.9);
      fillMono(ctx, F_KICKER, lowerStatus, px + 16, py + 9, 1.3, -1);
      ctx.restore();
    }

    ctx.restore();
  }

  /* ================================================================ *
   * Module: floor slates
   * ================================================================ */

  function drawScoreBug(ctx: CanvasRenderingContext2D): void {
    const r = layout.slateL;
    if (slateLeft) blit(ctx, slateLeft, r.x, r.y);
    else {
      ctx.fillStyle = aa(INK_A, 0.86);
      chamferRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.fill();
      ctx.fillStyle = aa(ALU_A, 0.75);
      fillMono(ctx, F_KICKER, "PATIENCE POINTS", r.x + 11, r.y + 13, 1.6, -1);
    }

    const pop = clamp01(scorePop.value);
    const value = groupNumber(scoreShown);
    ctx.save();
    ctx.translate(r.x + 11, r.y + 32 - pop * 1.6);
    if (tier.textGhost) {
      ctx.fillStyle = aa(INK_A, 0.7);
      fillMono(ctx, F_SCORE, value, 1, 1, 0.6, -1);
    }
    ctx.fillStyle = pop > 0.02 ? heat(pop * 0.55) : BONE;
    fillMono(ctx, F_SCORE, value, 0, 0, 0.6, -1);
    ctx.restore();

    // Rising delta ghost — the classic scorebug credit.
    if (deltaAge < 0.95 && deltaValue > 0) {
      const t = deltaAge / 0.95;
      ctx.globalAlpha = 1 - ease.inQuad(t);
      ctx.fillStyle = aa(HEMI_A, 0.95);
      fillMono(ctx, F_META, "+" + deltaValue, r.x + r.w - 11, r.y + 30 - t * 13, 0.4, 1);
      ctx.globalAlpha = 1;
    }
  }

  function drawProductionSlate(
    ctx: CanvasRenderingContext2D,
    state: OverlayState,
    scene: SceneContext,
  ): void {
    const r = layout.slateR;
    if (slateRight) blit(ctx, slateRight, r.x, r.y);
    else {
      ctx.fillStyle = aa(INK_A, 0.86);
      chamferRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.fill();
      ctx.fillStyle = aa(ALU_A, 0.75);
      fillMono(ctx, F_KICKER, "ACTIVE CALLERS", r.x + 11, r.y + 13, 1.6, -1);
      fillMono(ctx, F_KICKER, "SEGMENT", r.x + 11, r.y + 31, 1.6, -1);
    }

    const right = r.x + r.w - 11;

    /* Row 1 — active callers, with a pip meter. */
    const callers = Math.max(0, state.activeQuestions | 0);
    ctx.fillStyle = callers >= 4 ? aa(HOT_A, 0.95) : callers >= 3 ? aa(HEMI_A, 0.95) : aa(BONE_A, 0.92);
    fillMono(ctx, F_METAB, callers < 10 ? "0" + callers : "" + callers, right, r.y + 14, 0.6, 1);

    const pipMax = 6;
    const pipW = 4;
    const pipGap = 2;
    const px = right - (pipMax * pipW + (pipMax - 1) * pipGap) - 20;
    for (let i = 0; i < pipMax; i++) {
      ctx.fillStyle = callers > i ? (i >= 3 ? aa(HOT_A, 0.9) : aa(HEMI_A, 0.85)) : aa(BONE_A, 0.1);
      ctx.fillRect(px + i * (pipW + pipGap), r.y + 8, pipW, 4.5);
    }

    /* Row 2 — the segment, fitted to what the baked "SEGMENT" label leaves. */
    ctx.fillStyle = aa(BONE_A, 0.92);
    const segMax = r.w - 22 - monoWidth(ctx, F_KICKER, "SEGMENT", 1.6) - 10;
    fillFitted(ctx, fitRun(ctx, F_META, state.difficultyLabel, 0.9, segMax), right, r.y + 31, 0.9, 1);

    /* Backlog gutter along the bottom edge: no extra row required. */
    const backlog = clamp01(scene.maxBacklog > 0 ? scene.backlog / scene.maxBacklog : 0);
    if (backlog > 0.001) {
      const gx = r.x + 3;
      const gw = r.w - 6;
      ctx.fillStyle = aa(INK_A, 0.7);
      ctx.fillRect(gx, r.y + r.h - 2.6, gw, 2);
      ctx.fillStyle = backlog > 0.65 ? aa(HOT_A, 0.9) : aa(HEMI_A, 0.75);
      ctx.fillRect(gx, r.y + r.h - 2.6, gw * backlog, 2);
    }
  }

  /* ================================================================ *
   * Frame furniture
   * ================================================================ */

  function drawRegistration(ctx: CanvasRenderingContext2D): void {
    if (!tier.registration) return;
    const l = layout;
    const s = 9;
    ctx.strokeStyle = aa(BONE_A, 0.13 + flashLift * 0.2);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.safeL, l.safeT + s);
    ctx.lineTo(l.safeL, l.safeT);
    ctx.lineTo(l.safeL + s, l.safeT);
    ctx.moveTo(l.safeR - s, l.safeT);
    ctx.lineTo(l.safeR, l.safeT);
    ctx.lineTo(l.safeR, l.safeT + s);
    ctx.moveTo(l.safeL, l.safeB - s);
    ctx.lineTo(l.safeL, l.safeB);
    ctx.lineTo(l.safeL + s, l.safeB);
    ctx.moveTo(l.safeR - s, l.safeB);
    ctx.lineTo(l.safeR, l.safeB);
    ctx.lineTo(l.safeR, l.safeB - s);
    ctx.stroke();
  }

  /* ================================================================ *
   * Public surface
   * ================================================================ */

  return {
    update(scene: SceneContext): void {
      applyScene(scene);
      const dt = Math.min(0.1, Math.max(0, scene.rawDt));

      /* Everything here runs on raw time. Broadcast graphics are burned in
         downstream of the camera, so they do not freeze during hit-stop. */
      for (let i = 0; i < digitPulses.length; i++) digitPulses[i].update(dt);
      secondPulse.update(dt);
      comboPop.update(dt);
      comboLevel.update(dt);
      scorePop.update(dt);
      slowVis.update(dt);

      comboShake = Math.max(0, comboShake - dt * 3.4);
      comboSweep = Math.min(2, comboSweep + dt * 2.6);
      deltaAge += dt;

      // Framerate-independent approach: fast enough to feel instant, slow
      // enough that the score bug reads as a count-up rather than a jump.
      scoreShown = damp(scoreShown, lastScore, 13, dt);
      if (Math.abs(scoreShown - lastScore) < 0.6) scoreShown = lastScore;

      flashLift = damp(flashLift, clamp01(scene.flash), 16, dt);
      urgency = damp(urgency, clamp01(1 - Math.max(0, timeShown) / 30), 6, dt);

      advanceAnnouncement(dt);
      advanceLowerThird(dt);
      updateMotes(dt);

      /* The crawl. Chat speeds up with pressure and genuinely slows in slow
         mode, which makes the joke mechanical rather than decorative. */
      if (items.length > 0) {
        if (reduced) {
          staticT += dt;
          if (staticT >= STATIC_DWELL) {
            staticT = 0;
            staticIndex = (staticIndex + 1) % items.length;
          }
        } else {
          const speed = lerp(46, 78, clamp01(scene.intensity)) * lerp(1, 0.3, clamp01(scene.slow));
          headX -= speed * dt;
          // Re-basing the head as items leave means headX never drifts, so the
          // crawl is seamless for as long as the show runs.
          let guard = 0;
          while (headX + items[head].stride < CHAT_CAP_W && guard < items.length) {
            headX += items[head].stride;
            head = (head + 1) % items.length;
            guard++;
          }
        }
      }
    },

    draw(ctx: CanvasRenderingContext2D, scene: SceneContext, state: OverlayState): void {
      applyScene(scene);
      ensureArt();
      syncState(state, scene);

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";

      drawRegistration(ctx);
      drawClock(ctx, state);
      drawCombo(ctx, state);
      /* One channel, drawn bottom of the stack up: the resting crawl, then the
         ident, then the announcement. Each covers exactly what it wipes over. */
      drawChannelRest(ctx, state, scene);
      drawLowerThird(ctx);
      drawAnnouncement(ctx);
      drawScoreBug(ctx);
      drawProductionSlate(ctx, state, scene);
      drawMotes(ctx);

      ctx.restore();
    },

    announce(text: string, tone: Tone = "info", seconds = 2.6): void {
      enqueue(text, tone, seconds);
    },
  };
}
