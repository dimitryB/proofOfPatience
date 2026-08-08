/**
 * POP caller cards — the descending question panels.
 *
 * Every card is a physical object, not a rectangle with text on it: a dark
 * glass panel bonded onto a machined substrate, held in a bevelled aluminium
 * frame that catches the studio key light from wherever it happens to be
 * hanging in the frame. Behind the glass sit a caller bust, broadcast type and
 * a bank of answer sockets that accept machined S/O/O/N tiles.
 *
 * Everything static is baked once into an offscreen sprite sheet keyed by
 * (kind, size, letters, colour, supersample); the per-frame path is a handful of
 * `drawImage` composites plus the parts that genuinely move — the directional
 * specular on the frame, the glass sheen, the socket mechanics, the targeting
 * furniture and the damage. No gradient, pattern, path or string is built inside
 * the draw loop.
 *
 * Constraints honoured (docs/ENGINE_ARCHITECTURE.md):
 *   - no `Math.random`: every stochastic detail comes from `deps.rng.fork`;
 *   - no DOM at module scope — canvases are created lazily inside functions;
 *   - `scene.quality` selects the bake resolution and the optional passes;
 *   - `scene.reducedMotion` keeps the composition and kills the motion.
 */

import type { QuestionKind } from "../pop";
import { LETTERS, STAGE_Y } from "../pop";
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
import type {
  QualityTier,
  QuestionRenderer,
  QuestionView,
  RenderDeps,
  Rng,
  SceneContext,
  Spring,
} from "./types";

/* ------------------------------------------------------------------ *
 * Palette — hemi orange is the only saturated hue in the building
 * ------------------------------------------------------------------ */

const HEMI = "#ff4600";
/** Danger is orange pushed hotter, never a second hue. */
const HEMI_HOT = "#ff2a00";
const BONE = "#efe7e0";
const WARM_WHITE = "#fff3e4";
const ALUMINIUM = "#8d8781";
const CHARCOAL = "#080604";

/** Studio key: high, camera-left, slightly behind — same rig textures.ts lights. */
const KEY_X_FRACTION = 0.34;
const KEY_Y = -320;
/** Out-of-plane component of the key. The in-plane part is scaled by √(1−lz²). */
const KEY_LZ = 0.55;
const KEY_LXY = Math.sqrt(1 - KEY_LZ * KEY_LZ);
/** Chamfer cut on the frame's outer edge, in radians from the panel plane. */
const CHAMFER = 0.9075; // ≈52°
const CHAMFER_SIN = Math.sin(CHAMFER);
const CHAMFER_COS = Math.cos(CHAMFER);
/** Bounce light off the LED wall and the audience monitors: low, camera-right. */
const FILL_X = 0.34;
const FILL_Y = 0.62;

const TAU = Math.PI * 2;
/** Broadcast entrance: line, unfold, type, sockets — all inside this window. */
const ENTRY_SECONDS = 0.45;
const ENTRY_UNFOLD = ENTRY_SECONDS * 0.44;
const ENTRY_TYPE_IN = ENTRY_SECONDS * 0.47;
const HIT_SECONDS = 0.34;
/** Empty socket sentinel; anything above −1e8 counts as seated. */
const SEAT_EMPTY = -1e9;
/** A socket that was already filled when the card first came into view. */
const SEAT_SETTLED = -1e6;
/** How long a tile takes to fall, seat and stop ringing. */
const SEAT_DROP = 0.16;
const SEAT_SETTLE = 0.34;

/* ------------------------------------------------------------------ *
 * Quality tiers
 * ------------------------------------------------------------------ */

interface Tier {
  /** Supersample factor for every bake. 2 lands 1:1 on a retina panel. */
  ss: number;
  /** Moving specular hot-spot on the frame. */
  glint: boolean;
  /** Second, tighter reflection streak across the glass. */
  sheen2: boolean;
  /** Dust, micro-scratches and fingerprints on the glass surface. */
  dirt: boolean;
  /** Dark counter-pass that gives the cracks physical depth. */
  crackDepth: boolean;
  /** Additive bloom sprite when a tile seats. */
  seatFlash: boolean;
  /** Sparks kicked out of the socket when a tile seats. */
  seatSparks: boolean;
  /** Contact-shadow layers: 1 = blob only, 2 = + colour spill, 3 = + haze block. */
  shadowLayers: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: { ss: 1, glint: false, sheen2: false, dirt: false, crackDepth: false, seatFlash: false, seatSparks: false, shadowLayers: 1 },
  medium: { ss: 1, glint: false, sheen2: false, dirt: true, crackDepth: false, seatFlash: true, seatSparks: false, shadowLayers: 2 },
  // 1.5× already lands close to 1:1 on a retina panel and costs 44 % less
  // backing store than a full 2×; ultra takes the rest.
  high: { ss: 1.5, glint: true, sheen2: true, dirt: true, crackDepth: true, seatFlash: true, seatSparks: true, shadowLayers: 3 },
  ultra: { ss: 2, glint: true, sheen2: true, dirt: true, crackDepth: true, seatFlash: true, seatSparks: true, shadowLayers: 3 },
};

/* ------------------------------------------------------------------ *
 * Offscreen surfaces
 * ------------------------------------------------------------------ */

interface Bake {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  /** Logical width/height. */
  w: number;
  h: number;
  /** Backing-store width/height in device pixels. */
  pw: number;
  ph: number;
}

/**
 * Raw offscreen allocation. Prefers `OffscreenCanvas` (no layout, no GC pressure
 * from detached nodes) and falls back to a DOM canvas. Never runs at module
 * scope, so the module still imports cleanly during server rendering.
 */
function allocCanvas(pw: number, ph: number): { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D } {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(pw, ph);
    const raw = canvas.getContext("2d");
    if (!raw) throw new Error("pop/question: OffscreenCanvas 2D context unavailable");
    // The two 2D context interfaces are API-identical for everything used here.
    return { canvas, ctx: raw as unknown as CanvasRenderingContext2D };
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("pop/question: 2D context unavailable");
    return { canvas, ctx };
  }
  throw new Error("pop/question: no OffscreenCanvas and no DOM — cards bake in the browser");
}

/** Offscreen surface pre-scaled so every baker draws in logical units. */
function makeBake(w: number, h: number, ss: number): Bake {
  const pw = Math.max(1, Math.round(w * ss));
  const ph = Math.max(1, Math.round(h * ss));
  const { canvas, ctx } = allocCanvas(pw, ph);
  ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
  return { canvas, ctx, w, h, pw, ph };
}

interface Sheet extends Bake {
  /** Device-pixel height of one tile; an exact integer, so tiles cannot bleed. */
  tilePx: number;
  rows: number;
}

/**
 * Vertical sprite sheet. The row height is rounded to whole device pixels first
 * and the surface sized from that, so every `drawImage` source rectangle lands
 * on exact texel boundaries.
 */
function makeSheet(w: number, h: number, rows: number, ss: number): Sheet {
  const tilePx = Math.max(1, Math.round(h * ss));
  const pw = Math.max(1, Math.round(w * ss));
  const ph = tilePx * rows;
  const { canvas, ctx } = allocCanvas(pw, ph);
  ctx.setTransform(pw / w, 0, 0, tilePx / h, 0, 0);
  return { canvas, ctx, w, h: h * rows, pw, ph, tilePx, rows };
}

/**
 * Repeating fill from a baked tile, rescaled so the material's grain reads at
 * card scale. A 512 px tile stretched across a 60 px frame member would show
 * one flat sample and no anisotropy at all.
 */
function tiledFill(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  scale: number,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha: number,
  blend: GlobalCompositeOperation,
): void {
  const pattern = ctx.createPattern(source, "repeat");
  if (!pattern) return;
  pattern.setTransform({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 });
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = blend;
  ctx.fillStyle = pattern;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Path helpers
 * ------------------------------------------------------------------ */

/** Rounded rectangle via arcTo, so it works on both `Path2D` and a context. */
function addRoundRect(p: CanvasPath, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
  p.moveTo(x + radius, y);
  p.arcTo(x + w, y, x + w, y + h, radius);
  p.arcTo(x + w, y + h, x, y + h, radius);
  p.arcTo(x, y + h, x, y, radius);
  p.arcTo(x, y, x + w, y, radius);
  p.closePath();
}

function roundRectPath(x: number, y: number, w: number, h: number, r: number): Path2D {
  const p = new Path2D();
  addRoundRect(p, x, y, w, h, r);
  return p;
}

/**
 * Inner shadow: fill everything *outside* `shape` with a blurred shadow while
 * clipped to the inside of `shape`. The fill itself lands outside the clip and
 * never paints; only the shadow, which falls inward, survives.
 */
function innerShadow(
  ctx: CanvasRenderingContext2D,
  shape: Path2D,
  bounds: { x: number; y: number; w: number; h: number },
  color: string,
  blur: number,
  dx: number,
  dy: number,
): void {
  const outside = new Path2D();
  const pad = Math.max(bounds.w, bounds.h) + blur * 4 + 24;
  outside.rect(bounds.x - pad, bounds.y - pad, bounds.w + pad * 2, bounds.h + pad * 2);
  outside.addPath(shape);

  ctx.save();
  ctx.clip(shape);
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = dx;
  ctx.shadowOffsetY = dy;
  ctx.fillStyle = "#000000";
  ctx.fill(outside, "evenodd");
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Type helpers — all text is measured and drawn at bake time only
 * ------------------------------------------------------------------ */

const DISPLAY_STACK = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const MONO_STACK = 'ui-monospace, "SF Mono", "Geist Mono", Menlo, Consolas, monospace';

function displayFont(size: number): string {
  return `900 ${size.toFixed(2)}px ${DISPLAY_STACK}`;
}

function monoFont(size: number, weight: number): string {
  return `${weight} ${size.toFixed(2)}px ${MONO_STACK}`;
}

interface FitResult {
  font: string;
  size: number;
  /** Horizontal scale applied on top; broadcast display type condenses, never squashes hard. */
  condense: number;
}

/**
 * Picks the largest size that fits, then condenses the remainder. Kerning is
 * preserved because the string is still drawn in one `fillText` — per-character
 * layout would throw the font's own pair kerning away.
 */
function fitDisplay(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  baseSize: number,
  minScale: number,
): FitResult {
  let size = baseSize;
  let font = displayFont(size);
  ctx.font = font;
  let width = ctx.measureText(text).width;
  const floor = baseSize * minScale;
  // Shrink in half-pixel steps while the overflow is too big to condense away.
  while (width > maxWidth * 1.14 && size > floor) {
    size = Math.max(floor, size - 0.5);
    font = displayFont(size);
    ctx.font = font;
    width = ctx.measureText(text).width;
  }
  const condense = width > maxWidth ? Math.max(0.78, maxWidth / width) : 1;
  return { font, size, condense };
}

/**
 * Tracked small caps for the technical furniture. Monospaced faces have no
 * kerning pairs to lose, so per-character placement is exactly correct here and
 * gives real control over the wide broadcast tracking.
 */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
): number {
  let cursor = x;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
  return cursor - tracking - x;
}

function trackedWidth(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  let total = 0;
  for (let i = 0; i < text.length; i++) total += ctx.measureText(text[i]).width + tracking;
  return Math.max(0, total - tracking);
}

/** Engraved type: the lit lower-right lip of a cut, then the dark cut itself. */
function engrave(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  lip: string,
  cut: string,
  depth: number,
): void {
  ctx.fillStyle = lip;
  ctx.fillText(text, x + depth, y + depth);
  ctx.fillStyle = cut;
  ctx.fillText(text, x, y);
}

/* ------------------------------------------------------------------ *
 * Geometry — solved once per (width, height, letter count)
 * ------------------------------------------------------------------ */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Geometry {
  w: number;
  h: number;
  radius: number;
  /** Frame thickness, outer edge to glass. */
  frame: number;
  /** Width of the chamfer cut on the outer edge. */
  chamfer: number;
  content: Rect;
  avatar: Rect;
  identity: Rect;
  label: Rect;
  demand: Rect;
  /** Strip holding the answer sockets and the progress rail. */
  strip: Rect;
  socketSize: number;
  socketRadius: number;
  socketStep: number;
  /** Extra gap inserted between every group of four (one SOON word). */
  wordGap: number;
  sockets: Float32Array;
  rail: Rect;
  alert: Rect;
  words: number;
  total: number;
  /** Paths, all in card-local space with the origin at the card centre. */
  outerPath: Path2D;
  glassPath: Path2D;
  ringPath: Path2D;
  contentPath: Path2D;
  socketPath: Path2D;
  demandPath: Path2D;
  avatarPath: Path2D;
  railPath: Path2D;
  bracketPath: Path2D;
  /** One corner bracket's reach, used to place the other three by mirroring. */
  bracketReach: number;
}

const LETTER_CYCLE = LETTERS.length;

function buildGeometry(w: number, h: number, total: number): Geometry {
  const radius = clamp(h * 0.17, 6, 13);
  const frame = clamp(h * 0.088, 4.2, 7.5);
  const chamfer = frame * 0.46;
  const pad = clamp(h * 0.062, 3, 6.5);

  const cx = -w * 0.5;
  const cy = -h * 0.5;
  const content: Rect = {
    x: cx + frame + pad,
    y: cy + frame + pad,
    w: w - (frame + pad) * 2,
    h: h - (frame + pad) * 2,
  };

  const gap = clamp(h * 0.052, 2.4, 5);
  const stripH = clamp(content.h * 0.34, 10, 19);
  const upper = content.h - stripH - gap;
  const identityH = clamp(upper * 0.37, 7.5, 13);
  const labelH = upper - identityH - gap * 0.55;

  const avatarSize = Math.min(upper, content.h * 0.64);
  const avatar: Rect = { x: content.x, y: content.y, w: avatarSize, h: avatarSize };

  // The demand well is the lower-right corner block: it spans the label band and
  // the socket strip so the required letter can be genuinely large.
  const demandSize = clamp(labelH + gap * 0.55 + stripH, 20, 42);
  const demand: Rect = {
    x: content.x + content.w - demandSize,
    y: content.y + content.h - demandSize,
    w: demandSize,
    h: demandSize,
  };

  const textLeft = avatar.x + avatar.w + gap;
  const identity: Rect = {
    x: textLeft,
    y: content.y,
    w: content.x + content.w - textLeft,
    h: identityH,
  };
  const label: Rect = {
    x: textLeft,
    y: content.y + identityH + gap * 0.55,
    w: demand.x - gap - textLeft,
    h: labelH,
  };
  const strip: Rect = {
    x: content.x,
    y: content.y + content.h - stripH,
    w: demand.x - gap - content.x,
    h: stripH,
  };

  // Socket bank: one machined well per required letter, grouped by SOON word.
  const count = Math.max(1, Math.min(16, Math.round(total) || LETTER_CYCLE));
  const words = Math.max(1, Math.ceil(count / LETTER_CYCLE));
  const socketGap = clamp(h * 0.038, 1.6, 3.2);
  const wordGap = socketGap * 2.4;
  const gapTotal = socketGap * (count - 1) + wordGap * (words - 1);
  // Progress is the most important state on the card, so the bank takes as much
  // of the strip as the rail will allow. The floor is a *readable* well, not a
  // token one: below ~7 px the engraved letter inside stops being a letter.
  const socketSize = clamp(
    Math.min(stripH * 0.84, (strip.w - gapTotal) / count),
    7,
    18,
  );
  const socketStep = socketSize + socketGap;
  const bankWidth = socketSize * count + gapTotal;
  const socketY = strip.y + (stripH - socketSize) * 0.3;

  const sockets = new Float32Array(count * 2);
  let cursor = strip.x;
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % LETTER_CYCLE === 0) cursor += wordGap - socketGap;
    sockets[i * 2] = cursor + socketSize * 0.5;
    sockets[i * 2 + 1] = socketY + socketSize * 0.5;
    cursor += socketStep;
  }

  // The rail runs under the bank and reads as one continuous machined groove.
  const railH = Math.max(1.6, Math.min(3, stripH * 0.16));
  const rail: Rect = {
    x: strip.x,
    y: socketY + socketSize + Math.max(1.2, stripH * 0.09),
    w: Math.max(socketSize, Math.min(bankWidth, strip.w)),
    h: railH,
  };

  // Proximity alert bar, machined into the bottom frame member.
  const alertH = Math.max(1.4, frame * 0.36);
  const alert: Rect = {
    x: cx + radius * 0.9,
    y: cy + h - frame * 0.5 - alertH * 0.5,
    w: w - radius * 1.8,
    h: alertH,
  };

  const outerPath = roundRectPath(cx, cy, w, h, radius);
  const glassPath = roundRectPath(
    cx + frame,
    cy + frame,
    w - frame * 2,
    h - frame * 2,
    Math.max(1.5, radius - frame * 0.72),
  );
  const ringPath = new Path2D();
  ringPath.addPath(outerPath);
  ringPath.addPath(glassPath);

  const contentPath = roundRectPath(content.x - 1, content.y - 1, content.w + 2, content.h + 2, 3);
  const socketPath = roundRectPath(
    -socketSize * 0.5,
    -socketSize * 0.5,
    socketSize,
    socketSize,
    Math.max(1, socketSize * 0.22),
  );
  const demandPath = roundRectPath(demand.x, demand.y, demand.w, demand.h, Math.max(2, demand.w * 0.14));
  const avatarPath = roundRectPath(avatar.x, avatar.y, avatar.w, avatar.h, Math.max(2, avatar.w * 0.16));
  const railPath = roundRectPath(rail.x, rail.y, rail.w, rail.h, rail.h * 0.5);

  // One corner bracket, authored at the top-left; the other three are mirrors.
  const reachX = Math.min(w * 0.22, 26);
  const reachY = Math.min(h * 0.34, 20);
  const bracketPath = new Path2D();
  bracketPath.moveTo(0, reachY);
  bracketPath.lineTo(0, 0);
  bracketPath.lineTo(reachX, 0);

  return {
    w,
    h,
    radius,
    frame,
    chamfer,
    content,
    avatar,
    identity,
    label,
    demand,
    strip,
    socketSize,
    socketRadius: Math.max(1, socketSize * 0.22),
    socketStep,
    wordGap,
    sockets,
    rail,
    alert,
    words,
    total: count,
    outerPath,
    glassPath,
    ringPath,
    contentPath,
    socketPath,
    demandPath,
    avatarPath,
    railPath,
    bracketPath,
    bracketReach: Math.max(reachX, reachY),
  };
}

/* ------------------------------------------------------------------ *
 * Shared sprites — baked once per renderer, reused by every card
 * ------------------------------------------------------------------ */

/** Soft anisotropic band used for the reflection streak across the glass. */
function bakeSheen(ss: number): Bake {
  const b = makeBake(256, 64, ss);
  const ctx = b.ctx;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, "rgba(255,243,228,0)");
  g.addColorStop(0.36, "rgba(255,243,228,0.30)");
  g.addColorStop(0.5, "rgba(255,247,236,0.92)");
  g.addColorStop(0.64, "rgba(255,243,228,0.26)");
  g.addColorStop(1, "rgba(255,243,228,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 64);
  // Taper the ends so the streak dies before it reaches the frame.
  const t = ctx.createLinearGradient(0, 0, 256, 0);
  t.addColorStop(0, "rgba(0,0,0,1)");
  t.addColorStop(0.18, "rgba(0,0,0,0)");
  t.addColorStop(0.82, "rgba(0,0,0,0)");
  t.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = t;
  ctx.fillRect(0, 0, 256, 64);
  return b;
}

/** Targeting scan band: a bright leading edge dragging a soft wake. */
function bakeSweep(ss: number): Bake {
  const b = makeBake(64, 8, ss);
  const ctx = b.ctx;
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, "rgba(255,243,228,0)");
  g.addColorStop(0.55, "rgba(255,220,190,0.16)");
  g.addColorStop(0.88, "rgba(255,238,220,0.55)");
  g.addColorStop(0.965, "rgba(255,252,246,1)");
  g.addColorStop(1, "rgba(255,243,228,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 8);
  return b;
}

/** Heat rising off the substrate as a card nears the floor. */
function bakeHotWash(ss: number): Bake {
  const b = makeBake(64, 64, ss);
  const ctx = b.ctx;
  const g = ctx.createLinearGradient(0, 64, 0, 0);
  g.addColorStop(0, withAlpha(HEMI_HOT, 0.95));
  g.addColorStop(0.28, withAlpha(HEMI, 0.42));
  g.addColorStop(0.66, withAlpha(HEMI, 0.1));
  g.addColorStop(1, withAlpha(HEMI, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return b;
}

/**
 * Contact shadow blob. Authored as a soft-edged rounded quad rather than an
 * ellipse so the perspective transform reads as a projected panel.
 */
function bakeShadowBlob(ss: number): Bake {
  const size = 192;
  const b = makeBake(size, size, ss);
  const ctx = b.ctx;
  // Nine stacked rounded rects with falling alpha approximate a wide gaussian
  // penumbra far more cheaply than a blur, and stay crisp at the core.
  const layers = 9;
  for (let i = layers - 1; i >= 0; i--) {
    const t = i / (layers - 1);
    const inset = 10 + t * 62;
    const a = (1 - t) * (1 - t) * 0.15 + 0.02;
    ctx.fillStyle = `rgba(2,1,1,${a.toFixed(4)})`;
    ctx.beginPath();
    addRoundRect(ctx, inset, inset, size - inset * 2, size - inset * 2, 26 + t * 34);
    ctx.fill();
  }
  return b;
}

/** The column of haze a card blocks between itself and the floor. */
function bakeHazeBlock(ss: number): Bake {
  const b = makeBake(64, 128, ss);
  const ctx = b.ctx;
  const v = ctx.createLinearGradient(0, 0, 0, 128);
  v.addColorStop(0, "rgba(6,4,3,0.55)");
  v.addColorStop(0.55, "rgba(6,4,3,0.24)");
  v.addColorStop(1, "rgba(6,4,3,0)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 64, 128);
  const h = ctx.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, "rgba(0,0,0,1)");
  h.addColorStop(0.22, "rgba(0,0,0,0)");
  h.addColorStop(0.78, "rgba(0,0,0,0)");
  h.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, 64, 128);
  return b;
}

/** Hazard hatching, seamless at 45° because the horizontal period divides the tile. */
function bakeHatch(ss: number): Bake {
  const size = 16;
  const period = 8;
  const bar = 3.4;
  const b = makeBake(size, size, ss);
  const ctx = b.ctx;
  ctx.fillStyle = "rgba(10,5,3,0.72)";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = HEMI;
  for (let x = -size; x <= size * 2; x += period) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + bar, 0);
    ctx.lineTo(x + bar - size, size);
    ctx.lineTo(x - size, size);
    ctx.closePath();
    ctx.fill();
  }
  return b;
}

/**
 * Crack network. Main fractures radiate from one origin, each shedding
 * secondaries at shallow angles; junctions get a bright node because that is
 * where a real conchoidal fracture scatters the most light.
 */
function bakeCracks(rng: Rng, ss: number): Bake {
  const w = 256;
  const h = 96;
  const b = makeBake(w, h, ss);
  const ctx = b.ctx;
  const ox = w * rng.range(0.3, 0.7);
  const oy = h * rng.range(0.34, 0.66);

  // Three width buckets so the whole network can be stroked twice — once dark
  // and offset for depth, once bright — instead of drawing each segment twice
  // and desynchronising the random walk.
  const levels = [new Path2D(), new Path2D(), new Path2D()];
  const widths = [1.05, 0.68, 0.42];
  const nodes: number[] = [];

  const branch = (x: number, y: number, angle: number, length: number, depth: number): void => {
    const path = levels[Math.min(2, depth)];
    let px = x;
    let py = y;
    let a = angle;
    const steps = Math.max(2, Math.round(length / 9));
    path.moveTo(px, py);
    for (let i = 0; i < steps; i++) {
      // A fracture front wanders; a straight line reads as a scratch.
      a += rng.range(-0.34, 0.34);
      const seg = length / steps;
      px += Math.cos(a) * seg;
      py += Math.sin(a) * seg;
      path.lineTo(px, py);
      if (depth < 2 && i > 0 && rng.next() < 0.42) {
        nodes.push(px, py, widths[depth + 1]);
        branch(px, py, a + rng.sign() * rng.range(0.42, 1.05), length * rng.range(0.28, 0.5), depth + 1);
        path.moveTo(px, py);
      }
    }
  };

  const mains = rng.int(5, 7);
  const base = rng.range(0, TAU);
  for (let i = 0; i < mains; i++) {
    branch(ox, oy, base + (i / mains) * TAU + rng.range(-0.3, 0.3), rng.range(52, 108), 0);
  }

  // Conchoidal ring right at the impact.
  const crater = new Path2D();
  for (let i = 0; i < 3; i++) {
    crater.arc(ox, oy, 2.4 + i * 2.6, rng.range(0, TAU), rng.range(2, 5.4));
    crater.moveTo(ox, oy);
  }

  ctx.lineCap = "round";
  // Pass 1: the shadow the fissure casts into the panel behind it.
  ctx.save();
  ctx.translate(0.9, 1.1);
  ctx.strokeStyle = "rgba(4,2,1,0.85)";
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = widths[i] * 1.5;
    ctx.stroke(levels[i]);
  }
  ctx.lineWidth = 1;
  ctx.stroke(crater);
  ctx.restore();

  // Pass 2: the lit edge of the break.
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = widths[i];
    ctx.strokeStyle = `rgba(255,244,232,${(0.78 - i * 0.16).toFixed(3)})`;
    ctx.stroke(levels[i]);
  }
  ctx.strokeStyle = "rgba(255,248,238,0.6)";
  ctx.lineWidth = 0.7;
  ctx.stroke(crater);

  // Junctions scatter the most light, which is what makes glass read as glass.
  ctx.fillStyle = "rgba(255,250,242,0.55)";
  for (let i = 0; i < nodes.length; i += 3) {
    ctx.beginPath();
    ctx.arc(nodes[i], nodes[i + 1], nodes[i + 2] * 1.1, 0, TAU);
    ctx.fill();
  }
  return b;
}

/**
 * A machined S/O/O/N tile. Raised from the socket floor: bright chamfer on the
 * key side, dark on the shadow side, brushed grain across the face, and the
 * glyph cut into the metal rather than printed on it.
 */
function bakeChip(letter: string, size: number, ss: number, bakery: RenderDeps["bakery"]): Bake {
  const pad = 2;
  const b = makeBake(size + pad * 2, size + pad * 2, ss);
  const ctx = b.ctx;
  const r = Math.max(1, size * 0.22);
  const face = roundRectPath(pad, pad, size, size, r);

  // Cast shadow onto the socket floor, down-right of the key.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.72)";
  ctx.shadowBlur = size * 0.22;
  ctx.shadowOffsetX = size * 0.07;
  ctx.shadowOffsetY = size * 0.11;
  ctx.fillStyle = "#201914";
  ctx.fill(face);
  ctx.restore();

  ctx.save();
  ctx.clip(face);
  const body = ctx.createLinearGradient(pad, pad, pad + size * 0.5, pad + size);
  body.addColorStop(0, "#cfc6bd");
  body.addColorStop(0.42, "#a29a92");
  body.addColorStop(0.78, "#6f6862");
  body.addColorStop(1, "#575049");
  ctx.fillStyle = body;
  ctx.fillRect(pad, pad, size, size);

  // Brushed grain: the bakery tile carries the real anisotropy. Scaled hard
  // down so a 12 px chip still shows several streaks.
  tiledFill(ctx, bakery.get("brushed-metal"), 0.09, pad, pad, size, size, 0.5, "overlay");
  ctx.restore();

  // Chamfer: two arcs of the rounded rect, lit and shadowed.
  ctx.save();
  ctx.clip(face);
  ctx.lineWidth = Math.max(0.9, size * 0.11);
  ctx.strokeStyle = "rgba(255,246,234,0.72)";
  ctx.beginPath();
  ctx.moveTo(pad, pad + size * 0.72);
  ctx.lineTo(pad, pad + r);
  ctx.arcTo(pad, pad, pad + r, pad, r);
  ctx.lineTo(pad + size * 0.74, pad);
  ctx.stroke();
  ctx.strokeStyle = "rgba(10,6,4,0.62)";
  ctx.beginPath();
  ctx.moveTo(pad + size, pad + size * 0.3);
  ctx.lineTo(pad + size, pad + size - r);
  ctx.arcTo(pad + size, pad + size, pad + size - r, pad + size, r);
  ctx.lineTo(pad + size * 0.28, pad + size);
  ctx.stroke();
  ctx.restore();

  // Engraved glyph.
  ctx.font = monoFont(size * 0.66, 900);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  engrave(
    ctx,
    letter,
    pad + size * 0.5,
    pad + size * 0.53,
    "rgba(255,244,228,0.5)",
    "rgba(14,9,6,0.9)",
    Math.max(0.5, size * 0.055),
  );

  // Hairline of specular right on the top edge — this is what blooms.
  ctx.strokeStyle = "rgba(255,252,246,0.85)";
  ctx.lineWidth = Math.max(0.5, size * 0.045);
  ctx.beginPath();
  ctx.moveTo(pad + r * 0.9, pad + ctx.lineWidth * 0.5);
  ctx.lineTo(pad + size * 0.66, pad + ctx.lineWidth * 0.5);
  ctx.stroke();

  return b;
}

/** Per-kind coloured light pool, used for the shadow tint and the floor spill. */
function bakePool(color: string, ss: number): Bake {
  const size = 128;
  const b = makeBake(size, size, ss);
  const ctx = b.ctx;
  const g = ctx.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
  g.addColorStop(0, withAlpha(color, 0.85));
  g.addColorStop(0.35, withAlpha(color, 0.34));
  g.addColorStop(0.7, withAlpha(color, 0.08));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return b;
}

interface SharedArt {
  sheen: Bake;
  sweep: Bake;
  hotWash: Bake;
  shadowBlob: Bake;
  hazeBlock: Bake;
  hatch: Bake;
  cracks: Bake[];
}

function buildSharedArt(rng: Rng, ss: number): SharedArt {
  const crackRng = rng.fork(0x4352_414b);
  return {
    sheen: bakeSheen(ss),
    sweep: bakeSweep(ss),
    hotWash: bakeHotWash(ss),
    shadowBlob: bakeShadowBlob(ss),
    hazeBlock: bakeHazeBlock(ss),
    hatch: bakeHatch(ss),
    cracks: [bakeCracks(crackRng, ss), bakeCracks(crackRng, ss), bakeCracks(crackRng, ss)],
  };
}

/* ------------------------------------------------------------------ *
 * Card palette — every colour string built once, never in the draw loop
 * ------------------------------------------------------------------ */

interface Palette {
  base: string;
  glassTop: string;
  glassBottom: string;
  wellFloor: string;
  wellLip: string;
  frameLight: string;
  frameMid: string;
  frameDark: string;
  frameShadow: string;
  ink: string;
  dim: string;
  ghost: string;
  /** Idle colour of the demand glyph — cut metal, not a lit lamp. */
  readout: string;
  rail: string;
  railFill: string;
}

function buildPalette(color: string): Palette {
  return {
    base: color,
    // The card hue survives only as a whisper on the panel; hemi orange is the
    // one saturated colour allowed to be loud, and it lives on the ID tab.
    glassTop: mixColor("#171210", color, 0.07),
    glassBottom: mixColor(CHARCOAL, color, 0.03, "oklab"),
    wellFloor: "#0a0706",
    wellLip: shade(ALUMINIUM, -0.22),
    frameLight: shade(ALUMINIUM, 0.42),
    frameMid: ALUMINIUM,
    frameDark: shade(ALUMINIUM, -0.44),
    frameShadow: shade(ALUMINIUM, -0.74),
    ink: BONE,
    dim: ALUMINIUM,
    // Waiting letters have to be legible from across the room: this is the
    // card's progress readout, not a watermark.
    ghost: withAlpha(BONE, 0.52),
    readout: withAlpha(ALUMINIUM, 0.42),
    rail: "#221c18",
    railFill: color,
  };
}

/* ------------------------------------------------------------------ *
 * Card sprite sheet
 * ------------------------------------------------------------------ */

// Detail sheet: everything whose sharpness the player can actually see.
const TILE_SUBSTRATE = 0;
const TILE_FRAME = 1;
const TILE_TYPE = 2;
const TILE_COUNT = 3;
/**
 * The four lit faces plus the grazing-angle rim live on their own sheet at 1×
 * regardless of tier: they are smooth gradients, so supersampling them would
 * quadruple the memory of the largest layer for no visible gain.
 */
const FACE_COUNT = 5;
/** Row 4 is not a face — it is the Fresnel rim that runs right round the edge. */
const FACE_FRESNEL = 4;

/** In-plane normals of the four frame members, canvas y-down. */
const FACE_NORMALS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

interface CardArt {
  sheet: CanvasImageSource;
  faces: CanvasImageSource;
  geo: Geometry;
  pal: Palette;
  pool: Bake;
  /** Device-pixel size of one detail tile. */
  tw: number;
  th: number;
  /** Device-pixel size of one face tile. */
  fw: number;
  fh: number;
  /** Baked label metrics, so the demand glyph and type never re-measure. */
  demandFont: string;
  demandBaseline: number;
  /** Matches the ghost letters baked into the empty sockets. */
  socketFont: string;
  pipRadius: number;
  /** Outer-edge perimeter, so the impact highlight can travel a known distance. */
  rimLength: number;
  key: string;
}

/**
 * Everything behind the glass: backplate, panel tint, the machined wells for the
 * avatar, the demand readout and every answer socket, plus the glass body's own
 * inner shadow and top facet.
 */
function paintSubstrate(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  pal: Palette,
  rng: Rng,
  bakery: RenderDeps["bakery"],
  tier: Tier,
): void {
  const { w, h, glassPath, content } = geo;
  const gx = -w * 0.5;
  const gy = -h * 0.5;

  ctx.save();
  ctx.clip(glassPath);

  // Panel body. Dark glass over a warm substrate: the vertical ramp is the room
  // falling off, not a decorative gradient.
  const body = ctx.createLinearGradient(0, gy, 0, gy + h);
  body.addColorStop(0, pal.glassTop);
  body.addColorStop(0.52, mixColor(pal.glassTop, pal.glassBottom, 0.7));
  body.addColorStop(1, pal.glassBottom);
  ctx.fillStyle = body;
  ctx.fillRect(gx, gy, w, h);

  // Machined backplate showing through the glass — carbon weave reads as a
  // composite panel, which is what a caller rig would actually be built from.
  tiledFill(ctx, bakery.get("carbon-weave"), 0.14, gx, gy, w, h, 0.3, "overlay");

  // Source-colour tab: a lit bar down the left edge of the glass, the one place
  // the card's own hue is allowed to be strong.
  const tab = ctx.createLinearGradient(0, gy, 0, gy + h);
  tab.addColorStop(0, withAlpha(pal.base, 0.25));
  tab.addColorStop(0.45, withAlpha(pal.base, 0.95));
  tab.addColorStop(1, withAlpha(pal.base, 0.3));
  ctx.fillStyle = tab;
  ctx.fillRect(gx + geo.frame, gy + geo.frame + 1, Math.max(1.6, geo.frame * 0.42), h - geo.frame * 2 - 2);

  // Faked refraction: a wide, very low band where the glass thickens, plus the
  // doubled edge you get looking through a bonded panel at a shallow angle.
  const refract = ctx.createLinearGradient(0, gy + h * 0.24, 0, gy + h * 0.62);
  refract.addColorStop(0, "rgba(255,240,224,0)");
  refract.addColorStop(0.5, "rgba(255,240,224,0.045)");
  refract.addColorStop(1, "rgba(255,240,224,0)");
  ctx.fillStyle = refract;
  ctx.fillRect(gx, gy + h * 0.24, w, h * 0.38);

  if (tier.dirt) {
    // Dust and micro-scratches on the outer surface. Deterministic, sparse, and
    // just visible enough that the glass stops reading as a flat fill.
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = WARM_WHITE;
    const specks = Math.round(w * h * 0.0016);
    for (let i = 0; i < specks; i++) {
      const sx = gx + rng.range(2, w - 2);
      const sy = gy + rng.range(2, h - 2);
      ctx.fillRect(sx, sy, rng.range(0.4, 1.1), rng.range(0.4, 0.9));
    }
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = WARM_WHITE;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 3; i++) {
      const sx = gx + rng.range(6, w - 24);
      const sy = gy + rng.range(4, h - 6);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + rng.range(8, 26), sy + rng.range(-3, 3));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // Glass inner shadow: the frame overhangs the panel and drops a real shadow
  // onto it, biased down-right because the key is up-left.
  innerShadow(
    ctx,
    glassPath,
    { x: gx, y: gy, w, h },
    "rgba(0,0,0,0.9)",
    Math.max(3, h * 0.11),
    1.1,
    1.9,
  );

  // Top facet of the glass: the one bright line where the panel edge catches the
  // rig. Thin and hot, so the bloom pass has something honest to work with.
  ctx.save();
  ctx.clip(glassPath);
  ctx.strokeStyle = "rgba(255,247,236,0.36)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(gx + geo.frame + geo.radius * 0.6, gy + geo.frame + 0.6);
  ctx.lineTo(gx + w - geo.frame - geo.radius * 0.6, gy + geo.frame + 0.6);
  ctx.stroke();
  ctx.restore();

  paintWell(ctx, geo.avatarPath, geo.avatar, pal, Math.max(2, geo.avatar.h * 0.18));
  paintWell(ctx, geo.demandPath, geo.demand, pal, Math.max(2, geo.demand.h * 0.16));

  // Demand well furniture: a machined ring plus four cut ticks, so the readout
  // has a mechanical identity even when the card is not targeted.
  ctx.save();
  ctx.clip(geo.demandPath);
  const dcx = geo.demand.x + geo.demand.w * 0.5;
  const dcy = geo.demand.y + geo.demand.h * 0.5;
  ctx.strokeStyle = "rgba(255,240,224,0.09)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(dcx, dcy - geo.demand.h * 0.06, geo.demand.w * 0.36, 0, TAU);
  ctx.stroke();
  ctx.restore();

  // Socket bank.
  const socketBounds: Rect = {
    x: -geo.socketSize * 0.5,
    y: -geo.socketSize * 0.5,
    w: geo.socketSize,
    h: geo.socketSize,
  };
  ctx.font = monoFont(geo.socketSize * 0.64, 800);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const ghostDrop = Math.max(0.45, geo.socketSize * 0.07);
  for (let i = 0; i < geo.total; i++) {
    const sx = geo.sockets[i * 2];
    const sy = geo.sockets[i * 2 + 1];
    ctx.save();
    ctx.translate(sx, sy);
    paintWell(ctx, geo.socketPath, socketBounds, pal, geo.socketRadius);
    // The letter this socket is still waiting for. It sits *proud* of the well
    // floor — a dark contact shadow under a bone face — because a cut glyph on
    // a near-black floor is the one thing on the card nobody can read. This is
    // the at-a-glance answer to "what is left on this caller".
    const ch = LETTERS[i % LETTER_CYCLE];
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.fillText(ch, ghostDrop * 0.6, geo.socketSize * 0.04 + ghostDrop);
    ctx.fillStyle = pal.ghost;
    ctx.fillText(ch, 0, geo.socketSize * 0.04);
    ctx.restore();
  }

  // Progress rail groove.
  const rail = geo.rail;
  ctx.save();
  const railPath = roundRectPath(rail.x, rail.y, rail.w, rail.h, rail.h * 0.5);
  ctx.fillStyle = pal.rail;
  ctx.fill(railPath);
  ctx.strokeStyle = "rgba(255,240,224,0.13)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(rail.x + rail.h * 0.5, rail.y + rail.h);
  ctx.lineTo(rail.x + rail.w - rail.h * 0.5, rail.y + rail.h);
  ctx.stroke();
  // Word ticks: one cut per SOON boundary, so a two-word card is legible as two.
  ctx.fillStyle = "rgba(255,240,224,0.3)";
  for (let word = 1; word < geo.words; word++) {
    const t = word / geo.words;
    ctx.fillRect(rail.x + rail.w * t - 0.4, rail.y - 1.4, 0.8, rail.h + 2.8);
  }
  ctx.restore();

  // Divider between the identity block and the rest of the card.
  ctx.strokeStyle = "rgba(255,240,224,0.07)";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(geo.label.x, geo.label.y - 1.4);
  ctx.lineTo(content.x + content.w, geo.label.y - 1.4);
  ctx.stroke();
}

/** A recess: dark wall on the key side, lit wall opposite. Holes invert. */
function paintWell(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  bounds: Rect,
  pal: Palette,
  radius: number,
): void {
  ctx.save();
  ctx.clip(path);
  const floor = ctx.createLinearGradient(bounds.x, bounds.y, bounds.x + bounds.w * 0.4, bounds.y + bounds.h);
  floor.addColorStop(0, "#050403");
  floor.addColorStop(0.6, pal.wellFloor);
  floor.addColorStop(1, "#151110");
  ctx.fillStyle = floor;
  ctx.fillRect(bounds.x - 1, bounds.y - 1, bounds.w + 2, bounds.h + 2);
  ctx.restore();

  // Offset down-right: in a recess the wall that goes dark is the one nearest
  // the key, because it faces away from it.
  innerShadow(ctx, path, bounds, "rgba(0,0,0,0.95)", Math.max(1.5, bounds.h * 0.22), 0.8, 1.1);

  // Lit lower-right wall of the recess, and a cut lip on the upper-left.
  ctx.save();
  ctx.clip(path);
  ctx.lineWidth = Math.max(0.7, radius * 0.42);
  ctx.strokeStyle = withAlpha(pal.wellLip, 0.5);
  ctx.beginPath();
  ctx.moveTo(bounds.x + bounds.w, bounds.y + bounds.h * 0.34);
  ctx.lineTo(bounds.x + bounds.w, bounds.y + bounds.h - radius);
  ctx.arcTo(bounds.x + bounds.w, bounds.y + bounds.h, bounds.x + bounds.w - radius, bounds.y + bounds.h, radius);
  ctx.lineTo(bounds.x + bounds.w * 0.32, bounds.y + bounds.h);
  ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.beginPath();
  ctx.moveTo(bounds.x, bounds.y + bounds.h * 0.62);
  ctx.lineTo(bounds.x, bounds.y + radius);
  ctx.arcTo(bounds.x, bounds.y, bounds.x + radius, bounds.y, radius);
  ctx.lineTo(bounds.x + bounds.w * 0.68, bounds.y);
  ctx.stroke();
  ctx.restore();
}

/**
 * The aluminium frame at ambient. Directional light is added at draw time from
 * the four face masks; what is baked here is the material and the geometry —
 * grain, ambient occlusion, the inner chamfer, mitre joints and fasteners.
 */
function paintFrameBase(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  pal: Palette,
  bakery: RenderDeps["bakery"],
): void {
  const { w, h, frame, ringPath, glassPath, outerPath } = geo;
  const gx = -w * 0.5;
  const gy = -h * 0.5;

  ctx.save();
  ctx.clip(ringPath, "evenodd");

  // Ambient ramp: the rig is above, so the top member sits a stop up on the
  // bottom one even before any directional term is added.
  // The base value is deliberately low: the frame's brightness has to come from
  // the *directional* passes composited at draw time, because those know where
  // the key actually is. Baking a light extrusion here is exactly what turns a
  // machined frame into a constant-brightness outline on all four sides.
  const amb = ctx.createLinearGradient(0, gy, 0, gy + h);
  amb.addColorStop(0, mixColor(pal.frameMid, pal.frameDark, 0.34));
  amb.addColorStop(0.34, mixColor(pal.frameMid, pal.frameDark, 0.72));
  amb.addColorStop(0.78, mixColor(pal.frameDark, pal.frameShadow, 0.4));
  amb.addColorStop(1, mixColor(pal.frameDark, pal.frameShadow, 0.86));
  ctx.fillStyle = amb;
  ctx.fillRect(gx, gy, w, h);

  tiledFill(ctx, bakery.get("brushed-metal"), 0.24, gx, gy, w, h, 0.55, "overlay");

  // Faint warm bounce off the panel below — the card's own colour lifting the
  // inside face of the frame. Motivated, and it ties frame to glass.
  const bounce = ctx.createLinearGradient(0, gy + h * 0.45, 0, gy + h);
  bounce.addColorStop(0, withAlpha(pal.base, 0));
  bounce.addColorStop(1, withAlpha(pal.base, 0.1));
  ctx.fillStyle = bounce;
  ctx.fillRect(gx, gy, w, h);

  // Mitre joints: real extruded frames are cut at 45° and the seams read.
  ctx.strokeStyle = "rgba(0,0,0,0.34)";
  ctx.lineWidth = 0.6;
  const mx = w * 0.5;
  const my = h * 0.5;
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(gx + frame * 1.5, gy + frame * 1.5 * (my / mx));
  ctx.moveTo(gx + w, gy);
  ctx.lineTo(gx + w - frame * 1.5, gy + frame * 1.5 * (my / mx));
  ctx.moveTo(gx, gy + h);
  ctx.lineTo(gx + frame * 1.5, gy + h - frame * 1.5 * (my / mx));
  ctx.moveTo(gx + w, gy + h);
  ctx.lineTo(gx + w - frame * 1.5, gy + h - frame * 1.5 * (my / mx));
  ctx.stroke();
  ctx.restore();

  // Inner chamfer down to the glass: dark on the top-left wall, lit on the
  // bottom-right one, which is the correct sense for a step *down* into a panel.
  ctx.save();
  ctx.clip(ringPath, "evenodd");
  ctx.lineWidth = Math.max(0.9, frame * 0.3);
  ctx.strokeStyle = "rgba(0,0,0,0.62)";
  ctx.stroke(glassPath);
  ctx.lineWidth = Math.max(0.6, frame * 0.16);
  ctx.strokeStyle = "rgba(255,244,230,0.11)";
  ctx.stroke(glassPath);
  ctx.restore();

  // Outer edge: a dark contact line so the card separates from the set behind
  // it. The lit part of this edge is *not* baked — it is the Fresnel rim, which
  // is composited live against the real light direction.
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,246,234,0.05)";
  ctx.stroke(outerPath);
  ctx.restore();

  // Fasteners: two flush hex heads on the side members. Small, but they are the
  // detail that makes the frame read as extruded rather than drawn.
  const studR = Math.max(1.1, frame * 0.3);
  for (let i = 0; i < 2; i++) {
    const sx = i === 0 ? gx + frame * 0.5 : gx + w - frame * 0.5;
    const sy = gy + h * 0.5;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.26;
      const px = Math.cos(a) * studR;
      const py = Math.sin(a) * studR;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(20,15,12,0.55)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.frameLight, 0.4);
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.restore();
  }

  // Proximity alert groove, machined into the bottom member and empty until the
  // card is in trouble.
  const alert = geo.alert;
  ctx.save();
  const groove = roundRectPath(alert.x, alert.y, alert.w, alert.h, alert.h * 0.5);
  ctx.fillStyle = "rgba(6,4,3,0.75)";
  ctx.fill(groove);
  ctx.strokeStyle = "rgba(255,244,230,0.12)";
  ctx.lineWidth = 0.4;
  ctx.stroke(groove);
  ctx.restore();
}

/**
 * One frame member's lit face, baked as a warm-white mask. The gradient runs
 * perpendicular to the member: hottest on the outer chamfer, falling across the
 * flat, dead at the inner edge.
 */
function paintFace(ctx: CanvasRenderingContext2D, geo: Geometry, side: number): void {
  const { w, h, frame, ringPath, outerPath } = geo;
  const gx = -w * 0.5;
  const gy = -h * 0.5;

  if (side === FACE_FRESNEL) {
    // Grazing-angle rim. Reflectance on a metal rises hard toward 90°, so the
    // very outer chamfer stays bright even on the members that face away from
    // the key — this is the term that makes the card read as a solid extrusion
    // rather than as four independently-lit bars. Two strokes: a hairline of
    // near-specular right on the corner, and a soft shoulder inside it.
    ctx.save();
    ctx.clip(ringPath, "evenodd");
    ctx.lineWidth = Math.max(1.2, frame * 0.62);
    ctx.strokeStyle = "rgba(255,242,224,0.3)";
    ctx.stroke(outerPath);
    ctx.lineWidth = Math.max(0.7, frame * 0.24);
    ctx.strokeStyle = "rgba(255,250,240,0.9)";
    ctx.stroke(outerPath);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.clip(ringPath, "evenodd");

  // Sector wedge: the triangle from the centre through two outer corners lands
  // exactly on the mitre diagonals, so the four faces tile the ring with no gap.
  ctx.beginPath();
  ctx.moveTo(0, 0);
  if (side === 0) {
    ctx.lineTo(-w, -h);
    ctx.lineTo(w, -h);
  } else if (side === 1) {
    ctx.lineTo(w, -h);
    ctx.lineTo(w, h);
  } else if (side === 2) {
    ctx.lineTo(w, h);
    ctx.lineTo(-w, h);
  } else {
    ctx.lineTo(-w, h);
    ctx.lineTo(-w, -h);
  }
  ctx.closePath();
  ctx.clip();

  let g: CanvasGradient;
  if (side === 0) g = ctx.createLinearGradient(0, gy, 0, gy + frame);
  else if (side === 1) g = ctx.createLinearGradient(gx + w, 0, gx + w - frame, 0);
  else if (side === 2) g = ctx.createLinearGradient(0, gy + h, 0, gy + h - frame);
  else g = ctx.createLinearGradient(gx, 0, gx + frame, 0);

  // A machined aluminium chamfer returns a *narrow* specular line, not a wide
  // wash: the hot band is one sixth of the member and everything inboard of it
  // falls away fast. Widening this is what turns a frame into a UI stroke.
  g.addColorStop(0, "rgba(255,244,228,0.22)");
  g.addColorStop(0.15, "rgba(255,250,242,1)");
  g.addColorStop(0.34, "rgba(255,240,220,0.3)");
  g.addColorStop(0.66, "rgba(255,236,212,0.07)");
  g.addColorStop(1, "rgba(255,236,212,0)");
  ctx.fillStyle = g;
  ctx.fillRect(gx, gy, w, h);
  ctx.restore();
}

/** Broadcast type: the LIVE CALLER slab and the question itself. */
function paintType(ctx: CanvasRenderingContext2D, geo: Geometry, pal: Palette, label: string): void {
  const { identity, label: labelBox } = geo;

  // --- LIVE CALLER slab -------------------------------------------------
  const tagH = identity.h;
  const tagFont = monoFont(Math.max(5, tagH * 0.56), 800);
  ctx.font = tagFont;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const tracking = Math.max(0.4, tagH * 0.11);
  const full = "LIVE CALLER";
  const short = "LIVE";
  const fullW = trackedWidth(ctx, full, tracking);
  const tallyW = Math.max(2, tagH * 0.28);
  const padX = Math.max(2.5, tagH * 0.32);
  // Never let the tag eat more than half the identity band.
  const text = fullW + tallyW + padX * 2 <= identity.w * 0.62 ? full : short;
  const textW = trackedWidth(ctx, text, tracking);
  const tagW = textW + tallyW + padX * 1.7;

  const slab = roundRectPath(identity.x, identity.y, tagW, tagH, Math.max(1, tagH * 0.16));
  ctx.fillStyle = "rgba(15,10,7,0.82)";
  ctx.fill(slab);
  ctx.save();
  ctx.clip(slab);
  // Tally bar. The lamp itself is drawn live so it can breathe.
  ctx.fillStyle = withAlpha(HEMI, 0.55);
  ctx.fillRect(identity.x, identity.y, tallyW, tagH);
  ctx.restore();
  ctx.strokeStyle = "rgba(255,240,224,0.14)";
  ctx.lineWidth = 0.5;
  ctx.stroke(slab);

  ctx.fillStyle = withAlpha(BONE, 0.86);
  drawTracked(ctx, text, identity.x + tallyW + padX, identity.y + tagH * 0.54, tracking);

  // --- Question label ---------------------------------------------------
  const fit = fitDisplay(ctx, label, labelBox.w, labelBox.h * 1.0, 0.72);
  ctx.save();
  ctx.translate(labelBox.x, labelBox.y + labelBox.h * 0.78);
  ctx.scale(fit.condense, 1);
  ctx.font = fit.font;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // A real drop shadow, not a glow: the type must survive the bloom pass without
  // dissolving into it, so the contact edge stays dark and tight.
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = Math.max(1.5, fit.size * 0.16);
  ctx.shadowOffsetX = 0.8;
  ctx.shadowOffsetY = 1.3;
  ctx.fillStyle = "#000000";
  ctx.fillText(label, 0, 0);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Bone with a warm falloff, as if lit from the rig above.
  const ink = ctx.createLinearGradient(0, -fit.size * 0.78, 0, fit.size * 0.16);
  ink.addColorStop(0, "#fbf6f1");
  ink.addColorStop(0.62, pal.ink);
  ink.addColorStop(1, mixColor(pal.ink, pal.base, 0.34));
  ctx.fillStyle = ink;
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Card art assembly
 * ------------------------------------------------------------------ */

function buildCardArt(
  label: string,
  w: number,
  h: number,
  total: number,
  color: string,
  tier: Tier,
  rng: Rng,
  bakery: RenderDeps["bakery"],
  key: string,
): CardArt {
  const geo = buildGeometry(w, h, total);
  const pal = buildPalette(color);
  const ss = tier.ss;

  const sheet = makeSheet(w, h, TILE_COUNT, ss);
  const faceSheet = makeSheet(w, h, FACE_COUNT, 1);

  const tile = (target: Sheet, index: number, paint: (c: CanvasRenderingContext2D) => void): void => {
    const c = target.ctx;
    c.save();
    // Card-local space: origin at the tile's centre, matching every Path2D.
    c.translate(w * 0.5, h * (index + 0.5));
    c.beginPath();
    c.rect(-w * 0.5, -h * 0.5, w, h);
    c.clip();
    paint(c);
    c.restore();
  };

  tile(sheet, TILE_SUBSTRATE, (c) => paintSubstrate(c, geo, pal, rng.fork(0x5355_4253), bakery, tier));
  tile(sheet, TILE_FRAME, (c) => paintFrameBase(c, geo, pal, bakery));
  tile(sheet, TILE_TYPE, (c) => paintType(c, geo, pal, label));
  for (let side = 0; side < FACE_COUNT; side++) tile(faceSheet, side, (c) => paintFace(c, geo, side));

  return {
    sheet: sheet.canvas,
    faces: faceSheet.canvas,
    geo,
    pal,
    pool: bakePool(color, 1),
    tw: sheet.pw,
    th: sheet.tilePx,
    fw: faceSheet.pw,
    fh: faceSheet.tilePx,
    demandFont: monoFont(geo.demand.h * 0.56, 900),
    demandBaseline: geo.demand.y + geo.demand.h * 0.42,
    socketFont: monoFont(geo.socketSize * 0.64, 800),
    pipRadius: Math.max(0.9, geo.demand.w * 0.045),
    // Rounded-rect perimeter: straights plus one full circle of corner arc.
    rimLength: 2 * (w + h) - 8 * geo.radius + TAU * geo.radius,
    key,
  };
}

/* ------------------------------------------------------------------ *
 * Caller identity — one avatar and one handle per question id
 * ------------------------------------------------------------------ */

const HANDLE_HEAD = [
  "wen", "gm", "ser", "anon", "zk", "hemi", "proof", "block", "node", "tick",
  "soon", "based", "fren", "lurk", "maxi", "degen", "tunnel", "stake", "seq",
  "miner", "chain", "hodl", "patient", "bit", "roll", "shard", "epoch",
] as const;

const HANDLE_TAIL = [
  "fren", "chad", "enjoyer", "maxi", "hunter", "watcher", "pilled", "poster",
  "caller", "andy", "whale", "sailor", "monk", "raider", "scholar", "pleb",
  "dev", "ops", "guy", "eth",
] as const;

const HEX = "0123456789abcdef";

/** A plausible community handle, deterministic in the question id. */
function makeHandle(rng: Rng): string {
  const shape = rng.int(0, 4);
  if (shape === 4) {
    let hex = "";
    for (let i = 0; i < 4; i++) hex += HEX[rng.int(0, 15)];
    let tail = "";
    for (let i = 0; i < 2; i++) tail += HEX[rng.int(0, 15)];
    return `@0x${hex}..${tail}`;
  }
  const head = rng.pick(HANDLE_HEAD);
  const tail = rng.pick(HANDLE_TAIL);
  if (shape === 0) return `@${head}${tail}`;
  if (shape === 1) return `@${head}${tail}${rng.int(10, 99)}`;
  if (shape === 2) return `@${head}_${tail}`;
  return `@${head}${rng.int(100, 999)}`;
}

/**
 * The caller bust.
 *
 * A late-night call-in feed: an under-lit person against a practical lamp, cut
 * to a hard silhouette with a rim of key on the upper-left edge. Silhouettes
 * vary by head shape, headgear and shoulder build, which is enough for every
 * card on screen to read as a different human without a single photograph.
 */
function bakeAvatar(size: number, rng: Rng, bakery: RenderDeps["bakery"], ss: number): Bake {
  const b = makeBake(size, size, ss);
  const ctx = b.ctx;
  const S = size;

  // --- backdrop ---------------------------------------------------------
  const room = ctx.createLinearGradient(0, 0, 0, S);
  room.addColorStop(0, "#2a221d");
  room.addColorStop(0.55, "#171210");
  room.addColorStop(1, "#0c0908");
  ctx.fillStyle = room;
  ctx.fillRect(0, 0, S, S);

  // Practical lamp behind the caller. Off-centre, because nobody centres a lamp.
  const lampX = S * rng.range(0.2, 0.8);
  const lampY = S * rng.range(0.18, 0.42);
  const lamp = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, S * 0.62);
  lamp.addColorStop(0, "rgba(255,196,140,0.55)");
  lamp.addColorStop(0.4, "rgba(255,150,90,0.16)");
  lamp.addColorStop(1, "rgba(255,120,60,0)");
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, S, S);

  // --- silhouette -------------------------------------------------------
  const headR = S * rng.range(0.16, 0.2);
  const headAspect = rng.range(0.86, 1.18);
  const headY = S * rng.range(0.4, 0.46);
  const headX = S * rng.range(0.44, 0.56);
  const shoulderW = S * rng.range(0.58, 0.8);
  const shoulderY = S * rng.range(0.78, 0.88);
  const headgear = rng.int(0, 6);

  const bust = new Path2D();
  // Shoulders as one swept arc; the control points are what make a build read
  // as broad or narrow rather than as a rectangle with a head on it.
  bust.moveTo(headX - shoulderW * 0.5, S + 2);
  bust.bezierCurveTo(
    headX - shoulderW * 0.5,
    shoulderY,
    headX - headR * 1.25,
    shoulderY - S * 0.06,
    headX - headR * 0.62,
    headY + headR * 0.72,
  );
  bust.lineTo(headX + headR * 0.62, headY + headR * 0.72);
  bust.bezierCurveTo(
    headX + headR * 1.25,
    shoulderY - S * 0.06,
    headX + shoulderW * 0.5,
    shoulderY,
    headX + shoulderW * 0.5,
    S + 2,
  );
  bust.closePath();

  const head = new Path2D();
  if (headgear === 2) {
    // Square jaw: a rounded rect reads as a different person entirely.
    addRoundRect(
      head,
      headX - headR,
      headY - headR * headAspect,
      headR * 2,
      headR * 2 * headAspect,
      headR * 0.55,
    );
  } else {
    head.ellipse(headX, headY, headR, headR * headAspect, 0, 0, TAU);
  }

  const gear = new Path2D();
  if (headgear === 1) {
    // Cap with a brim, angled by the rng.
    gear.ellipse(headX, headY - headR * 0.5, headR * 1.04, headR * 0.78, 0, Math.PI, TAU);
    const dir = rng.sign();
    gear.moveTo(headX, headY - headR * 0.5);
    gear.lineTo(headX + dir * headR * 2.1, headY - headR * 0.34);
    gear.lineTo(headX + dir * headR * 2.05, headY - headR * 0.08);
    gear.lineTo(headX, headY - headR * 0.18);
    gear.closePath();
  } else if (headgear === 3) {
    // Hood: a wide cowl swallowing the head.
    gear.ellipse(headX, headY - headR * 0.14, headR * 1.4, headR * 1.34 * headAspect, 0, Math.PI, TAU);
    gear.rect(headX - headR * 1.4, headY - headR * 0.2, headR * 2.8, headR * 1.1);
  } else if (headgear === 4) {
    // Spiked hair.
    const spikes = rng.int(5, 8);
    gear.moveTo(headX - headR, headY - headR * 0.3);
    for (let i = 0; i <= spikes; i++) {
      const t = i / spikes;
      const a = Math.PI + t * Math.PI;
      const bx = headX + Math.cos(a) * headR * 1.02;
      const by = headY + Math.sin(a) * headR * headAspect * 1.02;
      gear.lineTo(bx, by);
      if (i < spikes) {
        const am = Math.PI + (t + 0.5 / spikes) * Math.PI;
        gear.lineTo(
          headX + Math.cos(am) * headR * rng.range(1.2, 1.5),
          headY + Math.sin(am) * headR * headAspect * rng.range(1.3, 1.6),
        );
      }
    }
    gear.closePath();
  } else if (headgear === 5) {
    // Long hair falling past the jaw.
    gear.ellipse(headX, headY - headR * 0.16, headR * 1.16, headR * 1.1 * headAspect, 0, Math.PI, TAU);
    gear.rect(headX - headR * 1.16, headY - headR * 0.2, headR * 0.42, headR * 1.9);
    gear.rect(headX + headR * 0.74, headY - headR * 0.2, headR * 0.42, headR * 1.9);
  } else if (headgear === 6) {
    // Studio cans, which is what half the callers are wearing anyway.
    gear.ellipse(headX, headY - headR * 0.72, headR * 1.02, headR * 0.36, 0, Math.PI, TAU);
    addRoundRect(gear, headX - headR * 1.3, headY - headR * 0.34, headR * 0.5, headR * 0.86, headR * 0.22);
    addRoundRect(gear, headX + headR * 0.8, headY - headR * 0.34, headR * 0.5, headR * 0.86, headR * 0.22);
  }

  const body = new Path2D();
  body.addPath(bust);
  body.addPath(head);
  body.addPath(gear);

  // Key rim: draw the whole silhouette shifted *toward* the key in bone, then
  // the silhouette itself on top, leaving a lit edge on the upper-left only.
  ctx.save();
  ctx.translate(-S * 0.022, -S * 0.026);
  ctx.fillStyle = "rgba(255,226,196,0.62)";
  ctx.fill(body);
  ctx.restore();

  ctx.fillStyle = "#080605";
  ctx.fill(body);

  // A lit visor / glasses line: one bright horizontal accent at the eye line is
  // the cheapest way to make a silhouette feel like it is looking at you.
  if (rng.next() < 0.45) {
    ctx.fillStyle = "rgba(255,222,190,0.34)";
    ctx.fillRect(headX - headR * 0.82, headY - headR * 0.1, headR * 1.64, Math.max(0.8, headR * 0.16));
  }

  // --- feed treatment ---------------------------------------------------
  // Compression banding: one displaced slice, frozen. Reads as a bad uplink.
  const sliceY = S * rng.range(0.25, 0.75);
  const sliceH = Math.max(1, S * 0.045);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.1;
  ctx.drawImage(b.canvas, 0, sliceY * (b.ph / S), b.pw, sliceH * (b.ph / S), S * 0.035, sliceY, S, sliceH);
  ctx.restore();

  // Scanlines.
  ctx.fillStyle = "rgba(0,0,0,0.24)";
  for (let y = 0; y < S; y += 2) ctx.fillRect(0, y, S, 0.7);

  tiledFill(ctx, bakery.get("noise-fine"), 0.22, 0, 0, S, S, 0.14, "overlay");

  // Corner falloff, so the tile sits into its recess instead of on top of it.
  const vig = ctx.createRadialGradient(S * 0.5, S * 0.46, S * 0.16, S * 0.5, S * 0.5, S * 0.78);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.62)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, S, S);

  return b;
}

/** The handle strip: tracked mono in aluminium, baked so it never re-measures. */
function bakeHandle(text: string, w: number, h: number, ss: number): Bake {
  const b = makeBake(Math.max(8, w), Math.max(4, h), ss);
  const ctx = b.ctx;
  const size = Math.max(5, h * 0.56);
  ctx.font = monoFont(size, 700);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const tracking = Math.max(0.2, size * 0.07);

  let shown = text;
  while (shown.length > 4 && trackedWidth(ctx, shown, tracking) > w) {
    shown = shown.slice(0, -1);
  }
  if (shown !== text) shown = `${shown.slice(0, -1)}…`;

  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = 1.6;
  ctx.shadowOffsetY = 0.7;
  ctx.fillStyle = withAlpha(ALUMINIUM, 0.94);
  drawTracked(ctx, shown, 0, h * 0.54, tracking);
  return b;
}

interface CallerArt {
  avatar: Bake;
  handle: Bake;
  handleText: string;
}

/* ------------------------------------------------------------------ *
 * Per-card runtime state
 * ------------------------------------------------------------------ */

interface CardState {
  id: number;
  art: CardArt;
  caller: CallerArt;
  /** 0 → 1 as the card becomes the valid target for the loaded letter. */
  target: Spring;
  /** Smoothed danger, so a jittery source value cannot strobe the frame. */
  heat: number;
  bobPhase: number;
  bobRate: number;
  sheenPhase: number;
  scanPhase: number;
  tallyPhase: number;
  progress: number;
  /** Timestamp each socket was filled, or −1 while empty. */
  seatAt: Float32Array;
  crack: Bake;
  crackOx: number;
  crackOy: number;
  seen: number;
}

/** Bounded LRU so a long round cannot grow the caches without limit. */
function trim<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export function createQuestionRenderer(deps: RenderDeps): QuestionRenderer {
  const { bakery, particles, rng } = deps;

  const artRng = rng.fork(0x4341_5244); // "CARD"
  const callerRng = rng.fork(0x4341_4c4c); // "CALL"

  const cardArt = new Map<string, CardArt>();
  const callerArt = new Map<number, CallerArt>();
  const chips = new Map<string, Bake>();
  const states = new Map<number, CardState>();
  const hatchPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

  let shared: SharedArt | null = null;
  let sharedSs = 0;
  let now = 0;
  let rawNow = 0;
  let frame = 0;

  const tierFor = (scene: SceneContext): Tier => TIERS[scene.quality] ?? TIERS.high;

  const sharedFor = (tier: Tier): SharedArt => {
    if (!shared || sharedSs !== tier.ss) {
      shared = buildSharedArt(rng.fork(0x5348_5244), tier.ss);
      sharedSs = tier.ss;
    }
    return shared;
  };

  const chipFor = (letter: string, size: number, ss: number): Bake => {
    const key = `${letter}|${Math.round(size * 4)}|${ss}`;
    let hit = chips.get(key);
    if (!hit) {
      hit = bakeChip(letter, size, ss, bakery);
      chips.set(key, hit);
      trim(chips, 48);
    }
    return hit;
  };

  const hatchFor = (ctx: CanvasRenderingContext2D, tier: Tier): CanvasPattern | null => {
    let hit = hatchPatterns.get(ctx);
    if (!hit) {
      const created = ctx.createPattern(sharedFor(tier).hatch.canvas, "repeat");
      if (!created) return null;
      // Undo the bake supersample so the hazard stripes keep their design pitch.
      if (tier.ss !== 1) {
        const inv = 1 / tier.ss;
        created.setTransform({ a: inv, b: 0, c: 0, d: inv, e: 0, f: 0 });
      }
      hatchPatterns.set(ctx, created);
      hit = created;
    }
    return hit;
  };

  const artFor = (q: QuestionView, tier: Tier): CardArt => {
    const w = clamp(Math.round(q.width || 168), 96, 460);
    const h = clamp(Math.round(q.height || 62), 34, 180);
    const total = Math.max(1, Math.min(16, Math.round(q.total) || LETTER_CYCLE));
    const key = `${q.kind}|${w}x${h}|${total}|${q.color}|${tier.ss}|${tier.dirt ? 1 : 0}`;
    let hit = cardArt.get(key);
    if (!hit) {
      hit = buildCardArt(
        q.label,
        w,
        h,
        total,
        q.color,
        tier,
        artRng.fork(hashKind(q.kind, w, h, total)),
        bakery,
        key,
      );
      cardArt.set(key, hit);
      trim(cardArt, 24);
    }
    return hit;
  };

  const callerFor = (id: number, art: CardArt, tier: Tier): CallerArt => {
    let hit = callerArt.get(id);
    if (hit && hit.avatar.w === art.geo.avatar.w) {
      // Refresh recency without rebaking.
      callerArt.delete(id);
      callerArt.set(id, hit);
      return hit;
    }
    const stream = callerRng.fork(id * 2654435761 + 0x9e37);
    const identity = art.geo.identity;
    const avatar = bakeAvatar(art.geo.avatar.w, stream, bakery, tier.ss);
    const handleText = makeHandle(stream);
    // The handle is right-aligned in the identity band, so it never has to know
    // how wide the LIVE slab turned out to be.
    const handle = bakeHandle(handleText, Math.max(10, identity.w * 0.52), identity.h, tier.ss);
    hit = { avatar, handle, handleText };
    callerArt.set(id, hit);
    trim(callerArt, 32);
    return hit;
  };

  const stateFor = (q: QuestionView, scene: SceneContext): CardState => {
    const tier = tierFor(scene);
    const art = artFor(q, tier);
    let st = states.get(q.id);
    if (!st || st.art.key !== art.key) {
      const seatAt = new Float32Array(art.geo.total);
      // Anything already answered at first sight is treated as long settled.
      for (let i = 0; i < seatAt.length; i++) seatAt[i] = i < q.progress ? SEAT_SETTLED : SEAT_EMPTY;
      const seed = callerRng.fork(q.id ^ 0x51ed);
      const sheets = sharedFor(tier).cracks;
      st = {
        id: q.id,
        art,
        caller: callerFor(q.id, art, tier),
        target: createSpring({ stiffness: 240, damping: 21, mass: 1 }),
        heat: q.danger,
        bobPhase: seed.range(0, TAU),
        bobRate: seed.range(0.72, 1.05),
        sheenPhase: seed.range(0, TAU),
        scanPhase: seed.range(0, 1),
        tallyPhase: seed.range(0, TAU),
        progress: Math.max(0, Math.min(art.geo.total, q.progress)),
        seatAt,
        crack: sheets[seed.int(0, sheets.length - 1)],
        crackOx: seed.range(-0.16, 0.16),
        crackOy: seed.range(-0.18, 0.18),
        seen: frame,
      };
      states.set(q.id, st);
    } else {
      st.art = art;
    }
    return st;
  };

  /* ---- update ---------------------------------------------------- */

  function update(questions: readonly QuestionView[], scene: SceneContext): void {
    frame++;
    const dt = Math.min(0.1, Math.max(0, scene.dt));
    const rawDt = Math.min(0.1, Math.max(0, scene.rawDt));
    now += dt;
    rawNow += rawDt;

    const tier = tierFor(scene);
    const sparks = tier.seatSparks && !scene.reducedMotion;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const st = stateFor(q, scene);
      const geo = st.art.geo;
      st.seen = frame;

      st.target.set(q.targeted ? 1 : 0);
      st.target.update(dt);
      st.heat = damp(st.heat, clamp01(q.danger), 7, dt);
      st.bobPhase += dt * st.bobRate;
      st.sheenPhase += dt * 0.42;
      st.tallyPhase += rawDt;
      st.scanPhase += rawDt / (scene.reducedMotion ? 3.6 : 1.15);
      if (st.scanPhase > 1) st.scanPhase -= Math.floor(st.scanPhase);

      // New letters seated since the last frame.
      const progress = Math.max(0, Math.min(geo.total, Math.round(q.progress)));
      if (progress > st.progress) {
        const cos = Math.cos(q.rotation);
        const sin = Math.sin(q.rotation);
        for (let s = st.progress; s < progress; s++) {
          st.seatAt[s] = now + (s - st.progress) * 0.045;
          if (!sparks) continue;
          const lx = geo.sockets[s * 2] * q.scaleX;
          const ly = geo.sockets[s * 2 + 1] * q.scaleY;
          particles.emit("impact-spark", {
            x: q.x + lx * cos - ly * sin,
            y: q.y + lx * sin + ly * cos,
            count: 4,
            color: WARM_WHITE,
            color2: q.color,
            speed: 96,
            speedVariance: 0.7,
            spread: TAU,
            life: 0.24,
            scale: 0.45,
            gravity: 190,
            additive: true,
          });
        }
      } else if (progress < st.progress) {
        for (let s = progress; s < geo.total; s++) st.seatAt[s] = SEAT_EMPTY;
      }
      st.progress = progress;
    }

    // Cards that vanished this frame release their state immediately.
    for (const [id, st] of states) if (st.seen !== frame) states.delete(id);
  }

  /* ---- shadows --------------------------------------------------- */

  function drawShadows(
    ctx: CanvasRenderingContext2D,
    questions: readonly QuestionView[],
    scene: SceneContext,
  ): void {
    if (questions.length === 0) return;
    const tier = tierFor(scene);
    const art = sharedFor(tier);
    const stageY = Number.isFinite(scene.stageY) ? scene.stageY : STAGE_Y;
    const keyX = scene.width * KEY_X_FRACTION;

    ctx.save();
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const st = states.get(q.id);
      const geo = st ? st.art.geo : null;
      const w = geo ? geo.w : q.width;
      const h = geo ? geo.h : q.height;

      const bottom = q.y + h * 0.5;
      const above = Math.max(0, stageY - bottom);
      // Softness ramp: a card at head height casts almost nothing, a card about
      // to land casts a hard, dark contact patch.
      const k = clamp01(above / 360);
      const entry = clamp01(q.age / 0.3);

      // True point-light projection onto the floor plane.
      const t = clamp((stageY - KEY_Y) / Math.max(40, q.y - KEY_Y), 1, 2.6);
      const cx = keyX + (q.x - keyX) * t;
      const spanX = w * (0.68 + k * 0.72) * t * 0.62;
      const spanY = h * (0.42 + k * 0.85);
      // Skew turns the blob into a projected parallelogram instead of a puddle.
      const skew = clamp((cx - q.x) / Math.max(60, above + 60), -1.2, 1.2) * 0.55;

      if (tier.shadowLayers >= 3 && above > 12) {
        // The column of haze the card is standing in front of goes dark.
        ctx.globalAlpha = 0.34 * clamp01(above / 220) * entry;
        ctx.drawImage(
          art.hazeBlock.canvas,
          q.x - w * 0.46,
          bottom - h * 0.1,
          w * 0.92,
          above + h * 0.1,
        );
      }

      ctx.save();
      ctx.translate(cx, stageY + spanY * 0.1);
      ctx.transform(1, 0, skew, 1, 0, 0);
      ctx.globalAlpha = clamp01(0.62 - 0.34 * k) * entry;
      ctx.drawImage(art.shadowBlob.canvas, -spanX * 0.5, -spanY * 0.5, spanX, spanY);
      if (tier.shadowLayers >= 2 && st) {
        // The penumbra picks up the card's own colour: the panel is lit, so the
        // light it blocks is not neutral.
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.16 * (1 - k) * (1 - k) * entry;
        ctx.drawImage(st.art.pool.canvas, -spanX * 0.62, -spanY * 0.7, spanX * 1.24, spanY * 1.4);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();

      if (tier.shadowLayers >= 2 && st && k < 0.6) {
        // Contact spill: close to the floor the card starts lighting it.
        const spill = (1 - k / 0.6) * (1 - k / 0.6);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.2 * spill * entry;
        ctx.drawImage(
          st.art.pool.canvas,
          q.x - w * 0.6,
          stageY - h * 0.5,
          w * 1.2,
          h * 0.9,
        );
        ctx.globalCompositeOperation = "source-over";
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ---- cards ----------------------------------------------------- */

  function drawCard(
    ctx: CanvasRenderingContext2D,
    q: QuestionView,
    st: CardState,
    scene: SceneContext,
    tier: Tier,
    shrd: SharedArt,
    keyX: number,
  ): void {
    const { geo, pal } = st.art;
    const w = geo.w;
    const h = geo.h;
    const rm = scene.reducedMotion;
    const age = Math.max(0, q.age);

    /* -- entry choreography ------------------------------------- */
    const open = clamp01((age - 0.1) / ENTRY_UNFOLD);
    const openE = rm ? ease.outCubic(open) : ease.outBack(open);
    const typeIn = clamp01((age - ENTRY_TYPE_IN) / 0.21);
    const glassIn = clamp01((age - 0.14) / 0.2);
    const cardAlpha = clamp01(age / 0.09);

    /* -- state values -------------------------------------------- */
    const tg = clamp01(st.target.value);
    const heat = clamp01(st.heat);
    const hotAmt = smoothstep(0.28, 1, heat);
    const pulseAmp = rm ? 0.25 : 1;
    // 2.2 Hz: alarming, and comfortably under the 3 Hz flash ceiling.
    const hotPulse = 0.5 + 0.5 * Math.sin(rawNow * TAU * 2.2 + st.bobPhase);
    // `sinceHit` on a card that has never been hit tracks its age, so the flash
    // only fires when the last hit is demonstrably younger than the card.
    const struck = q.sinceHit >= 0 && q.sinceHit < HIT_SECONDS && q.sinceHit < age - 0.03;
    const hit = struck ? Math.exp(-q.sinceHit / 0.075) : 0;
    // A separate, much shorter envelope for the mechanical reaction: the panel
    // takes the blow and recovers inside ~90 ms, long before the light does.
    const punch = struck ? Math.exp(-q.sinceHit / 0.055) * (rm ? 0.3 : 1) : 0;
    // The socket that just took a tile is where the energy went.
    const strikeIndex = clamp(st.progress - 1, 0, geo.total - 1);
    const strikeX = geo.sockets[strikeIndex * 2];
    const strikeY = geo.sockets[strikeIndex * 2 + 1];

    /* -- idle motion --------------------------------------------- */
    const bobAmp = rm ? 0.45 : 1.45;
    const bob = Math.sin(st.bobPhase * TAU * 0.3) * bobAmp * (1 - heat * 0.45);
    const wobble = rm ? 0 : Math.sin(st.bobPhase * TAU * 0.21 + 1.1) * 0.006 * (1 - heat * 0.5);
    // Structural tremor only at genuine risk, and never under reduced motion.
    const tremor = rm ? 0 : smoothstep(0.6, 1, heat) * Math.sin(rawNow * 41 + st.bobPhase) * 0.85;

    // Impact squash rides on top of whatever the simulation already applied:
    // the panel is driven into itself along the shot axis and springs back.
    const scaleX = q.scaleX * (1 + 0.055 * punch);
    const scaleY = q.scaleY * lerp(0.055, 1, openE) * (1 - 0.085 * punch);
    const rot = q.rotation + wobble;

    ctx.save();
    ctx.translate(q.x + tremor, q.y + bob);
    if (rot !== 0) ctx.rotate(rot);
    ctx.scale(scaleX, scaleY);
    ctx.globalAlpha = cardAlpha;

    const sheet = st.art.sheet;
    const tw = st.art.tw;
    const th = st.art.th;
    const drawTile = (index: number, alpha: number): void => {
      ctx.globalAlpha = alpha * cardAlpha;
      ctx.drawImage(sheet, 0, index * th, tw, th, -w * 0.5, -h * 0.5, w, h);
    };

    /* -- 1. substrate -------------------------------------------- */
    drawTile(TILE_SUBSTRATE, glassIn);

    /* -- 2. heat rising through the panel ------------------------ */
    if (hotAmt > 0.01) {
      ctx.save();
      ctx.clip(geo.glassPath);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = cardAlpha * hotAmt * (0.16 + 0.1 * hotPulse * pulseAmp);
      ctx.drawImage(shrd.hotWash.canvas, -w * 0.5, -h * 0.5, w, h);
      ctx.restore();
    }

    /* -- 3. caller bust ------------------------------------------ */
    if (glassIn > 0.02) {
      ctx.save();
      ctx.clip(geo.avatarPath);
      ctx.globalAlpha = cardAlpha * glassIn;
      ctx.drawImage(st.caller.avatar.canvas, geo.avatar.x, geo.avatar.y, geo.avatar.w, geo.avatar.h);
      ctx.restore();
    }

    /* -- 4. broadcast type, sliding in on entry ------------------ */
    if (typeIn > 0.01) {
      ctx.save();
      ctx.clip(geo.contentPath);
      if (typeIn < 1) ctx.translate(-(1 - ease.outQuint(typeIn)) * 11, 0);
      drawTile(TILE_TYPE, typeIn);
      ctx.restore();
      // Handle, right-aligned in the identity band so it never collides with
      // the LIVE slab whatever the card width.
      const hb = st.caller.handle;
      ctx.globalAlpha = cardAlpha * typeIn * 0.95;
      ctx.drawImage(
        hb.canvas,
        geo.identity.x + geo.identity.w - hb.w,
        geo.identity.y,
        hb.w,
        hb.h,
      );
    }

    /* -- 5. tally lamp ------------------------------------------- */
    {
      const tallyW = Math.max(2, geo.identity.h * 0.28);
      const rate = rm ? 0 : heat > 0.6 ? 2.6 : 1.35;
      const blink = rate === 0 ? 0.72 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(rawNow * TAU * rate + st.tallyPhase));
      ctx.globalAlpha = cardAlpha * glassIn * blink;
      ctx.fillStyle = HEMI;
      ctx.fillRect(
        geo.identity.x + tallyW * 0.5 - tallyW * 0.22,
        geo.identity.y + geo.identity.h * 0.3,
        tallyW * 0.44,
        geo.identity.h * 0.4,
      );
    }

    /* -- 6. demand readout --------------------------------------- */
    drawDemand(ctx, geo, pal, st, tg, cardAlpha * glassIn, rm);

    /* -- 7. answer sockets and rail ------------------------------ */
    drawSockets(ctx, geo, pal, st, tier, tg, cardAlpha * glassIn, rm, age);

    /* -- 8. glass surface ---------------------------------------- */
    ctx.save();
    ctx.clip(geo.glassPath);
    ctx.globalCompositeOperation = "lighter";
    // Reflection streak. Its position is a function of where the card sits in
    // the frame, so it slides as the card drifts beneath the rig.
    const sheenT = clamp01(q.x / Math.max(1, scene.width) + Math.sin(st.sheenPhase) * 0.1);
    ctx.save();
    ctx.translate(lerp(-w * 0.42, w * 0.42, sheenT), 0);
    ctx.rotate(-0.36);
    ctx.globalAlpha = cardAlpha * glassIn * 0.09;
    ctx.drawImage(shrd.sheen.canvas, -w * 0.62, -h * 0.42, w * 1.24, h * 0.84);
    if (tier.sheen2) {
      ctx.globalAlpha = cardAlpha * glassIn * 0.055;
      ctx.drawImage(shrd.sheen.canvas, -w * 0.36, -h * 0.06, w * 0.72, h * 0.3);
    }
    ctx.restore();
    // Targeting scan.
    if (tg > 0.01) {
      ctx.globalAlpha = cardAlpha * tg * (rm ? 0.1 : 0.17);
      ctx.drawImage(shrd.sweep.canvas, lerp(-w * 0.62, w * 0.56, st.scanPhase), -h * 0.5, w * 0.26, h);
    }
    ctx.restore();

    /* -- 9. fracture --------------------------------------------- */
    const crackAmt = smoothstep(0.4, 0.98, heat);
    if (crackAmt > 0.015) {
      ctx.save();
      ctx.clip(geo.glassPath);
      // The fracture propagates outward from one impact origin rather than
      // fading in everywhere at once.
      ctx.beginPath();
      ctx.arc(st.crackOx * w, st.crackOy * h, w * 0.8 * ease.outCubic(crackAmt), 0, TAU);
      ctx.clip();
      ctx.globalAlpha = cardAlpha * (0.5 + 0.4 * crackAmt);
      ctx.drawImage(st.crack.canvas, -w * 0.5, -h * 0.5, w, h);
      if (tier.crackDepth) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = cardAlpha * 0.22 * crackAmt;
        ctx.drawImage(st.crack.canvas, -w * 0.5, -h * 0.5, w, h);
      }
      ctx.restore();
    }

    /* -- 10. seat flashes ---------------------------------------- */
    if (tier.seatFlash) {
      const glow = bakery.get("glow");
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < geo.total; i++) {
        const seat = st.seatAt[i];
        if (seat < -1e8) continue;
        const t = now - seat;
        if (t < 0 || t > 0.14) continue;
        const a = Math.exp(-t / 0.045) * (rm ? 0.55 : 0.95);
        const r = geo.socketSize * (1.4 + t * 5);
        ctx.globalAlpha = cardAlpha * clamp01(a);
        ctx.drawImage(glow, geo.sockets[i * 2] - r, geo.sockets[i * 2 + 1] - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    /* -- 11. impact, socket-local -------------------------------- */
    // A hit must never cost the player the information they are being asked to
    // read. The energy lands where the letter actually seated — a tight, local
    // bloom over the socket — and everything wide goes onto the *frame*, which
    // carries no type. The label, the answer bank and the demand glyph are all
    // legible on every frame of the impact.
    if (hit > 0.005) {
      ctx.save();
      ctx.clip(geo.glassPath);
      ctx.globalCompositeOperation = "lighter";
      const r = geo.socketSize * (1.5 + 2.4 * (1 - hit));
      ctx.globalAlpha = cardAlpha * hit * (rm ? 0.4 : 0.68);
      ctx.drawImage(bakery.get("glow"), strikeX - r, strikeY - r, r * 2, r * 2);
      // A shallow wash across the panel that lifts it a stop without touching
      // legibility: at peak this is a tenth of what a white-out would be.
      ctx.globalAlpha = cardAlpha * hit * (rm ? 0.045 : 0.075);
      ctx.fillStyle = WARM_WHITE;
      ctx.fillRect(-w * 0.5, -h * 0.5, w, h);
      ctx.restore();
    }

    /* -- 12. frame ------------------------------------------------ */
    drawTile(TILE_FRAME, 1);

    /* -- 12b. impact, on the frame ------------------------------- */
    // The aluminium takes the shock: the whole ring lifts for a beat and a
    // bright arc runs away from the strike around the outer edge, so the event
    // has a direction and an origin without covering a single glyph.
    if (hit > 0.005) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = cardAlpha * hit * (rm ? 0.42 : 0.7);
      ctx.fillStyle = WARM_WHITE;
      ctx.fill(geo.ringPath, "evenodd");

      const rim = st.art.rimLength;
      const travel = ease.outCubic(clamp01(q.sinceHit / 0.26));
      // Two arcs chasing opposite ways round the edge from the strike corner.
      const arc = Math.max(10, rim * 0.16 * hit);
      ctx.setLineDash([arc, Math.max(1, rim - arc)]);
      ctx.lineWidth = Math.max(1.4, geo.frame * 0.5);
      ctx.strokeStyle = WARM_WHITE;
      for (let s = -1; s <= 1; s += 2) {
        ctx.globalAlpha = cardAlpha * hit * (rm ? 0.5 : 0.95);
        ctx.lineDashOffset = -rim * 0.25 + s * rim * travel * 0.5;
        ctx.stroke(geo.outerPath);
      }
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.restore();
    }

    /* -- 13. directional specular -------------------------------- */
    {
      // Direction to the key, rotated into the card's own frame.
      let lx = keyX - q.x;
      let ly = KEY_Y - q.y;
      const len = Math.hypot(lx, ly) || 1;
      lx /= len;
      ly /= len;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const klx = lx * cr + ly * sr;
      const kly = -lx * sr + ly * cr;
      const flx = FILL_X * cr + FILL_Y * sr;
      const fly = -FILL_X * sr + FILL_Y * cr;
      const gain = (0.92 + 0.2 * scene.mood) * cardAlpha * lerp(0.35, 1, openE);

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let side = 0; side < 4; side++) {
        const n = FACE_NORMALS[side];
        // Lambert on a chamfered face: the in-plane part of the key is scaled by
        // sin(chamfer), the out-of-plane part by cos(chamfer).
        const lambert = Math.max(
          0,
          CHAMFER_SIN * KEY_LXY * (n[0] * klx + n[1] * kly) + CHAMFER_COS * KEY_LZ,
        );
        const l2 = lambert * lambert;
        const spec = l2 * l2 * l2; // tight aluminium highlight, this is what blooms
        const fill = Math.max(0, n[0] * flx + n[1] * fly);
        const a = clamp01(0.07 + 0.58 * lambert + 0.5 * spec + 0.15 * fill) * gain;
        if (a < 0.004) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(st.art.faces, 0, side * st.art.fh, st.art.fw, st.art.fh, -w * 0.5, -h * 0.5, w, h);
      }

      // Fresnel rim. Reflectance climbs as a face turns away from the light, so
      // this term is *strongest* exactly where the Lambert faces have gone dark
      // — which is what stops the unlit members from reading as flat paint and
      // gives the card a continuous machined edge.
      {
        const facing = Math.max(0, CHAMFER_COS * KEY_LZ + CHAMFER_SIN * KEY_LXY * Math.abs(kly));
        ctx.globalAlpha = clamp01(0.14 + 0.3 * (1 - facing)) * gain;
        ctx.drawImage(
          st.art.faces,
          0,
          FACE_FRESNEL * st.art.fh,
          st.art.fw,
          st.art.fh,
          -w * 0.5,
          -h * 0.5,
          w,
          h,
        );
      }

      if (tier.glint) {
        // Where the key would actually reflect off the frame: push the light
        // direction out until it meets the frame's centre line.
        const ax = Math.abs(klx);
        const ay = Math.abs(kly);
        const halfW = (w - geo.frame) * 0.5;
        const halfH = (h - geo.frame) * 0.5;
        const t = Math.min(ax > 1e-3 ? halfW / ax : 1e6, ay > 1e-3 ? halfH / ay : 1e6);
        const r = geo.frame * 4.6;
        ctx.save();
        ctx.clip(geo.ringPath, "evenodd");
        ctx.globalAlpha = 0.5 * gain;
        ctx.drawImage(bakery.get("glow"), klx * t - r, kly * t - r, r * 2, r * 2);
        ctx.restore();
      }
      ctx.restore();
    }

    /* -- 14. damage on the frame --------------------------------- */
    if (hotAmt > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = cardAlpha * hotAmt * (0.26 + 0.16 * hotPulse * pulseAmp);
      ctx.fillStyle = HEMI_HOT;
      ctx.fill(geo.ringPath, "evenodd");
      ctx.restore();

      const hatchAmt = smoothstep(0.5, 0.88, heat);
      if (hatchAmt > 0.01) {
        const pattern = hatchFor(ctx, tier);
        if (pattern) {
          ctx.save();
          ctx.globalAlpha = cardAlpha * hatchAmt * 0.5;
          ctx.fillStyle = pattern;
          ctx.fill(geo.ringPath, "evenodd");
          ctx.restore();
        }
      }
      drawAlertBar(ctx, geo, heat, cardAlpha, rm, hotPulse * pulseAmp);
    }

    /* -- 15. targeting furniture --------------------------------- */
    if (tg > 0.01) {
      // Hemi, not the card's own tint. Targeting is a *state*, and the card
      // colours run right up to bone — a near-white outline round the whole
      // silhouette is what turns a physical panel back into a UI stroke.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = cardAlpha * tg * 0.34;
      ctx.strokeStyle = HEMI;
      ctx.lineWidth = 1.1;
      ctx.stroke(geo.outerPath);
      ctx.restore();
      drawBrackets(ctx, geo, tg, cardAlpha, rm, rawNow);
    }

    /* -- 16. impact ring ----------------------------------------- */
    if (struck && q.sinceHit < 0.3) {
      const rp = clamp01(q.sinceHit / 0.3);
      const s = 1 + (rm ? 0.018 : 0.055) * ease.outQuad(rp);
      ctx.save();
      ctx.scale(s, s);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = cardAlpha * (1 - rp) * (1 - rp) * 0.6;
      ctx.strokeStyle = WARM_WHITE;
      ctx.lineWidth = 1.6 / s;
      ctx.stroke(geo.outerPath);
      ctx.restore();
    }

    ctx.restore();

    /* -- 17. ignition line, drawn outside the unfold squash ------ */
    if (age < 0.26) {
      const grow = ease.outQuint(clamp01(age / 0.13));
      const fade = 1 - clamp01((age - 0.09) / 0.17);
      if (fade > 0.01) {
        ctx.save();
        ctx.translate(q.x, q.y + bob);
        if (rot !== 0) ctx.rotate(rot);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = fade;
        ctx.fillStyle = WARM_WHITE;
        const lw = w * grow;
        ctx.fillRect(-lw * 0.5, -1, lw, 2);
        ctx.globalAlpha = fade * 0.55;
        ctx.fillStyle = q.color;
        ctx.fillRect(-lw * 0.5, -2.6, lw, 5.2);
        ctx.restore();
      }
    }
  }

  /* ---- sub-passes ------------------------------------------------ */

  function drawDemand(
    ctx: CanvasRenderingContext2D,
    geo: Geometry,
    pal: Palette,
    st: CardState,
    tg: number,
    alpha: number,
    rm: boolean,
  ): void {
    if (alpha < 0.01) return;
    const d = geo.demand;
    const cx = d.x + d.w * 0.5;
    const cy = d.y + d.h * 0.4;
    const letter = LETTERS[st.progress % LETTER_CYCLE];

    ctx.save();
    ctx.font = st.art.demandFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const scale = 1 + 0.07 * tg;
    ctx.translate(cx, cy);
    if (scale !== 1) ctx.scale(scale, scale);

    // Cut into the plate when idle, lit from within when the card is the target.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillText(letter, 0.8, 1);
    ctx.fillStyle = pal.readout;
    ctx.fillText(letter, 0, 0);
    if (tg > 0.01) {
      ctx.globalAlpha = alpha * tg;
      ctx.fillStyle = WARM_WHITE;
      ctx.fillText(letter, 0, 0);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = alpha * tg * (rm ? 0.28 : 0.42);
      ctx.fillText(letter, 0, 0);
    }
    ctx.restore();

    // Corner ticks snapping inward as the card becomes the target.
    const inset = lerp(d.w * 0.2, d.w * 0.07, tg);
    const arm = d.w * 0.17;
    ctx.save();
    ctx.globalAlpha = alpha * (0.28 + 0.62 * tg);
    ctx.strokeStyle = tg > 0.5 ? WARM_WHITE : pal.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let corner = 0; corner < 4; corner++) {
      const sx = corner % 2 === 0 ? 1 : -1;
      const sy = corner < 2 ? 1 : -1;
      const px = cx + (d.w * 0.5 - inset) * -sx;
      const py = d.y + d.h * 0.5 + (d.h * 0.5 - inset) * -sy;
      ctx.moveTo(px + arm * sx, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + arm * sy);
    }
    ctx.stroke();
    ctx.restore();

    // Word pips: how many SOONs this caller wants, and how many are done.
    const done = Math.floor(st.progress / LETTER_CYCLE);
    const r = st.art.pipRadius;
    const step = r * 3.4;
    const startX = cx - ((geo.words - 1) * step) * 0.5;
    const py = d.y + d.h * 0.85;
    ctx.save();
    for (let i = 0; i < geo.words; i++) {
      const on = i < done;
      ctx.globalAlpha = alpha * (on ? 0.95 : 0.3);
      ctx.fillStyle = on ? pal.base : pal.dim;
      ctx.beginPath();
      ctx.arc(startX + i * step, py, on ? r * 1.15 : r * 0.8, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSockets(
    ctx: CanvasRenderingContext2D,
    geo: Geometry,
    pal: Palette,
    st: CardState,
    tier: Tier,
    tg: number,
    alpha: number,
    rm: boolean,
    age: number,
  ): void {
    if (alpha < 0.01) return;
    const size = geo.socketSize;
    const chipSize = Math.max(4, size - Math.max(1.2, size * 0.14));
    const dropH = size * (rm ? 0.9 : 2.5);
    const bounceAmp = rm ? 0.32 : 1.15;
    const staggering = age < 0.34 + geo.total * 0.028;

    for (let i = 0; i < geo.total; i++) {
      const x = geo.sockets[i * 2];
      const y = geo.sockets[i * 2 + 1];
      const seat = st.seatAt[i];
      const filled = seat > -1e8;

      ctx.save();
      ctx.translate(x, y);
      let slot = alpha;
      if (staggering) {
        // The bank arms itself left to right as the card finishes assembling.
        const pop = clamp01((age - (0.26 + i * 0.028)) / 0.16);
        if (pop <= 0) {
          ctx.restore();
          continue;
        }
        const s = rm ? ease.outCubic(pop) : ease.outBack(pop);
        ctx.scale(s, s);
        slot = alpha * pop;
      }

      if (filled) {
        const t = Math.max(0, now - seat);
        // Fall, seat, ring: an overshoot in the squash rather than the position,
        // because a machined tile stops dead when it hits the socket floor.
        const drop = clamp01(t / SEAT_DROP);
        let dy = -(1 - ease.outQuint(drop)) * dropH;
        const settle = clamp01((t - SEAT_DROP) / SEAT_SETTLE);
        let squash = 0;
        if (t >= SEAT_DROP && settle < 1) {
          const decay = Math.exp(-settle * 4.4);
          dy += Math.sin(settle * Math.PI * 2.6) * bounceAmp * decay;
          const impact = (t - SEAT_DROP) / 0.075;
          squash = Math.exp(-impact * impact);
        }
        const chip = chipFor(LETTERS[i % LETTER_CYCLE], chipSize, tier.ss);
        ctx.save();
        ctx.translate(0, dy);
        if (squash > 0.002) ctx.scale(1 + 0.24 * squash, 1 - 0.3 * squash);
        ctx.globalAlpha = slot * clamp01(drop * 3);
        ctx.drawImage(chip.canvas, -chip.w * 0.5, -chip.h * 0.5, chip.w, chip.h);
        ctx.restore();

        // Socket rim fires as the tile lands.
        const rim = Math.exp(-t / 0.2);
        if (rim > 0.01) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = slot * rim * (rm ? 0.5 : 0.9);
          ctx.strokeStyle = WARM_WHITE;
          ctx.lineWidth = 1.1;
          ctx.stroke(geo.socketPath);
          ctx.globalCompositeOperation = "source-over";
        }
      } else if (i === st.progress) {
        // The socket the player is being asked to fill. Its letter is lifted
        // clear of the waiting ones, so "what do I load next" is answered by
        // the bank itself and not only by the demand well.
        const breathe = rm ? 0.55 : 0.5 + 0.5 * Math.sin(rawNow * TAU * 1.05 + st.bobPhase);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = slot * (0.28 + 0.6 * tg) * (0.55 + 0.45 * breathe);
        ctx.strokeStyle = HEMI;
        ctx.lineWidth = 1.3;
        ctx.stroke(geo.socketPath);
        ctx.font = st.art.socketFont;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.globalAlpha = slot * (0.42 + 0.4 * tg);
        ctx.fillStyle = WARM_WHITE;
        ctx.fillText(LETTERS[i % LETTER_CYCLE], 0, size * 0.04);
        ctx.globalCompositeOperation = "source-over";
        // Feed chevron above the socket — form, not colour.
        const reach = lerp(size * 0.42, size * 0.26, tg);
        ctx.globalAlpha = slot * (0.35 + 0.6 * tg);
        ctx.fillStyle = tg > 0.5 ? WARM_WHITE : pal.dim;
        ctx.beginPath();
        ctx.moveTo(0, -reach);
        ctx.lineTo(-size * 0.18, -reach - size * 0.24);
        ctx.lineTo(size * 0.18, -reach - size * 0.24);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // Progress rail.
    const rail = geo.rail;
    const filled = rail.w * (st.progress / geo.total);
    if (filled > 0.4) {
      ctx.save();
      ctx.clip(geo.railPath);
      ctx.globalAlpha = alpha * 0.92;
      ctx.fillStyle = pal.railFill;
      ctx.fillRect(rail.x, rail.y, filled, rail.h);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = WARM_WHITE;
      ctx.fillRect(rail.x + filled - 1.3, rail.y, 1.4, rail.h);
      ctx.restore();
    }
  }

  function drawAlertBar(
    ctx: CanvasRenderingContext2D,
    geo: Geometry,
    heat: number,
    alpha: number,
    rm: boolean,
    pulse: number,
  ): void {
    const a = geo.alert;
    const cx = a.x + a.w * 0.5;
    const half = a.w * 0.5 * heat;
    ctx.save();
    ctx.globalAlpha = alpha * (0.75 + 0.25 * pulse);
    ctx.fillStyle = heat > 0.72 ? HEMI_HOT : HEMI;
    ctx.fillRect(cx - half, a.y, half * 2, a.h);
    // Graduations cut across the fill so the level is readable without colour.
    ctx.globalAlpha = alpha * 0.6;
    ctx.fillStyle = "rgba(6,4,3,0.9)";
    for (let i = 1; i < 8; i++) ctx.fillRect(a.x + (a.w * i) / 8 - 0.3, a.y - 0.3, 0.6, a.h + 0.6);
    // End chevrons at the point of no return.
    if (heat > 0.82 && !rm) {
      ctx.globalAlpha = alpha * (0.4 + 0.6 * pulse);
      ctx.fillStyle = WARM_WHITE;
      const s = a.h * 1.5;
      for (let side = -1; side <= 1; side += 2) {
        const ex = cx + side * (a.w * 0.5 + s * 0.4);
        ctx.beginPath();
        ctx.moveTo(ex, a.y + a.h * 0.5);
        ctx.lineTo(ex - side * s, a.y - s * 0.5);
        ctx.lineTo(ex - side * s, a.y + a.h + s * 0.5);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawBrackets(
    ctx: CanvasRenderingContext2D,
    geo: Geometry,
    tg: number,
    alpha: number,
    rm: boolean,
    clock: number,
  ): void {
    // Snap inward from outside the card, then breathe by a hair.
    const breathe = rm ? 0 : Math.sin(clock * TAU * 0.55) * 0.6 * tg;
    const spread = lerp(11, 1.6, clamp01(tg)) + breathe;
    const hw = geo.w * 0.5;
    const hh = geo.h * 0.5;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha * clamp01(tg) * 0.95;
    ctx.strokeStyle = HEMI;
    ctx.lineWidth = 1.7;
    ctx.lineCap = "square";
    for (let corner = 0; corner < 4; corner++) {
      const sx = corner === 0 || corner === 3 ? 1 : -1;
      const sy = corner < 2 ? 1 : -1;
      ctx.save();
      ctx.translate(-sx * (hw + spread), -sy * (hh + spread));
      ctx.scale(sx, sy);
      ctx.stroke(geo.bracketPath);
      ctx.restore();
    }
    // Bone core so the brackets bloom instead of merely tinting.
    ctx.globalAlpha = alpha * clamp01(tg) * 0.45;
    ctx.strokeStyle = WARM_WHITE;
    ctx.lineWidth = 0.7;
    for (let corner = 0; corner < 4; corner++) {
      const sx = corner === 0 || corner === 3 ? 1 : -1;
      const sy = corner < 2 ? 1 : -1;
      ctx.save();
      ctx.translate(-sx * (hw + spread), -sy * (hh + spread));
      ctx.scale(sx, sy);
      ctx.stroke(geo.bracketPath);
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---- draw ------------------------------------------------------ */

  function draw(
    ctx: CanvasRenderingContext2D,
    questions: readonly QuestionView[],
    scene: SceneContext,
  ): void {
    if (questions.length === 0) return;
    const tier = tierFor(scene);
    const shrd = sharedFor(tier);
    const keyX = scene.width * KEY_X_FRACTION;

    ctx.save();
    ctx.lineJoin = "round";
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const st = stateFor(q, scene);
      st.seen = frame;
      drawCard(ctx, q, st, scene, tier, shrd, keyX);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  return { update, draw, drawShadows };
}

/** FNV-1a over the kind plus the geometry, so each card art gets its own stream. */
function hashKind(kind: QuestionKind, w: number, h: number, total: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < kind.length; i++) hash = Math.imul(hash ^ kind.charCodeAt(i), 0x01000193);
  hash ^= Math.imul(w, 73856093) ^ Math.imul(h, 19349663) ^ Math.imul(total, 83492791);
  return hash >>> 0;
}
