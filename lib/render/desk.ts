/**
 * POP — the host desk, the answer mic and the aim system.
 *
 * This module owns the foreground furniture of the broadcast: a real desk in
 * perspective, the practical props that sit on it, and the microphone rig that
 * doubles as the player's weapon.
 *
 * Construction, front to back:
 *
 *   floor      cast shadow wings either side of the desk, contact occlusion
 *   body       trapezoid composite top → machined aluminium nosing with a
 *              recessed LED channel → brushed fascia carrying the MWM ident
 *   props      lamp (with its own warm pool), cue cards, XLR panel socket,
 *              mug, caller-queue monitor, ON AIR tally on a stalk
 *   rig        boom arm → shock mount with real elastic suspension → mic body
 *              with machined rings, a woven capsule grille and a lit readout
 *   cable      verlet rope pinned into the desk socket, free end on the mic,
 *              constrained so it lies on the desk top instead of through it
 *
 * Everything static is painted once into an offscreen layer (`ensureLayers`)
 * and composited with a single `drawImage`. Per frame the module only pays for:
 * the composite, three small additive light passes, the monitor's live content,
 * the rope solve, the rig transform and — while a shot is decaying — one masked
 * light pool. The desk art functions take a plain context, so on a host with no
 * offscreen canvas at all the very same code paints straight into the frame.
 *
 * Recoil is a pair of analytic springs (translation along the aim axis and a
 * muzzle-rise twist) driven by velocity impulses, so the rig overshoots and
 * settles instead of easing. The boom flexes on a third spring, the cable takes
 * a real verlet impulse, the muzzle flash lights the desk through a baked
 * receptivity mask (top surface 1.0, nosing 0.75, fascia 0.28 — a cheap N·L),
 * and the camera takes a directional punch opposite the aim.
 *
 * Hard rules honoured: no `Math.random` (every stochastic decision comes from
 * the injected `Rng`), no DOM at module scope (surfaces are created lazily on
 * the first draw), nothing heavy allocates per frame, `scene.quality` selects a
 * tier table, and `scene.reducedMotion` removes shake, strobing and the moving
 * parts of the aim guide while leaving the composition identical.
 */

import {
  clamp,
  clamp01,
  createSpring,
  damp,
  ease,
  lerp,
  mixColor,
  smoothstep,
  withAlpha,
} from "../engine/core";
import { createRope } from "../engine/fx";
import type {
  DeskRenderer,
  DeskView,
  QualityTier,
  QuestionView,
  RenderDeps,
  Rope,
  SceneContext,
  Spring,
} from "./types";

/* ------------------------------------------------------------------ *
 * Palette — hemi orange is the only saturated hue on the set
 * ------------------------------------------------------------------ */

const ALUMINIUM = "#8d8781";
const ALU_MID = "#5b544e";
const ALU_DARK = "#3a3532";
const BONE = "#efe7e0";
const HEMI = "#ff4600";
const HEMI_HOT = "#ff2a00";
const WARM_WHITE = "#fff1dd";
/** Composite desk top: a warm dark veneer, never a brown that reads as wood-effect vinyl. */
const TOP_HI = "#463328";
const TOP_LO = "#1b1411";

const TAU = Math.PI * 2;

/* Pre-built translucent tints. Building a CSS string is not free and none of
 * these may be constructed inside a draw call. */
const BONE_08 = withAlpha(BONE, 0.08);
const BONE_14 = withAlpha(BONE, 0.14);
const BONE_22 = withAlpha(BONE, 0.22);
const BONE_38 = withAlpha(BONE, 0.38);
const BONE_60 = withAlpha(BONE, 0.6);
const BONE_85 = withAlpha(BONE, 0.85);
const ALU_55 = withAlpha(ALUMINIUM, 0.55);
const ALU_80 = withAlpha(ALUMINIUM, 0.8);
/** Body of the aim rail: it reads by occluding the set, never by lighting it. */
const RAIL_INK = "rgba(6,4,3,0.92)";
const HEMI_55 = withAlpha(HEMI, 0.55);
const HEMI_80 = withAlpha(HEMI, 0.8);

/* Type. Broadcast graphics: heavy, tight, and a hardware mono for numerals. */
const FONT_IDENT = '900 17px "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const FONT_CAPTION = '700 6px "Helvetica Neue", Arial, system-ui, sans-serif';
const FONT_TALLY = '900 9px "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const FONT_READOUT = '700 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FONT_HUD = '800 9px "Helvetica Neue", Arial, system-ui, sans-serif';
const FONT_MONO = '600 9px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FONT_BADGE = '800 8px ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/* ------------------------------------------------------------------ *
 * Layout
 *
 * Every number below is in *desk-local* logical pixels: the origin is the
 * DeskView anchor (which is also the aim pivot the simulation fires from), +x
 * runs camera-right and +y runs toward the camera, i.e. down the screen.
 *
 * The camera sits a little above desk height, so we see a shallow band of the
 * top surface as a trapezoid — the far edge is both higher and narrower — then
 * the slab's machined nosing, then the fascia.
 * ------------------------------------------------------------------ */

const TOP_BACK_Y = -20;
const TOP_FRONT_Y = 8;
const NOSE_Y = 19;
const IDENT_Y = 24;
const PLINTH_Y = 46;
const FASCIA_Y = 54;
const BACK_HALF = 208;
const FRONT_HALF = 262;

/** Bake box, local coords. Wide enough to hold the cast-shadow wings. */
const BOX_X0 = -400;
const BOX_X1 = 400;
const BOX_Y0 = -78;

/** Where the props stand, camera-left to camera-right. */
const TALLY_X = -198;
const LAMP_X = -140;
const CARDS_X = -64;
const SOCKET_X = -30;
const MUG_X = 96;
const MONITOR_X = 168;
/** Top surface the props (and the resting cable) sit on. */
const PROP_Y = -4;

/* Aim-guide furniture. Authored once, never rebuilt in a draw. */
const GUIDE_DASH: readonly number[] = [6, 10];
const NO_DASH: readonly number[] = [];
/** Range graticule pitch along the rail, logical px. */
const TICK_STEP = 64;
/** How long the rail stays hot after a shot leaves the capsule. */
const CHANNEL_SECONDS = 0.3;

/* Target-dock grid. The badge and range columns are reserved before the caller
   label is measured, so nothing on the plate can overprint anything else. */
const SLAB_BADGE_GAP = 9;

/** Boom geometry: base plate on the desk, yoke at a fixed radius on the aim ray. */
const BOOM_BASE_Y = -6;
const YOKE_R = 54;
/** Mic body origin on the aim ray, and the sprite's extent about it. */
const MIC_R = 58;
const MIC_X0 = -32;
const MIC_X1 = 28;
const MIC_Y0 = -20;
const MIC_Y1 = 20;

/* ------------------------------------------------------------------ *
 * Quality tiers
 * ------------------------------------------------------------------ */

interface Tier {
  /** Device pixels per logical pixel in the baked layers. */
  bakeK: number;
  ropeSegments: number;
  ropeIterations: number;
  /** Grille mesh pitch in logical px — the hero detail of the mic. */
  grillePitch: number;
  steamWisps: number;
  /** Clip the muzzle light pool to the desk silhouette instead of a plain blob. */
  maskedFlash: boolean;
  fasciaScrews: number;
  /** Elastic bands drawn in the shock mount. */
  shockBands: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: {
    bakeK: 1,
    ropeSegments: 10,
    ropeIterations: 2,
    grillePitch: 3.4,
    steamWisps: 0,
    maskedFlash: false,
    fasciaScrews: 4,
    shockBands: 4,
  },
  medium: {
    bakeK: 1.3,
    ropeSegments: 12,
    ropeIterations: 3,
    grillePitch: 2.9,
    steamWisps: 2,
    maskedFlash: true,
    fasciaScrews: 6,
    shockBands: 6,
  },
  high: {
    bakeK: 1.7,
    ropeSegments: 15,
    ropeIterations: 4,
    grillePitch: 2.4,
    steamWisps: 3,
    maskedFlash: true,
    fasciaScrews: 6,
    shockBands: 6,
  },
  ultra: {
    bakeK: 2.2,
    ropeSegments: 18,
    ropeIterations: 5,
    grillePitch: 2,
    steamWisps: 4,
    maskedFlash: true,
    fasciaScrews: 8,
    shockBands: 8,
  },
};

/* ------------------------------------------------------------------ *
 * Offscreen surfaces
 * ------------------------------------------------------------------ */

interface Surface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  /** Backing-store size. */
  w: number;
  h: number;
  /** Logical size. */
  lw: number;
  lh: number;
  /** Realised device pixels per logical pixel after rounding. */
  k: number;
}

/**
 * Creates a bake target whose transform is already set to logical units.
 * Returns null during a server render, where nothing may be baked at all — the
 * callers then paint their art straight into the frame instead.
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

/* ------------------------------------------------------------------ *
 * Small geometry helpers
 * ------------------------------------------------------------------ */

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

/** The desk top is a trapezoid; this is its half-width at a given local y. */
function halfWidthAt(y: number): number {
  const t = clamp01((y - TOP_BACK_Y) / (TOP_FRONT_Y - TOP_BACK_Y));
  return lerp(BACK_HALF, FRONT_HALF, t);
}

function deskTopPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(-BACK_HALF, TOP_BACK_Y);
  ctx.lineTo(BACK_HALF, TOP_BACK_Y);
  ctx.lineTo(FRONT_HALF, TOP_FRONT_Y);
  ctx.lineTo(-FRONT_HALF, TOP_FRONT_Y);
  ctx.closePath();
}

/** Shortest signed angle from a to b, in (−π, π]. */
function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/**
 * Peak displacement produced by a unit velocity impulse on a spring at rest.
 * Lets the recoil be authored in pixels and radians rather than in whatever
 * magic velocity happens to look right for one particular stiffness.
 *
 * Under-damped: x(t) = (v₀/ω_d)·e^(−ζωt)·sin(ω_d t), whose maximum sits at
 * t = θ/ω_d with θ = atan2(ω_d, ζω).
 */
function impulsePeak(stiffness: number, damping: number, mass: number): number {
  const w = Math.sqrt(stiffness / mass);
  const z = damping / (2 * Math.sqrt(stiffness * mass));
  if (z >= 1) return 1 / (w * Math.E);
  const wd = w * Math.sqrt(1 - z * z);
  const theta = Math.atan2(wd, z * w);
  return (Math.exp((-z * w * theta) / wd) * Math.sin(theta)) / wd;
}

/** Uppercase text on a fixed advance — broadcast tracking, and no measureText. */
function trackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  advance: number,
  align: -1 | 0 | 1,
): void {
  const n = text.length;
  if (n === 0) return;
  const width = advance * (n - 1);
  let cx = align < 0 ? x : align === 0 ? x - width * 0.5 : x - width;
  for (let i = 0; i < n; i++) {
    ctx.fillText(text[i], cx, y);
    cx += advance;
  }
}

/** Zero-padded integer, for readouts that should tick like hardware counters. */
function pad3(value: number): string {
  const v = clamp(Math.round(value), 0, 999);
  return v < 10 ? "00" + v : v < 100 ? "0" + v : "" + v;
}

/* ------------------------------------------------------------------ *
 * Deterministic decoration
 *
 * Every stochastic decision the desk makes is drawn once, at construction, from
 * the injected Rng into plain arrays. Nothing downstream ever touches the
 * stream again, so bake order and frame order cannot change the art.
 * ------------------------------------------------------------------ */

interface Statics {
  /** Screw slot angles on the fascia. */
  screwAngle: Float32Array;
  /** Per-card offset/rotation for the cue stack. */
  cardDx: Float32Array;
  cardDy: Float32Array;
  cardRot: Float32Array;
  /** Steam wisp phases and lean. */
  steamPhase: Float32Array;
  steamLean: Float32Array;
  /** Cable whip jitter, one per rope segment. */
  whip: Float32Array;
  /** Caller-queue row widths on the monitor. */
  rowWidth: Float32Array;
  /** Scuffs on the desk top: x, y, length, angle, alpha. */
  scuff: Float32Array;
}

const MAX_CARDS = 12;
const MAX_ROPE = 20;
const QUEUE_ROWS = 5;
const SCUFFS = 26;

function buildStatics(rng: RenderDeps["rng"]): Statics {
  const r = rng.fork(0x4445_534b); // "DESK"
  const screwAngle = new Float32Array(10);
  for (let i = 0; i < screwAngle.length; i++) screwAngle[i] = r.range(0, Math.PI);

  const cardDx = new Float32Array(MAX_CARDS);
  const cardDy = new Float32Array(MAX_CARDS);
  const cardRot = new Float32Array(MAX_CARDS);
  for (let i = 0; i < MAX_CARDS; i++) {
    cardDx[i] = r.range(-2.4, 2.4);
    cardDy[i] = r.range(-1.1, 1.1);
    cardRot[i] = r.range(-0.09, 0.09);
  }

  const steamPhase = new Float32Array(4);
  const steamLean = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    steamPhase[i] = r.range(0, TAU);
    steamLean[i] = r.range(-0.5, 0.9);
  }

  const whip = new Float32Array(MAX_ROPE);
  for (let i = 0; i < MAX_ROPE; i++) whip[i] = r.range(0.55, 1.45);

  const rowWidth = new Float32Array(QUEUE_ROWS * 2);
  for (let i = 0; i < rowWidth.length; i++) rowWidth[i] = r.range(0.34, 1);

  const scuff = new Float32Array(SCUFFS * 5);
  for (let i = 0; i < SCUFFS; i++) {
    const o = i * 5;
    const y = r.range(TOP_BACK_Y + 2, TOP_FRONT_Y - 2);
    const half = halfWidthAt(y) - 10;
    scuff[o] = r.range(-half, half);
    scuff[o + 1] = y;
    scuff[o + 2] = r.range(6, 34);
    scuff[o + 3] = r.range(-0.24, 0.24);
    scuff[o + 4] = r.range(0.02, 0.075);
  }

  return { screwAngle, cardDx, cardDy, cardRot, steamPhase, steamLean, whip, rowWidth, scuff };
}

/* ------------------------------------------------------------------ *
 * The desk body
 *
 * `paintDeskBody` is a pure function of (context, bakery, tier, statics) in
 * desk-local coordinates. The renderer normally calls it once into an offscreen
 * layer; when no offscreen canvas exists it is called straight into the frame.
 * ------------------------------------------------------------------ */

function paintFloorShadow(ctx: CanvasRenderingContext2D, floorY: number, bottomY: number): void {
  // The desk occludes the overhead rig, so the deck either side of it falls off
  // into shadow. There is no visible floor *behind* the desk — the body covers
  // the whole depth of the deck — so the wings are the whole of the cast.
  const top = Math.max(floorY, TOP_BACK_Y - 4);
  const depth = Math.max(8, bottomY - top);
  for (let side = -1; side <= 1; side += 2) {
    const edge = side * FRONT_HALF;
    const g = ctx.createLinearGradient(edge, 0, edge + side * 132, 0);
    g.addColorStop(0, "rgba(3,2,2,0.72)");
    g.addColorStop(0.34, "rgba(3,2,2,0.34)");
    g.addColorStop(0.72, "rgba(3,2,2,0.09)");
    g.addColorStop(1, "rgba(3,2,2,0)");
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(edge, edge + side * 132), top, 132, depth);
  }
  // Contact line: the darkest value in the frame sits where the body meets the
  // deck, which is what stops the desk floating.
  const contact = ctx.createLinearGradient(0, top, 0, top + 26);
  contact.addColorStop(0, "rgba(2,1,1,0.62)");
  contact.addColorStop(1, "rgba(2,1,1,0)");
  ctx.fillStyle = contact;
  ctx.fillRect(-FRONT_HALF - 118, top, (FRONT_HALF + 118) * 2, 26);
}

function paintDeskTop(
  ctx: CanvasRenderingContext2D,
  bakery: RenderDeps["bakery"],
  statics: Statics,
): void {
  ctx.save();
  deskTopPath(ctx);
  ctx.clip();

  // Base: brighter at the far edge, where the key rig rakes across it.
  const base = ctx.createLinearGradient(0, TOP_BACK_Y, 0, TOP_FRONT_Y);
  base.addColorStop(0, TOP_HI);
  base.addColorStop(0.55, mixColor(TOP_HI, TOP_LO, 0.62));
  base.addColorStop(1, TOP_LO);
  ctx.fillStyle = base;
  ctx.fillRect(-FRONT_HALF, TOP_BACK_Y, FRONT_HALF * 2, TOP_FRONT_Y - TOP_BACK_Y);

  // Composite grain. The brushed tile is anisotropic, so stretching it 4:1
  // across the surface gives a directional lay without a second texture.
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.22;
  ctx.scale(4, 1);
  ctx.fillStyle = bakery.pattern(ctx, "brushed-metal");
  // Coordinates are pre-scale, so the span is a quarter of the desk's width.
  ctx.fillRect(-FRONT_HALF * 0.25, TOP_BACK_Y, FRONT_HALF * 0.5, TOP_FRONT_Y - TOP_BACK_Y);
  ctx.restore();

  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = bakery.pattern(ctx, "grunge");
  ctx.fillRect(-FRONT_HALF, TOP_BACK_Y, FRONT_HALF * 2, TOP_FRONT_Y - TOP_BACK_Y);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  // Specular sheen from the overhead rig: a broad soft reflection plus a
  // tighter hot core, both offset camera-left with the key.
  const sheen = ctx.createRadialGradient(-40, TOP_BACK_Y + 4, 4, -40, TOP_BACK_Y + 4, 250);
  sheen.addColorStop(0, "rgba(255,232,206,0.2)");
  sheen.addColorStop(0.42, "rgba(255,214,180,0.075)");
  sheen.addColorStop(1, "rgba(255,200,160,0)");
  ctx.save();
  ctx.translate(-40, TOP_BACK_Y + 4);
  ctx.scale(1, 0.2);
  ctx.translate(40, -(TOP_BACK_Y + 4));
  ctx.fillStyle = sheen;
  // Generous in the squashed axis: a tight rect would clip the reflection
  // short of the front edge once the 5:1 flatten is applied.
  ctx.fillRect(-FRONT_HALF, TOP_BACK_Y - 300, FRONT_HALF * 2, 600);
  ctx.restore();

  // Micro scuffing — a lacquered top is never perfectly clean under a key light.
  ctx.lineCap = "round";
  for (let i = 0; i < SCUFFS; i++) {
    const o = i * 5;
    const x = statics.scuff[o];
    const y = statics.scuff[o + 1];
    const len = statics.scuff[o + 2];
    const a = statics.scuff[o + 3];
    ctx.strokeStyle = withAlpha(BONE, statics.scuff[o + 4]);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(a) * len * 0.5, y - Math.sin(a) * len * 0.5);
    ctx.lineTo(x + Math.cos(a) * len * 0.5, y + Math.sin(a) * len * 0.5);
    ctx.stroke();
  }

  // Ambient occlusion where the top meets the set behind it.
  const back = ctx.createLinearGradient(0, TOP_BACK_Y, 0, TOP_BACK_Y + 9);
  back.addColorStop(0, "rgba(4,3,2,0.5)");
  back.addColorStop(1, "rgba(4,3,2,0)");
  ctx.fillStyle = back;
  ctx.fillRect(-FRONT_HALF, TOP_BACK_Y, FRONT_HALF * 2, 9);
  ctx.restore();

  // Arris: the machined edge where the top meets the nosing catches the rig.
  ctx.strokeStyle = BONE_22;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-FRONT_HALF, TOP_FRONT_Y - 0.5);
  ctx.lineTo(FRONT_HALF, TOP_FRONT_Y - 0.5);
  ctx.stroke();
}

function paintNosing(ctx: CanvasRenderingContext2D, bakery: RenderDeps["bakery"]): void {
  const h = NOSE_Y - TOP_FRONT_Y;
  const g = ctx.createLinearGradient(0, TOP_FRONT_Y, 0, NOSE_Y);
  g.addColorStop(0, "#7d766e");
  g.addColorStop(0.28, "#5a534d");
  g.addColorStop(0.62, "#332f2c");
  g.addColorStop(1, "#242120");
  ctx.fillStyle = g;
  ctx.fillRect(-FRONT_HALF, TOP_FRONT_Y, FRONT_HALF * 2, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(-FRONT_HALF, TOP_FRONT_Y, FRONT_HALF * 2, h);
  ctx.clip();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = bakery.pattern(ctx, "brushed-metal");
  ctx.fillRect(-FRONT_HALF, TOP_FRONT_Y, FRONT_HALF * 2, h);
  ctx.restore();

  // Recessed channel for the LED tape. Baked dark; the lit tape itself is a
  // separate additive pass so it can breathe with the show.
  const chanY = TOP_FRONT_Y + h * 0.46;
  const chanH = 3.4;
  ctx.fillStyle = "#100e0d";
  ctx.fillRect(-FRONT_HALF + 3, chanY, (FRONT_HALF - 3) * 2, chanH);
  ctx.fillStyle = "rgba(4,3,2,0.7)";
  ctx.fillRect(-FRONT_HALF + 3, chanY, (FRONT_HALF - 3) * 2, 1);
  ctx.fillStyle = BONE_14;
  ctx.fillRect(-FRONT_HALF + 3, chanY + chanH, (FRONT_HALF - 3) * 2, 0.7);
}

/** The MWM ident: an inlaid plate with an engraved wordmark. */
function paintIdent(ctx: CanvasRenderingContext2D): void {
  const w = 236;
  const h = 21;
  const x = -w * 0.5;
  const y = IDENT_Y;

  // Recessed inlay: darker than the fascia, with a shadow along the top edge
  // and a catch-light along the bottom — the signature of a machined pocket.
  roundRect(ctx, x, y, w, h, 2.5);
  ctx.fillStyle = "#171513";
  ctx.fill();
  const pocket = ctx.createLinearGradient(0, y, 0, y + h);
  pocket.addColorStop(0, "rgba(3,2,2,0.85)");
  pocket.addColorStop(0.4, "rgba(3,2,2,0)");
  pocket.addColorStop(1, "rgba(255,235,214,0.14)");
  ctx.fillStyle = pocket;
  ctx.fill();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const baseline = y + 15.5;

  // Engraved wordmark: a dark impression down-right, a bone catch up-left, and
  // a mid-tone face between them. Never a flat white logotype.
  ctx.font = FONT_IDENT;
  ctx.fillStyle = "rgba(2,1,1,0.9)";
  ctx.fillText("MWM", x + 11.8, baseline + 1.1);
  ctx.fillStyle = "rgba(246,238,230,0.32)";
  ctx.fillText("MWM", x + 10.2, baseline - 1);
  ctx.fillStyle = "#6e665f";
  ctx.fillText("MWM", x + 11, baseline);

  // Accent rule — the only orange on the fascia, and it is paint, not light.
  ctx.fillStyle = HEMI_80;
  ctx.fillRect(x + 62, y + 5.5, 2.4, h - 11);

  ctx.font = FONT_CAPTION;
  ctx.fillStyle = "rgba(180,170,161,0.72)";
  trackedText(ctx, "MIDWEEK WITH MAX", x + 72, baseline - 5.4, 5.6, -1);
  ctx.fillStyle = "rgba(140,131,123,0.6)";
  trackedText(ctx, "COMMUNITY TAKEOVER", x + 72, baseline + 1.6, 5.6, -1);
}

function paintFascia(
  ctx: CanvasRenderingContext2D,
  bakery: RenderDeps["bakery"],
  tier: Tier,
  statics: Statics,
): void {
  const y0 = NOSE_Y;
  const y1 = FASCIA_Y;
  const h = y1 - y0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(-FRONT_HALF, y0, FRONT_HALF * 2, h);
  ctx.clip();

  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, "#4e4842");
  g.addColorStop(0.3, "#38332f");
  g.addColorStop(0.78, "#26221f");
  g.addColorStop(1, "#191615");
  ctx.fillStyle = g;
  ctx.fillRect(-FRONT_HALF, y0, FRONT_HALF * 2, h);

  // Falloff toward the ends: the fascia curves away from the key.
  const ends = ctx.createLinearGradient(-FRONT_HALF, 0, FRONT_HALF, 0);
  ends.addColorStop(0, "rgba(3,2,2,0.66)");
  ends.addColorStop(0.24, "rgba(3,2,2,0.06)");
  ends.addColorStop(0.5, "rgba(255,238,220,0.05)");
  ends.addColorStop(0.76, "rgba(3,2,2,0.06)");
  ends.addColorStop(1, "rgba(3,2,2,0.66)");
  ctx.fillStyle = ends;
  ctx.fillRect(-FRONT_HALF, y0, FRONT_HALF * 2, h);

  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.46;
  ctx.fillStyle = bakery.pattern(ctx, "brushed-metal");
  ctx.fillRect(-FRONT_HALF, y0, FRONT_HALF * 2, h);
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = bakery.pattern(ctx, "noise-fine");
  ctx.fillRect(-FRONT_HALF, y0, FRONT_HALF * 2, h);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  // Panel joints: a dark kerf with a bright return on its lit side.
  for (let i = -1; i <= 1; i += 2) {
    const sx = i * FRONT_HALF * 0.53;
    ctx.fillStyle = "rgba(3,2,2,0.8)";
    ctx.fillRect(sx - 0.6, y0, 1.2, h);
    ctx.fillStyle = BONE_08;
    ctx.fillRect(sx + 0.6, y0, 0.6, h);
  }

  // Shadow groove across the whole panel — a real desk is never one flat sheet.
  const grooveY = y0 + h * 0.34;
  ctx.fillStyle = "rgba(3,2,2,0.55)";
  ctx.fillRect(-FRONT_HALF, grooveY, FRONT_HALF * 2, 1);
  ctx.fillStyle = BONE_08;
  ctx.fillRect(-FRONT_HALF, grooveY + 1, FRONT_HALF * 2, 0.6);

  paintIdent(ctx);

  // Countersunk fasteners along the panel joints.
  const cols = tier.fasciaScrews;
  for (let i = 0; i < cols; i++) {
    const t = cols === 1 ? 0.5 : i / (cols - 1);
    const sx = lerp(-FRONT_HALF + 16, FRONT_HALF - 16, t);
    if (Math.abs(sx) < 128) continue; // never through the ident plate
    const sy = y0 + h * 0.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.6, 0, TAU);
    ctx.fillStyle = "#1d1a18";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy - 0.4, 2.6, Math.PI * 1.15, Math.PI * 1.95);
    ctx.strokeStyle = BONE_22;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    const a = statics.screwAngle[i % statics.screwAngle.length];
    ctx.strokeStyle = "rgba(3,2,2,0.85)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(sx - Math.cos(a) * 1.5, sy - Math.sin(a) * 1.5);
    ctx.lineTo(sx + Math.cos(a) * 1.5, sy + Math.sin(a) * 1.5);
    ctx.stroke();
  }
  ctx.restore();

  // Plinth: inset and unlit, so the mass above it reads as floating.
  const inset = 18;
  ctx.fillStyle = "#0d0b0a";
  ctx.fillRect(-FRONT_HALF + inset, PLINTH_Y, (FRONT_HALF - inset) * 2, y1 - PLINTH_Y + 20);
  const plinth = ctx.createLinearGradient(0, PLINTH_Y, 0, PLINTH_Y + 12);
  plinth.addColorStop(0, "rgba(3,2,2,0.9)");
  plinth.addColorStop(1, "rgba(3,2,2,0.2)");
  ctx.fillStyle = plinth;
  ctx.fillRect(-FRONT_HALF + inset, PLINTH_Y, (FRONT_HALF - inset) * 2, 12);
  // The returns either side of the recess catch a sliver of bounce.
  ctx.fillStyle = BONE_08;
  ctx.fillRect(-FRONT_HALF + inset - 0.8, PLINTH_Y, 0.8, y1 - PLINTH_Y + 20);
  ctx.fillRect(FRONT_HALF - inset, PLINTH_Y, 0.8, y1 - PLINTH_Y + 20);
}

/* ------------------------------------------------------------------ *
 * Practical props
 * ------------------------------------------------------------------ */

/** Soft contact shadow under a prop, so nothing on the desk floats. */
function contactShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  strength: number,
): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
  g.addColorStop(0, `rgba(3,2,2,${strength})`);
  g.addColorStop(0.5, `rgba(3,2,2,${strength * 0.42})`);
  g.addColorStop(1, "rgba(3,2,2,0)");
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / Math.max(rx, ry));
  ctx.translate(-x, -y);
  ctx.fillStyle = g;
  ctx.fillRect(x - rx * 1.2, y - rx * 1.2, rx * 2.4, rx * 2.4);
  ctx.restore();
}

/** Anodised tube, drawn as a body fill plus a specular return along its top. */
function tube(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  body: string,
  highlight: string,
): void {
  ctx.lineCap = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = body;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  // Offset the return by a quarter of the radius along the surface normal.
  let nx = -(y1 - y0);
  let ny = x1 - x0;
  const l = Math.hypot(nx, ny) || 1;
  nx = (nx / l) * width * 0.24;
  ny = (ny / l) * width * 0.24;
  ctx.lineWidth = Math.max(0.6, width * 0.26);
  ctx.strokeStyle = highlight;
  ctx.beginPath();
  ctx.moveTo(x0 + nx, y0 + ny);
  ctx.lineTo(x1 + nx, y1 + ny);
  ctx.stroke();
}

function paintLamp(ctx: CanvasRenderingContext2D): void {
  const bx = LAMP_X;
  const by = PROP_Y;
  contactShadow(ctx, bx + 2, by + 2, 22, 7, 0.62);

  // Weighted base.
  ctx.beginPath();
  ctx.ellipse(bx, by, 17, 5.2, 0, 0, TAU);
  ctx.fillStyle = "#2b2724";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(bx, by - 2.4, 17, 5.2, 0, 0, TAU);
  ctx.fillStyle = "#403a35";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(bx, by - 2.4, 17, 5.2, 0, Math.PI * 1.06, Math.PI * 1.94);
  ctx.strokeStyle = BONE_38;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Two-segment arm with a knuckle, then the shade.
  const kx = bx - 3;
  const ky = by - 44;
  const hx = bx + 38;
  const hy = by - 52;
  tube(ctx, bx, by - 4, kx, ky, 4.4, "#39332f", ALU_80);
  tube(ctx, kx, ky, hx, hy, 4, "#39332f", ALU_80);
  ctx.beginPath();
  ctx.arc(kx, ky, 3.4, 0, TAU);
  ctx.fillStyle = "#4a443e";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(kx - 0.7, ky - 0.7, 3.4, Math.PI * 1.05, Math.PI * 1.95);
  ctx.strokeStyle = BONE_60;
  ctx.lineWidth = 0.9;
  ctx.stroke();

  // Conical shade aimed down-right at the cue cards.
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(0.62);
  ctx.beginPath();
  ctx.moveTo(-7, -4);
  ctx.lineTo(7, -12);
  ctx.lineTo(15, 10);
  ctx.lineTo(-9, 8);
  ctx.closePath();
  const shade0 = ctx.createLinearGradient(-9, -8, 12, 10);
  shade0.addColorStop(0, "#6d655e");
  shade0.addColorStop(0.5, "#413b36");
  shade0.addColorStop(1, "#241f1d");
  ctx.fillStyle = shade0;
  ctx.fill();
  ctx.strokeStyle = BONE_22;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-7, -4);
  ctx.lineTo(7, -12);
  ctx.stroke();
  // Mouth of the shade: dark until the bulb layer lights it.
  ctx.beginPath();
  ctx.ellipse(3, 9, 12, 3.6, 0.06, 0, TAU);
  ctx.fillStyle = "#16110e";
  ctx.fill();
  ctx.restore();
}

function paintCueCards(
  ctx: CanvasRenderingContext2D,
  statics: Statics,
  from: number,
  count: number,
): void {
  const w = 56;
  const h = 30;
  for (let i = from; i < count; i++) {
    const lift = i * 1.15;
    ctx.save();
    ctx.translate(CARDS_X + statics.cardDx[i % MAX_CARDS], PROP_Y - lift + statics.cardDy[i % MAX_CARDS]);
    ctx.rotate(statics.cardRot[i % MAX_CARDS]);
    roundRect(ctx, -w * 0.5, -h, w, h, 1.6);
    // Cards are bone stock; the ones lower in the stack sit in their own shade.
    const face = i === count - 1 ? "#ded5cb" : "#b8ada2";
    ctx.fillStyle = face;
    ctx.fill();
    ctx.strokeStyle = "rgba(3,2,2,0.35)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
    if (i === count - 1) {
      // Ruled lines and a hemi header stripe on the top card only.
      ctx.fillStyle = HEMI_55;
      ctx.fillRect(-w * 0.5 + 4, -h + 4, 20, 2);
      ctx.fillStyle = "rgba(60,52,46,0.5)";
      for (let r = 0; r < 4; r++) ctx.fillRect(-w * 0.5 + 4, -h + 10 + r * 4.6, w - 8 - r * 5, 1.1);
    }
    ctx.restore();
  }
}

function paintSocket(ctx: CanvasRenderingContext2D): void {
  const x = SOCKET_X;
  const y = PROP_Y;
  // Panel-mount XLR: a recessed dish with three pin holes and a latch.
  ctx.beginPath();
  ctx.ellipse(x, y, 8.5, 3.4, 0, 0, TAU);
  ctx.fillStyle = "#2c2825";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y - 0.8, 7, 2.7, 0, 0, TAU);
  ctx.fillStyle = "#100e0d";
  ctx.fill();
  ctx.fillStyle = "#6b645d";
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI * 0.5 + (i - 1) * 0.9;
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(a) * 3.4, y - 0.8 + Math.sin(a) * 1.3, 0.9, 0.6, 0, 0, TAU);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(x, y - 0.8, 7, 2.7, 0, Math.PI * 1.05, Math.PI * 1.95);
  ctx.strokeStyle = BONE_38;
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

function paintBoomBase(ctx: CanvasRenderingContext2D): void {
  const y = BOOM_BASE_Y;
  contactShadow(ctx, 1, y + 3, 26, 8, 0.6);
  // Machined mounting plate with a raised collar the arm swivels in.
  ctx.beginPath();
  ctx.ellipse(0, y + 2, 22, 6.4, 0, 0, TAU);
  ctx.fillStyle = "#26221f";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, y, 22, 6.4, 0, 0, TAU);
  const plate = ctx.createLinearGradient(0, y - 7, 0, y + 7);
  plate.addColorStop(0, "#6c655e");
  plate.addColorStop(0.5, "#453f3a");
  plate.addColorStop(1, "#2a2624");
  ctx.fillStyle = plate;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, y - 0.6, 22, 6.4, 0, Math.PI * 1.04, Math.PI * 1.96);
  ctx.strokeStyle = BONE_60;
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, y - 3, 9, 3.4, 0, 0, TAU);
  ctx.fillStyle = "#514a44";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, y - 4, 9, 3.4, 0, Math.PI, TAU);
  ctx.strokeStyle = BONE_38;
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function paintMug(ctx: CanvasRenderingContext2D): void {
  const x = MUG_X;
  const y = PROP_Y;
  const w = 21;
  const hgt = 25;
  contactShadow(ctx, x + 2, y + 2, 17, 5, 0.6);

  // Handle first, so the body overlaps it correctly.
  ctx.beginPath();
  ctx.ellipse(x + w * 0.5 + 4, y - hgt * 0.52, 5.6, 5.2, 0, -1.3, 1.3);
  ctx.strokeStyle = "#a89c92";
  ctx.lineWidth = 3.4;
  ctx.stroke();
  ctx.strokeStyle = "#d6cbc0";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.ellipse(x + w * 0.5 + 3.4, y - hgt * 0.52, 5.6, 5.2, 0, -1.2, 0.4);
  ctx.stroke();

  // Body: a slightly tapered cylinder in glazed bone ceramic.
  ctx.beginPath();
  ctx.moveTo(x - w * 0.5, y - hgt);
  ctx.lineTo(x + w * 0.5, y - hgt);
  ctx.lineTo(x + w * 0.44, y - 1.5);
  ctx.quadraticCurveTo(x, y + 2.6, x - w * 0.44, y - 1.5);
  ctx.closePath();
  const body = ctx.createLinearGradient(x - w * 0.5, 0, x + w * 0.5, 0);
  body.addColorStop(0, "#463d37");
  body.addColorStop(0.2, "#cfc4b9");
  body.addColorStop(0.46, "#efe7e0");
  body.addColorStop(0.74, "#9d9188");
  body.addColorStop(1, "#4c443e");
  ctx.fillStyle = body;
  ctx.fill();

  // Hemi band — merchandise, and the only saturated thing on the desk top.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - w * 0.5, y - hgt);
  ctx.lineTo(x + w * 0.5, y - hgt);
  ctx.lineTo(x + w * 0.44, y - 1.5);
  ctx.quadraticCurveTo(x, y + 2.6, x - w * 0.44, y - 1.5);
  ctx.closePath();
  ctx.clip();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = HEMI;
  ctx.fillRect(x - w, y - hgt * 0.62, w * 2, 5.4);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "rgba(3,2,2,1)";
  ctx.fillRect(x + w * 0.16, y - hgt, w, hgt);
  ctx.restore();

  // Rim and the dark coffee inside it.
  ctx.beginPath();
  ctx.ellipse(x, y - hgt, w * 0.5, 3.2, 0, 0, TAU);
  ctx.fillStyle = "#efe7e0";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y - hgt + 0.5, w * 0.5 - 1.7, 2.3, 0, 0, TAU);
  ctx.fillStyle = "#170f0a";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x - 2, y - hgt + 0.2, 2.6, 0.9, 0.2, 0, TAU);
  ctx.fillStyle = "rgba(255,214,176,0.28)";
  ctx.fill();
}

function paintMonitor(ctx: CanvasRenderingContext2D): void {
  const x = MONITOR_X;
  const y = PROP_Y;
  const sw = 78;
  const sh = 48;
  contactShadow(ctx, x + 2, y + 2, 34, 9, 0.62);

  // Stand.
  ctx.fillStyle = "#2b2724";
  ctx.beginPath();
  ctx.ellipse(x, y, 20, 5, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#3d3733";
  ctx.fillRect(x - 4, y - 14, 8, 13);
  ctx.fillStyle = BONE_22;
  ctx.fillRect(x - 4, y - 14, 1.2, 13);

  ctx.save();
  ctx.translate(x, y - 14);
  ctx.rotate(-0.05);
  // Bezel.
  roundRect(ctx, -sw * 0.5, -sh, sw, sh, 3);
  const bez = ctx.createLinearGradient(0, -sh, 0, 0);
  bez.addColorStop(0, "#4e4842");
  bez.addColorStop(0.5, "#332e2b");
  bez.addColorStop(1, "#1d1a18");
  ctx.fillStyle = bez;
  ctx.fill();
  ctx.strokeStyle = BONE_22;
  ctx.lineWidth = 0.8;
  ctx.stroke();
  // Screen well — content is live, so it is left dark here.
  roundRect(ctx, -sw * 0.5 + 3.5, -sh + 3.5, sw - 7, sh - 11, 1.5);
  ctx.fillStyle = "#07090a";
  ctx.fill();
  ctx.strokeStyle = "rgba(3,2,2,0.9)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Chin: a brand notch and a power pip.
  ctx.fillStyle = "rgba(160,150,142,0.5)";
  ctx.fillRect(-sw * 0.5 + 6, -6.4, 12, 1.4);
  ctx.restore();
}

/** The tally housing. The lit legend lives in its own additive layer. */
function paintTallyBody(ctx: CanvasRenderingContext2D): void {
  const x = TALLY_X;
  const y = PROP_Y;
  contactShadow(ctx, x + 1, y + 2, 14, 5, 0.55);
  // Stalk.
  tube(ctx, x, y - 1, x, y - 22, 3.4, "#332e2b", ALU_55);
  ctx.beginPath();
  ctx.ellipse(x, y, 11, 3.6, 0, 0, TAU);
  ctx.fillStyle = "#37312d";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y - 1.2, 11, 3.6, 0, Math.PI, TAU);
  ctx.strokeStyle = BONE_38;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Housing: a cast box with a diffuser window.
  const w = 58;
  const h = 19;
  roundRect(ctx, x - w * 0.5, y - 22 - h, w, h, 2.2);
  const box = ctx.createLinearGradient(0, y - 22 - h, 0, y - 22);
  box.addColorStop(0, "#575049");
  box.addColorStop(0.55, "#332e2b");
  box.addColorStop(1, "#1c1917");
  ctx.fillStyle = box;
  ctx.fill();
  ctx.strokeStyle = "rgba(3,2,2,0.8)";
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.fillStyle = BONE_22;
  ctx.fillRect(x - w * 0.5 + 1.4, y - 22 - h + 1, w - 2.8, 0.8);

  // Unlit diffuser: the legend is visible but dead, as real acrylic is.
  roundRect(ctx, x - w * 0.5 + 3.4, y - 22 - h + 3.2, w - 6.8, h - 6.4, 1.2);
  ctx.fillStyle = "#221c18";
  ctx.fill();
  ctx.font = FONT_TALLY;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(120,110,102,0.55)";
  trackedText(ctx, "ON AIR", x, y - 22 - h * 0.5 + 0.5, 8.2, 0);
}

/** The lamp's warm pool, baked at nominal brightness and clipped to the top. */
function paintLampPool(ctx: CanvasRenderingContext2D): void {
  const px = LAMP_X + 54;
  const py = PROP_Y + 2;
  ctx.save();
  deskTopPath(ctx);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(px, py, 0, px, py, 96);
  g.addColorStop(0, "rgba(255,196,126,0.4)");
  g.addColorStop(0.32, "rgba(255,158,84,0.19)");
  g.addColorStop(0.66, "rgba(255,110,40,0.06)");
  g.addColorStop(1, "rgba(255,90,20,0)");
  ctx.translate(px, py);
  ctx.scale(1.5, 0.32);
  ctx.translate(-px, -py);
  ctx.fillStyle = g;
  ctx.fillRect(px - 150, py - 150, 300, 300);
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Cast shadows on the desk top
 *
 * Three sources reach the top surface, and every prop standing on it has to
 * answer all three:
 *
 *   lamp     a small practical ~50 px above the surface and camera-left of
 *            most of the dressing. Close source, so its shadows are long,
 *            hard-cored and fall off fast with distance from the shade.
 *   key rig  the overhead studio key. Far, soft, almost overhead: a short
 *            shadow leaning camera-right under everything.
 *   contact  the ambient occlusion right at the foot of an object, which is
 *            what actually makes a prop look like it is *on* the desk.
 *
 * We are looking almost along the desk top — it is only 28 px deep on screen —
 * so every shadow is foreshortened into a band. That is correct, not a cheat.
 * ------------------------------------------------------------------ */

/** Lamp filament position in desk-local space; matches `paintLampGlow`. */
const LAMP_HX = LAMP_X + 38;
/**
 * Effective throw height. The caster is the *shade mouth*, not the filament —
 * the shade is tipped over the desk, so its aperture sits well below the bulb
 * and the shadows it throws are correspondingly longer than a naive filament
 * projection would give.
 */
const LAMP_H = 31;

/** Props that stand on the top surface: (x, half width, height above it). */
const PROP_CASTERS: ReadonlyArray<readonly [number, number, number]> = [
  [TALLY_X, 21, 40],
  [LAMP_X + 4, 12, 18],
  [CARDS_X, 29, 7],
  [SOCKET_X, 9, 7],
  [0, 25, 9],
  [MUG_X, 11, 24],
  [MONITOR_X, 37, 54],
];

/**
 * One shadow, as a stack of trapezoids with falling alpha. A real penumbra
 * widens with distance from the caster, so each layer is both wider and softer
 * than the last. Colour is set once and modulated with `globalAlpha`, so this
 * builds no strings even on the inline fallback path.
 */
function castShadow(
  ctx: CanvasRenderingContext2D,
  baseX: number,
  halfW: number,
  tipX: number,
  tipY: number,
  spread: number,
  alpha: number,
): void {
  if (alpha < 0.008) return;
  const baseY = PROP_Y + 1;
  for (let i = 3; i >= 0; i--) {
    const k = i / 3;
    const grow = 1 + k * 0.85;
    ctx.globalAlpha = alpha * (1 - k * 0.72) * (0.34 + 0.66 * (1 - k));
    ctx.beginPath();
    ctx.moveTo(baseX - halfW * grow, baseY - 3 * grow);
    ctx.lineTo(baseX + halfW * grow, baseY - 3 * grow);
    ctx.lineTo(tipX + halfW * spread * grow, tipY + 3.2 * grow);
    ctx.lineTo(tipX - halfW * spread * grow, tipY + 3.2 * grow);
    ctx.closePath();
    ctx.fill();
  }
}

function paintPropShadows(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  deskTopPath(ctx);
  ctx.clip();
  ctx.fillStyle = "rgb(4,2,1)";
  for (let i = 0; i < PROP_CASTERS.length; i++) {
    const [px, hw, ph] = PROP_CASTERS[i];

    // --- key rig: short, soft, leaning camera-right under everything.
    castShadow(ctx, px, hw, px + ph * 0.55, PROP_Y + 2 + ph * 0.1, 1.4, 0.32);

    // --- lamp: a genuine point projection. The tip runs to H/(H−h), clamped so
    // a prop taller than the shade cannot send its shadow to infinity.
    const dx = px - LAMP_HX;
    const dist = Math.abs(dx);
    const hc = Math.min(ph, LAMP_H * 0.68);
    const scale = Math.min(3.6, LAMP_H / Math.max(5, LAMP_H - hc));
    const tipX = px + clamp(dx * (scale - 1), -260, 260);
    // Falloff from the shade, matched to the reach of the pool it casts.
    const reach = clamp01(1 - dist / 330);
    castShadow(ctx, px, hw, tipX, PROP_Y + 3.5 + ph * 0.05, 1.55, 0.78 * reach * Math.sqrt(reach));

    // --- contact occlusion: tight, dark, and the thing that seats the prop.
    castShadow(ctx, px, hw * 0.94, px + ph * 0.1, PROP_Y + 2, 1.02, 0.6);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** The LED tape in the nosing channel, at its installed brightness. */
function paintEdgeStrip(ctx: CanvasRenderingContext2D, alpha: number): void {
  const h = NOSE_Y - TOP_FRONT_Y;
  const chanY = TOP_FRONT_Y + h * 0.46;
  const x0 = -FRONT_HALF + 3;
  const w = (FRONT_HALF - 3) * 2;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = alpha;
  // Emitter: a hot bone core inside an orange body. Bloom does the rest — a
  // big soft blob here would read as fog, not as a light source.
  ctx.fillStyle = HEMI;
  ctx.fillRect(x0, chanY + 0.4, w, 2.6);
  ctx.fillStyle = "rgba(255,196,140,0.85)";
  ctx.fillRect(x0, chanY + 1.1, w, 1.1);
  // Spill onto the machined faces above and below the channel.
  const spill = ctx.createLinearGradient(0, chanY - 7, 0, chanY + 11);
  spill.addColorStop(0, "rgba(255,90,24,0)");
  spill.addColorStop(0.38, "rgba(255,104,34,0.2)");
  spill.addColorStop(0.5, "rgba(255,132,60,0.32)");
  spill.addColorStop(0.62, "rgba(255,104,34,0.2)");
  spill.addColorStop(1, "rgba(255,90,24,0)");
  ctx.fillStyle = spill;
  ctx.fillRect(x0, chanY - 7, w, 18);
  ctx.restore();
}

/** The lamp bulb and its cone, additive so the shade mouth genuinely emits. */
function paintLampGlow(ctx: CanvasRenderingContext2D, alpha: number): void {
  const hx = LAMP_X + 38;
  const hy = PROP_Y - 52;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = alpha;
  ctx.translate(hx, hy);
  ctx.rotate(0.62);
  // Filament seen through the shade mouth.
  const bulb = ctx.createRadialGradient(3, 9, 0, 3, 9, 16);
  bulb.addColorStop(0, "rgba(255,236,206,0.95)");
  bulb.addColorStop(0.24, "rgba(255,186,110,0.44)");
  bulb.addColorStop(1, "rgba(255,120,40,0)");
  ctx.fillStyle = bulb;
  ctx.fillRect(-16, -8, 38, 34);
  ctx.beginPath();
  ctx.ellipse(3, 9, 11, 3.2, 0.06, 0, TAU);
  ctx.fillStyle = "rgba(255,214,168,0.5)";
  ctx.fill();
  // Cone of light leaving the shade.
  ctx.beginPath();
  ctx.moveTo(-8, 9);
  ctx.lineTo(14, 9);
  ctx.lineTo(52, 74);
  ctx.lineTo(-40, 74);
  ctx.closePath();
  const cone = ctx.createLinearGradient(0, 9, 0, 74);
  cone.addColorStop(0, "rgba(255,196,132,0.2)");
  cone.addColorStop(0.5, "rgba(255,150,72,0.055)");
  cone.addColorStop(1, "rgba(255,120,40,0)");
  ctx.fillStyle = cone;
  ctx.fill();
  ctx.restore();
}

/**
 * Everything static, painted in depth order. Called once into a layer — or, on
 * a host with no offscreen canvas, straight into the frame every draw.
 */
function paintDeskBody(
  ctx: CanvasRenderingContext2D,
  bakery: RenderDeps["bakery"],
  tier: Tier,
  statics: Statics,
  floorY: number,
  bottomY: number,
): void {
  paintFloorShadow(ctx, floorY, bottomY);
  paintDeskTop(ctx, bakery, statics);
  paintLampPool(ctx);
  // The shadows land on the lit surface, under the objects that throw them.
  paintPropShadows(ctx);
  // Props stand on the top surface, so they come after its shading but before
  // the front faces, which are nearer the camera than any of them.
  paintTallyBody(ctx);
  paintLamp(ctx);
  paintCueCards(ctx, statics, 0, 4);
  paintSocket(ctx);
  paintBoomBase(ctx);
  paintMug(ctx);
  paintMonitor(ctx);
  paintNosing(ctx, bakery);
  paintFascia(ctx, bakery, tier, statics);
  paintEdgeStrip(ctx, 0.72);
  paintLampGlow(ctx, 0.62);
}

/**
 * Receptivity mask for dynamic light: white where a surface can take the muzzle
 * flash, weighted by how much of it faces upward. A cheap baked N·L that stops
 * the light pool from spilling into the air around the desk.
 */
function paintDeskMask(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 1;
  deskTopPath(ctx);
  ctx.fill();
  ctx.globalAlpha = 0.75;
  ctx.fillRect(-FRONT_HALF, TOP_FRONT_Y, FRONT_HALF * 2, NOSE_Y - TOP_FRONT_Y);
  ctx.globalAlpha = 0.28;
  ctx.fillRect(-FRONT_HALF, NOSE_Y, FRONT_HALF * 2, PLINTH_Y - NOSE_Y);
  ctx.globalAlpha = 0.1;
  ctx.fillRect(-FRONT_HALF + 18, PLINTH_Y, (FRONT_HALF - 18) * 2, FASCIA_Y - PLINTH_Y);

  // Props: the parts standing proud of the desk are what really catch a flash.
  ctx.globalAlpha = 0.9;
  ctx.fillRect(MUG_X - 11, PROP_Y - 25, 22, 25);
  ctx.fillRect(MONITOR_X - 39, PROP_Y - 62, 78, 62);
  ctx.fillRect(TALLY_X - 29, PROP_Y - 41, 58, 41);
  ctx.fillRect(LAMP_X - 17, PROP_Y - 56, 60, 56);
  ctx.fillRect(CARDS_X - 30, PROP_Y - 34, 60, 34);
  ctx.globalAlpha = 1;
}

/** The lit ON AIR legend, composited additively behind the tally envelope. */
function paintTallyLit(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const w = 58;
  const h = 19;
  const cy = y - 22 - h * 0.5;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  // Diffuser wash: acrylic scatters, so the whole window lifts before the
  // legend does.
  roundRect(ctx, x - w * 0.5 + 3.4, y - 22 - h + 3.2, w - 6.8, h - 6.4, 1.2);
  ctx.fillStyle = "rgba(255,86,20,0.5)";
  ctx.fill();
  const halo = ctx.createRadialGradient(x, cy, 1, x, cy, 40);
  halo.addColorStop(0, "rgba(255,132,58,0.34)");
  halo.addColorStop(0.44, "rgba(255,90,24,0.1)");
  halo.addColorStop(1, "rgba(255,70,0,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(x - 44, cy - 44, 88, 88);
  // Legend, hot enough that the bloom pass has something real to work with.
  ctx.font = FONT_TALLY;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,240,220,0.95)";
  trackedText(ctx, "ON AIR", x, cy + 0.5, 8.2, 0);
  // Bounce onto the desk top under the housing.
  const pool = ctx.createRadialGradient(x, y, 1, x, y, 54);
  pool.addColorStop(0, "rgba(255,120,48,0.2)");
  pool.addColorStop(1, "rgba(255,90,24,0)");
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.3);
  ctx.translate(-x, -y);
  ctx.fillStyle = pool;
  ctx.fillRect(x - 56, y - 56, 112, 112);
  ctx.restore();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * The microphone
 *
 * Baked once in mic-local units: +x runs toward the capsule, the origin is the
 * body centre, and the whole sprite is drawn rotated to the aim with the recoil
 * offset applied. Only the live parts — shock mount, readout, charge collar and
 * the specular that must track real world-up — are painted per frame.
 * ------------------------------------------------------------------ */

const BODY_R = 7.5;
const HEAD_X = 18;
const HEAD_A = 10.6;
const HEAD_B = 9.6;
const COLLAR_X = 8;
const COLLAR_RY = 9.4;
const READOUT_X = -12;
const READOUT_W = 16;
const READOUT_H = 12.5;

/** A machined ring: a dark seat, a bright crown, a shadow on its far side. */
function machinedRing(ctx: CanvasRenderingContext2D, x: number, halfW: number, r: number): void {
  ctx.fillStyle = "#15120f";
  ctx.fillRect(x - halfW - 0.5, -r, halfW * 2 + 1, r * 2);
  const g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, "#3a342f");
  g.addColorStop(0.2, "#b9ada2");
  g.addColorStop(0.38, "#efe7e0");
  g.addColorStop(0.6, "#7d746c");
  g.addColorStop(1, "#241f1c");
  ctx.fillStyle = g;
  ctx.fillRect(x - halfW, -r, halfW * 2, r * 2);
  ctx.fillStyle = "rgba(3,2,2,0.55)";
  ctx.fillRect(x + halfW - 0.5, -r, 0.6, r * 2);
}

function paintMic(ctx: CanvasRenderingContext2D, bakery: RenderDeps["bakery"], tier: Tier): void {
  ctx.lineJoin = "round";

  /* ---- body ------------------------------------------------------- */
  ctx.beginPath();
  ctx.moveTo(MIC_X0 + 2, -BODY_R * 0.78);
  ctx.quadraticCurveTo(MIC_X0, -BODY_R * 0.78, MIC_X0, -BODY_R * 0.6);
  ctx.lineTo(MIC_X0, BODY_R * 0.6);
  ctx.quadraticCurveTo(MIC_X0, BODY_R * 0.78, MIC_X0 + 2, BODY_R * 0.78);
  ctx.lineTo(-27, BODY_R);
  ctx.lineTo(COLLAR_X, BODY_R * 0.95);
  ctx.lineTo(COLLAR_X, -BODY_R * 0.95);
  ctx.lineTo(-27, -BODY_R);
  ctx.closePath();
  // Cylindrical shading: the terminator sits below centre because the key rig
  // is above, and the lower edge lifts again from the desk bounce.
  const barrel = ctx.createLinearGradient(0, -BODY_R, 0, BODY_R);
  barrel.addColorStop(0, "#2c2724");
  barrel.addColorStop(0.16, "#6f665e");
  barrel.addColorStop(0.34, "#a89d93");
  barrel.addColorStop(0.52, "#4a433d");
  barrel.addColorStop(0.82, "#1d1a18");
  barrel.addColorStop(1, "#463d35");
  ctx.fillStyle = barrel;
  ctx.fill();

  // Fine machining marks along the barrel.
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.3;
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = bakery.pattern(ctx, "brushed-metal");
  ctx.fillRect(MIC_X0, -BODY_R, MIC_X1 - MIC_X0, BODY_R * 2);
  ctx.restore();

  machinedRing(ctx, -24.5, 1.5, BODY_R * 1.04);
  machinedRing(ctx, -18, 1.1, BODY_R * 1.02);
  machinedRing(ctx, 3.4, 1.8, BODY_R * 1.05);

  // Model badge, etched into the barrel behind the readout.
  ctx.font = FONT_CAPTION;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(3,2,2,0.7)";
  trackedText(ctx, "MWM-1", -22.5, 3.6, 3.4, 0);
  ctx.fillStyle = "rgba(210,200,190,0.34)";
  trackedText(ctx, "MWM-1", -22.6, 3.1, 3.4, 0);

  /* ---- readout bezel ---------------------------------------------- */
  roundRect(ctx, READOUT_X - READOUT_W * 0.5, -READOUT_H * 0.5, READOUT_W, READOUT_H, 1.6);
  ctx.fillStyle = "#0a0908";
  ctx.fill();
  const bezel = ctx.createLinearGradient(0, -READOUT_H * 0.5, 0, READOUT_H * 0.5);
  bezel.addColorStop(0, "rgba(3,2,2,0.95)");
  bezel.addColorStop(0.35, "rgba(3,2,2,0)");
  bezel.addColorStop(1, "rgba(240,232,224,0.2)");
  ctx.fillStyle = bezel;
  ctx.fill();
  ctx.strokeStyle = "rgba(150,141,133,0.45)";
  ctx.lineWidth = 0.7;
  ctx.stroke();

  /* ---- charge collar groove --------------------------------------- */
  ctx.beginPath();
  ctx.ellipse(COLLAR_X, 0, 4.6, COLLAR_RY, 0, 0, TAU);
  ctx.fillStyle = "#191512";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(COLLAR_X, 0, 4.6, COLLAR_RY, 0, 0, TAU);
  ctx.strokeStyle = "rgba(160,150,142,0.4)";
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(COLLAR_X, 0, 2.6, COLLAR_RY - 2.4, 0, 0, TAU);
  ctx.fillStyle = "#0d0b0a";
  ctx.fill();

  /* ---- capsule grille --------------------------------------------- */
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(HEAD_X, 0, HEAD_A, HEAD_B, 0, 0, TAU);
  ctx.clip();

  // Wire: a spherical metal shell lit from up-left-front.
  const shell = ctx.createRadialGradient(
    HEAD_X - HEAD_A * 0.42,
    -HEAD_B * 0.46,
    0.6,
    HEAD_X,
    0,
    HEAD_A * 1.6,
  );
  shell.addColorStop(0, "#c9bfb5");
  shell.addColorStop(0.28, "#8b827a");
  shell.addColorStop(0.62, "#433d38");
  shell.addColorStop(1, "#16130f");
  ctx.fillStyle = shell;
  ctx.fillRect(HEAD_X - HEAD_A, -HEAD_B, HEAD_A * 2, HEAD_B * 2);

  // Perforations on a hex lattice. Each hole is a dark aperture with a lit
  // lower-right lip where the shell's inner wall catches the key — which is
  // what makes a drawn grille read as depth rather than as a dot screen.
  const pitch = tier.grillePitch;
  const rowStep = pitch * 0.866;
  const hole = pitch * 0.34;
  for (let row = -9; row <= 9; row++) {
    const py = row * rowStep;
    if (Math.abs(py) > HEAD_B + pitch) continue;
    const stagger = (row & 1) === 0 ? 0 : pitch * 0.5;
    for (let col = -9; col <= 9; col++) {
      const px = HEAD_X + col * pitch + stagger;
      const u = (px - HEAD_X) / HEAD_A;
      const v = py / HEAD_B;
      const rr = u * u + v * v;
      if (rr > 0.93) continue;
      // Foreshortening: holes near the silhouette present as ellipses.
      const w = Math.sqrt(1 - rr);
      const sx = Math.max(0.22, w * 0.55 + 0.45);
      ctx.save();
      ctx.translate(px, py);
      ctx.beginPath();
      ctx.ellipse(0, 0, hole * sx, hole, 0, 0, TAU);
      ctx.fillStyle = `rgba(6,5,4,${0.62 + 0.3 * w})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0.18, 0.2, hole * 0.86, -0.5, 2.1);
      ctx.strokeStyle = `rgba(226,214,202,${0.1 + 0.24 * w})`;
      ctx.lineWidth = 0.42;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Supporting wires: three latitude ribs and one meridian.
  ctx.strokeStyle = "rgba(226,216,206,0.2)";
  ctx.lineWidth = 0.9;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.ellipse(HEAD_X, i * HEAD_B * 0.46, HEAD_A * 0.99, HEAD_B * 0.2, 0, 0, TAU);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.ellipse(HEAD_X, 0, HEAD_A * 0.24, HEAD_B * 0.98, 0, 0, TAU);
  ctx.stroke();

  // Specular cap and the dark terminator, applied over the mesh so the head
  // reads as one solid object rather than a decal.
  const gloss = ctx.createRadialGradient(
    HEAD_X - HEAD_A * 0.4,
    -HEAD_B * 0.5,
    0.4,
    HEAD_X - HEAD_A * 0.4,
    -HEAD_B * 0.5,
    HEAD_A * 0.95,
  );
  gloss.addColorStop(0, "rgba(255,246,235,0.5)");
  gloss.addColorStop(0.5, "rgba(255,232,210,0.09)");
  gloss.addColorStop(1, "rgba(255,220,190,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(HEAD_X - HEAD_A, -HEAD_B, HEAD_A * 2, HEAD_B * 2);
  const term = ctx.createLinearGradient(HEAD_X, -HEAD_B, HEAD_X, HEAD_B);
  term.addColorStop(0, "rgba(3,2,2,0)");
  term.addColorStop(0.62, "rgba(3,2,2,0.15)");
  term.addColorStop(1, "rgba(3,2,2,0.62)");
  ctx.fillStyle = term;
  ctx.fillRect(HEAD_X - HEAD_A, -HEAD_B, HEAD_A * 2, HEAD_B * 2);
  ctx.restore();

  // Rim ring where the grille is crimped into the body.
  ctx.beginPath();
  ctx.ellipse(HEAD_X, 0, HEAD_A, HEAD_B, 0, 0, TAU);
  ctx.strokeStyle = "rgba(20,17,15,0.85)";
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(HEAD_X - 0.5, -0.5, HEAD_A, HEAD_B, 0, Math.PI * 1.05, Math.PI * 1.85);
  ctx.strokeStyle = "rgba(239,231,224,0.5)";
  ctx.lineWidth = 0.8;
  ctx.stroke();

  /* ---- windscreen -------------------------------------------------- */
  // A foam collar over the rear of the capsule, leaving the working face of the
  // grille exposed. Matte, fibrous, and it kills the specular where it lands.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(HEAD_X - 4.5, 0, HEAD_A * 0.92, HEAD_B * 1.06, 0, 0, TAU);
  ctx.clip();
  ctx.fillStyle = "#211d1a";
  ctx.fillRect(HEAD_X - 18, -HEAD_B * 1.2, 20, HEAD_B * 2.4);
  ctx.globalAlpha = 0.55;
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = bakery.pattern(ctx, "acoustic-fabric");
  ctx.fillRect(HEAD_X - 18, -HEAD_B * 1.2, 20, HEAD_B * 2.4);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  const foam = ctx.createLinearGradient(0, -HEAD_B, 0, HEAD_B);
  foam.addColorStop(0, "rgba(150,140,132,0.42)");
  foam.addColorStop(0.4, "rgba(60,54,49,0.1)");
  foam.addColorStop(1, "rgba(3,2,2,0.55)");
  ctx.fillStyle = foam;
  ctx.fillRect(HEAD_X - 18, -HEAD_B * 1.2, 20, HEAD_B * 2.4);
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(HEAD_X - 4.5, 0, HEAD_A * 0.92, HEAD_B * 1.06, 0, Math.PI * 0.72, Math.PI * 1.28);
  ctx.strokeStyle = "rgba(180,170,160,0.22)";
  ctx.lineWidth = 0.9;
  ctx.stroke();

  /* ---- cable gland at the tail ------------------------------------- */
  ctx.beginPath();
  ctx.ellipse(MIC_X0 + 0.5, 0, 2.2, BODY_R * 0.62, 0, 0, TAU);
  ctx.fillStyle = "#131110";
  ctx.fill();
  ctx.strokeStyle = "rgba(150,141,133,0.4)";
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 * Light sprites
 * ------------------------------------------------------------------ */

/** Pre-tinted warm pool. Additive drawing of a white sprite reads as fog. */
function paintWarmGlow(ctx: CanvasRenderingContext2D, size: number): void {
  const r = size * 0.5;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, "rgba(255,244,228,1)");
  g.addColorStop(0.12, "rgba(255,226,190,0.78)");
  g.addColorStop(0.3, "rgba(255,168,96,0.34)");
  g.addColorStop(0.56, "rgba(255,104,32,0.11)");
  g.addColorStop(0.8, "rgba(255,70,0,0.026)");
  g.addColorStop(1, "rgba(255,70,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

/**
 * The aim beam: a tapering shaft of light with a hot bone core.
 *
 * The cross-section profile must *compress* with the taper — a linear gradient
 * over a tapered quad would leave the far end flatly core-coloured. So the
 * profile is painted once into column 0 and then blitted into every following
 * column at the height that column's taper calls for, which is exact and costs
 * one gradient.
 */
function paintBeam(ctx: CanvasRenderingContext2D, s: Surface): void {
  const w = s.lw;
  const h = s.lh;
  const cy = h * 0.5;
  const profile = ctx.createLinearGradient(0, 0, 0, h);
  profile.addColorStop(0, "rgba(255,70,0,0)");
  profile.addColorStop(0.26, "rgba(255,80,10,0.3)");
  profile.addColorStop(0.41, "rgba(255,150,74,0.72)");
  profile.addColorStop(0.5, "rgba(255,244,228,1)");
  profile.addColorStop(0.59, "rgba(255,150,74,0.72)");
  profile.addColorStop(0.74, "rgba(255,80,10,0.3)");
  profile.addColorStop(1, "rgba(255,70,0,0)");
  ctx.fillStyle = profile;
  ctx.fillRect(0, 0, 1, h);

  // Reading from the same canvas we are writing to is well defined, and every
  // column samples column 0 only, so there is no feedback.
  for (let x = 1; x < w; x++) {
    const t = x / (w - 1);
    const scale = lerp(1, 0.2, t * t * (3 - 2 * t));
    const dh = h * scale;
    ctx.drawImage(s.canvas, 0, 0, s.k, s.h, x, cy - dh * 0.5, 1, dh);
  }

  // Fade along the run: bright at the lens, gone by the far end.
  ctx.globalCompositeOperation = "destination-in";
  const along = ctx.createLinearGradient(0, 0, w, 0);
  along.addColorStop(0, "rgba(0,0,0,0.55)");
  along.addColorStop(0.05, "rgba(0,0,0,1)");
  along.addColorStop(0.34, "rgba(0,0,0,0.62)");
  along.addColorStop(0.72, "rgba(0,0,0,0.2)");
  along.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
}

/* ------------------------------------------------------------------ *
 * Recoil tuning
 *
 * Expressed as the *peak* each impulse should reach, then converted into the
 * velocity that produces it. Both springs are under-damped, so the rig swings
 * past its rest position on the way back and settles — which is the whole
 * difference between recoil and an ease-out.
 * ------------------------------------------------------------------ */

const RECOIL_K = 210;
const RECOIL_C = 13.5;
const TWIST_K = 260;
const TWIST_C = 12;
const FLEX_K = 120;
const FLEX_C = 7.4;

/** Peak translation back along the aim axis, in logical px. */
const RECOIL_PEAK = 9.5;
/** Peak muzzle rise, in radians (~9°). */
const TWIST_PEAK = 0.157;
/** Peak boom deflection at the yoke, in logical px. */
const FLEX_PEAK = 5.2;

/** Muzzle flash envelope: a two-pole decay with a one-frame attack. */
function flashEnvelope(t: number): number {
  if (!(t >= 0) || t > 0.44) return 0;
  const attack = t < 0.014 ? t / 0.014 : 1;
  return clamp01(attack * (Math.exp(-t / 0.05) + 0.3 * Math.exp(-t / 0.17)));
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export function createDeskRenderer(deps: RenderDeps): DeskRenderer {
  const { bakery, noise, particles, camera, audio } = deps;
  const statics = buildStatics(deps.rng);

  /* ---- baked layers -------------------------------------------- */

  let base: Surface | null = null;
  let mask: Surface | null = null;
  let lit: Surface | null = null;
  let tallyLit: Surface | null = null;
  let micArt: Surface | null = null;
  let beamArt: Surface | null = null;
  let glowArt: Surface | null = null;
  let baked = false;
  /** True when this host cannot bake at all; the art then paints inline. */
  let bakeImpossible = false;

  let boxY1 = FASCIA_Y + 12;
  let tier: Tier = TIERS.high;
  let tierName: QualityTier = "high";

  // Layer identity: anything here changing invalidates every bake.
  let keyX = Number.NaN;
  let keyY = Number.NaN;
  let keyFloor = Number.NaN;
  let keyH = Number.NaN;

  const MIC_BOX_X = MIC_X0 - 4;
  const MIC_BOX_W = MIC_X1 + 6 - MIC_BOX_X;
  const MIC_BOX_H = MIC_Y1 - MIC_Y0;
  const TALLY_BOX_X = TALLY_X - 52;
  const TALLY_BOX_Y = PROP_Y - 72;
  const TALLY_BOX_W = 104;
  const TALLY_BOX_H = 92;
  const GLOW_PX = 128;
  const BEAM_W = 256;
  const BEAM_H = 64;

  /* ---- motion state -------------------------------------------- */

  const recoil: Spring = createSpring({ stiffness: RECOIL_K, damping: RECOIL_C, mass: 1 });
  const twist: Spring = createSpring({ stiffness: TWIST_K, damping: TWIST_C, mass: 1 });
  const flex: Spring = createSpring({ stiffness: FLEX_K, damping: FLEX_C, mass: 1 });
  const recoilGain = 1 / impulsePeak(RECOIL_K, RECOIL_C, 1);
  const twistGain = 1 / impulsePeak(TWIST_K, TWIST_C, 1);
  const flexGain = 1 / impulsePeak(FLEX_K, FLEX_C, 1);
  /** Reticle convergence, 0 = just acquired, 1 = locked. */
  const lock: Spring = createSpring({ stiffness: 150, damping: 19, mass: 1 });
  /** Confidence needle — slow enough to read, fast enough to feel live. */
  const confidence: Spring = createSpring({ stiffness: 110, damping: 20, mass: 1 });

  let rope: Rope | null = null;
  let ropeSegments = 0;

  let flashT = 1;
  let flash = 0;
  /** Barrel heat: rises per shot, bleeds off. Drives the grille's ember. */
  let heat = 0;
  let tally = 0;
  let tallyStrike = 0;
  let tallyLast = 0;
  let relayCooldown = 0;
  let cardLift = 0;
  let mugRipple = 0;
  let queueRow = 0;
  let queueTimer = 0;
  let guidePhase = 0;
  let spinPhase = 0;
  let lockedId = -1;

  /* ---- docked target readout ------------------------------------ *
   * The reticle used to carry its own text slab, offset from the card centre
   * by the reticle radius. The radius is clamped to 72 px and a caller card is
   * up to 262 px wide, so on every wide card the slab was placed *inside* the
   * card's own bounds — and because the aim guide is drawn under the cards, its
   * dark plate vanished behind the glass and only the type came through. That
   * is the "veHEMI… STBY / C055" artefact beside the top caller on 06-midgame.
   *
   * There is nowhere beside a card that is guaranteed free — a card may be
   * anywhere between the gallery band and the stage line, and this module is
   * only ever told about the one it is aiming at — so the readout is not put
   * beside a card at all. It is docked on the desk fascia, below `stageY`,
   * where the simulation guarantees no caller can ever be, and it is painted
   * in `draw`, over the cards rather than under them. */
  let hudWanted = false;
  let hudAlpha = 0;
  let hudLabel = "";
  let hudLocked = false;
  let hudConf = 0;
  let hudRange = 0;

  /* ---- scene mirror -------------------------------------------- */

  let reduced = false;
  let rawTime = 0;
  let sceneW = 1000;
  let sceneH = 620;
  let floorY = -22;

  /* ---- scratch ------------------------------------------------- */

  const pt = { x: 0, y: 0 };
  const frame = {
    ax: 0,
    ay: 0,
    dirX: 0,
    dirY: -1,
    yokeX: 0,
    yokeY: 0,
    ang: -Math.PI * 0.5,
    cos: 0,
    sin: -1,
    /** Local x of the mic origin measured from the yoke. */
    dx: MIC_R - YOKE_R,
    muzzleX: 0,
    muzzleY: 0,
  };
  const armX = new Float32Array(13);
  const armY = new Float32Array(13);

  /* ---- layer construction --------------------------------------- */

  function ensureLayers(scene: SceneContext, desk: DeskView): void {
    const nextFloor = scene.stageY - desk.y;
    const dirty =
      !baked ||
      tierName !== scene.quality ||
      keyX !== desk.x ||
      keyY !== desk.y ||
      keyFloor !== nextFloor ||
      keyH !== scene.height;
    if (!dirty) return;

    tierName = scene.quality;
    tier = TIERS[scene.quality] ?? TIERS.high;
    keyX = desk.x;
    keyY = desk.y;
    keyFloor = nextFloor;
    keyH = scene.height;
    floorY = nextFloor;
    boxY1 = Math.max(FASCIA_Y + 12, scene.height - desk.y + 8);

    const lw = BOX_X1 - BOX_X0;
    const lh = boxY1 - BOX_Y0;

    // The cable is simulation rather than art, so it is rebuilt first — it has
    // to exist even on a host where nothing can be baked at all.
    ropeSegments = tier.ropeSegments;
    rope = createRope(desk.x + SOCKET_X, desk.y + PROP_Y - 2, ropeSegments, 88);

    baked = true;
    if (bakeImpossible) return;

    base = createSurface(lw, lh, tier.bakeK);
    if (!base) {
      // No canvas anywhere: fall back to painting the art inline every frame.
      bakeImpossible = true;
      return;
    }
    base.ctx.translate(-BOX_X0, -BOX_Y0);
    paintDeskBody(base.ctx, bakery, tier, statics, floorY, boxY1);

    if (tier.maskedFlash) {
      mask = createSurface(lw, lh, 0.5);
      if (mask) {
        mask.ctx.translate(-BOX_X0, -BOX_Y0);
        paintDeskMask(mask.ctx);
      }
      lit = createSurface(lw, lh, 0.5);
      if (lit) lit.ctx.translate(-BOX_X0, -BOX_Y0);
    } else {
      mask = null;
      lit = null;
    }

    tallyLit = createSurface(TALLY_BOX_W, TALLY_BOX_H, Math.max(1.6, tier.bakeK));
    if (tallyLit) {
      tallyLit.ctx.translate(-TALLY_BOX_X, -TALLY_BOX_Y);
      paintTallyLit(tallyLit.ctx, TALLY_X, PROP_Y);
    }

    micArt = createSurface(MIC_BOX_W, MIC_BOX_H, Math.max(1.8, tier.bakeK));
    if (micArt) {
      micArt.ctx.translate(-MIC_BOX_X, -MIC_Y0);
      paintMic(micArt.ctx, bakery, tier);
    }

    glowArt = createSurface(GLOW_PX, GLOW_PX, 1);
    if (glowArt) paintWarmGlow(glowArt.ctx, GLOW_PX);

    beamArt = createSurface(BEAM_W, BEAM_H, 1);
    if (beamArt) paintBeam(beamArt.ctx, beamArt);

  }

  /** Resolves the aim-dependent transform once per frame. */
  function syncFrame(desk: DeskView): void {
    const aim = desk.aim;
    frame.ax = desk.x;
    frame.ay = desk.y;
    frame.dirX = Math.cos(aim);
    frame.dirY = Math.sin(aim);
    frame.yokeX = desk.x + frame.dirX * YOKE_R;
    frame.yokeY = desk.y + frame.dirY * YOKE_R;
    // Muzzle rise is a rotation of the whole rig about the shock mount.
    frame.ang = aim - twist.value;
    frame.cos = Math.cos(frame.ang);
    frame.sin = Math.sin(frame.ang);
    frame.dx = MIC_R - YOKE_R - recoil.value;
    micToWorld(HEAD_X + 1.5, 0);
    frame.muzzleX = pt.x;
    frame.muzzleY = pt.y;
  }

  /** Mic-local point to world, into the shared scratch. */
  function micToWorld(lx: number, ly: number): void {
    const ax = frame.dx + lx;
    pt.x = frame.yokeX + frame.cos * ax - frame.sin * ly;
    pt.y = frame.yokeY + frame.sin * ax + frame.cos * ly;
  }

  /* ---- update ---------------------------------------------------- */

  function update(desk: DeskView, scene: SceneContext): void {
    ensureLayers(scene, desk);

    reduced = scene.reducedMotion;
    rawTime = scene.rawTime;
    sceneW = scene.width;
    sceneH = scene.height;
    floorY = scene.stageY - desk.y;

    // Mechanics run on scaled time: a hit-stop should freeze the rig mid-recoil
    // and then let it continue, which is exactly what sells the impact.
    const dt = scene.dt;
    const raw = scene.rawDt;
    recoil.update(dt);
    twist.update(dt);
    flex.update(dt);
    lock.update(raw);
    confidence.update(raw);

    // Lights and readouts run on real time so they never stall.
    flashT += raw;
    // Reduced motion attenuates the envelope *and* slows it: a longer, gentler
    // rise and fall can never read as a strobe however fast the player fires.
    flash = reduced ? flashEnvelope(flashT * 0.55) * 0.55 : flashEnvelope(flashT);
    heat = damp(heat, 0, 2.6, raw);

    // The dock follows the reticle by one frame; `drawAimGuide` raises the flag
    // and this consumes it, so losing the target fades the plate out instead of
    // cutting it.
    hudAlpha = damp(hudAlpha, hudWanted ? 1 : 0, 13, raw);
    hudWanted = false;

    /* --- ON AIR tally: real hardware, not a boolean ---------------- */
    let want: number;
    if (scene.phase === "playing" || scene.phase === "won") {
      want = 1;
    } else if (scene.phase === "idle") {
      // Standby cadence, 0.55 Hz — well under the reduced-motion flash ceiling.
      want = (scene.rawTime % 1.82) < 1 ? 0.55 : 0.04;
    } else {
      want = 0;
    }
    if (want > tally + 0.25 && tallyLast <= 0.5 && want >= 0.9) {
      // Filament strike: a real tally overshoots when the relay closes.
      tallyStrike = 0.22;
      if (relayCooldown <= 0) {
        audio.play("ui-click", { gain: 0.32, rate: 0.72 });
        relayCooldown = 0.6;
      }
    }
    tallyLast = want;
    relayCooldown = Math.max(0, relayCooldown - raw);
    // Asymmetric thermal response: filaments rise fast and fall slow.
    tally = damp(tally, want, want > tally ? 26 : 9, raw);
    tallyStrike = damp(tallyStrike, 0, 13, raw);

    /* --- props ---------------------------------------------------- */
    cardLift = damp(cardLift, 0, 3.4, raw);
    mugRipple = damp(mugRipple, 0, 2.2, raw);
    queueTimer += raw;
    if (queueTimer > 1.35) {
      queueTimer -= 1.35;
      queueRow = (queueRow + 1) % QUEUE_ROWS;
    }
    if (!reduced) {
      guidePhase += raw * 0.85;
      spinPhase += raw * 0.28;
      if (guidePhase > 1e6) guidePhase = 0;
      if (spinPhase > 1e6) spinPhase = 0;
    }

    /* --- cable ----------------------------------------------------- */
    syncFrame(desk);
    if (rope) {
      micToWorld(MIC_X0 + 1, BODY_R * 0.34);
      rope.setEnd(pt.x, pt.y);
      rope.update(dt, 1500, tier.ropeIterations);
      // Non-penetration: the cable rests on the desk top instead of sinking
      // through it, and never slides off the sides.
      const rest = desk.y + TOP_FRONT_Y - 3;
      const left = desk.x - FRONT_HALF + 10;
      const right = desk.x + FRONT_HALF - 10;
      const pts = rope.points;
      for (let i = 1; i < pts.length - 1; i++) {
        const p = pts[i];
        if (p.y > rest) {
          p.y = rest;
          // Kill the normal component only; the cable still slides laterally.
          if (p.py > rest) p.py = rest;
          // Tangential friction against the desk top: scale the verlet
          // velocity, which lives in (x − px), rather than adding to it.
          p.px = p.x - (p.x - p.px) * 0.62;
        }
        if (p.x < left) p.x = left;
        else if (p.x > right) p.x = right;
      }
    }
  }

  /* ---- fire ------------------------------------------------------ */

  function onFire(desk: DeskView): void {
    syncFrame(desk);
    const gain = reduced ? 0.55 : 1;

    flashT = 0;
    flash = 1;
    heat = Math.min(1, heat + 0.34);
    cardLift = 1;
    mugRipple = 1;

    recoil.impulse(RECOIL_PEAK * recoilGain * gain);
    twist.impulse(TWIST_PEAK * twistGain * gain);
    flex.impulse(FLEX_PEAK * flexGain * gain);

    const mx = frame.muzzleX;
    const my = frame.muzzleY;
    particles.emit("muzzle-flash", {
      x: mx,
      y: my,
      angle: desk.aim,
      scale: reduced ? 0.8 : 1.12,
      color: HEMI,
    });
    if (!reduced && (tierName === "high" || tierName === "ultra")) {
      // A breath of smoke leaving the grille, drawn behind the rig.
      particles.emit("smoke-puff", {
        x: mx - frame.dirX * 4,
        y: my - frame.dirY * 4,
        count: 2,
        scale: 0.42,
        angle: desk.aim,
        spread: 1.1,
        speed: 34,
        life: 1.1,
        behind: true,
      });
    }

    // The rig pushes the operator: the camera takes a punch opposite the shot.
    const kick = reduced ? 1.8 : 6.6;
    camera.addImpulse(-frame.dirX * kick, -frame.dirY * kick);
    if (!reduced) {
      camera.addTrauma(0.11);
      camera.addZoom(0.004);
    }

    // Cable whip: shift each point's previous position to inject a real verlet
    // velocity, weighted toward the mic end where the shock actually arrives.
    if (rope) {
      const pts = rope.points;
      const n = pts.length;
      const strength = 3.6 * gain;
      for (let i = 1; i < n - 1; i++) {
        const t = i / (n - 1);
        const k = t * t * strength * statics.whip[i % MAX_ROPE];
        pts[i].px += frame.dirX * k;
        pts[i].py += frame.dirY * k;
      }
    }
  }

  /* ---- dynamic desk dressing ------------------------------------- */

  /** The caller-queue monitor: live content, phosphor glow and a refresh band. */
  function drawMonitor(ctx: CanvasRenderingContext2D, scene: SceneContext): void {
    const sw = 78;
    const sh = 48;
    const pressure = scene.maxBacklog > 0 ? clamp01(scene.backlog / scene.maxBacklog) : 0;
    const hot = pressure > 0.7;

    ctx.save();
    ctx.translate(MONITOR_X, PROP_Y - 14);
    ctx.rotate(-0.05);
    ctx.beginPath();
    ctx.rect(-sw * 0.5 + 3.5, -sh + 3.5, sw - 7, sh - 11);
    ctx.clip();

    const x0 = -sw * 0.5 + 5;
    const w = sw - 10;

    // Header.
    ctx.fillStyle = hot ? HEMI : "#39332f";
    ctx.fillRect(x0, -sh + 5.5, w, 7);
    ctx.fillStyle = hot ? "rgba(20,8,2,0.9)" : "rgba(200,190,182,0.72)";
    ctx.fillRect(x0 + 2, -sh + 8, 3, 2);
    ctx.fillRect(x0 + 6.5, -sh + 8, 16, 2);
    ctx.fillRect(x0 + 25, -sh + 8, 9, 2);
    ctx.font = FONT_BADGE;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = hot ? "#1a0a02" : BONE_85;
    ctx.fillText(String(Math.min(99, Math.max(0, Math.round(scene.backlog)))), x0 + w - 2, -sh + 9.2);

    // Queue rows: filled to the backlog, the active one picked out in bone.
    const rows = QUEUE_ROWS;
    const filled = Math.min(rows, Math.ceil(scene.backlog));
    for (let i = 0; i < rows; i++) {
      const ry = -sh + 16.5 + i * 6.2;
      const live = i < filled;
      const active = live && i === queueRow % rows;
      ctx.globalAlpha = live ? (active ? 1 : 0.6) : 0.16;
      ctx.fillStyle = active ? HEMI : "#4c453f";
      ctx.fillRect(x0, ry, 4, 4);
      ctx.fillStyle = active ? BONE_85 : "rgba(150,141,133,0.75)";
      ctx.fillRect(x0 + 6, ry + 0.6, statics.rowWidth[i * 2] * 34, 1.6);
      ctx.fillStyle = "rgba(120,112,105,0.6)";
      ctx.fillRect(x0 + 6, ry + 3, statics.rowWidth[i * 2 + 1] * 22, 1.2);
    }
    ctx.globalAlpha = 1;

    // Line structure. A monitor photographed by a broadcast camera always has it.
    ctx.fillStyle = "rgba(2,4,5,0.34)";
    for (let y = -sh + 4; y < -8; y += 2) ctx.fillRect(-sw * 0.5 + 3.5, y, sw - 7, 1);

    if (!reduced) {
      // Refresh band rolling down the panel at a slow, non-strobing rate.
      const band = ((rawTime * 0.42) % 1) * (sh - 11) - (sh - 3.5);
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "rgba(120,160,180,0.06)";
      ctx.fillRect(-sw * 0.5 + 3.5, band, sw - 7, 7);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();

    // Phosphor spill onto the desk and the bezel.
    if (glowArt) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.1 + (hot ? 0.1 : 0) + pressure * 0.05;
      ctx.drawImage(glowArt.canvas, MONITOR_X - 62, PROP_Y - 74, 124, 92);
      ctx.restore();
    }
  }

  /** Steam off the mug: slow, noise-driven, never a symmetrical squiggle. */
  function drawSteam(ctx: CanvasRenderingContext2D): void {
    const wisps = reduced ? Math.min(2, tier.steamWisps) : tier.steamWisps;
    if (wisps <= 0) return;
    const baseY = PROP_Y - 25;
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < wisps; i++) {
      const ph = statics.steamPhase[i] + rawTime * (reduced ? 0.24 : 0.42);
      const lean = statics.steamLean[i];
      const sx = MUG_X - 5 + i * 4.4;
      ctx.beginPath();
      ctx.moveTo(sx, baseY);
      for (let s = 1; s <= 4; s++) {
        const t = s / 4;
        const y = baseY - t * 26;
        const drift = noise.n2(ph + t * 1.7, i * 3.1) * 7 * t + lean * t * t * 6;
        ctx.lineTo(sx + drift, y);
      }
      ctx.strokeStyle = withAlpha(BONE, 0.075 - i * 0.012);
      ctx.lineWidth = 1.7;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Everything on the desk that reacts, drawn in desk-local coordinates. */
  function drawDressing(ctx: CanvasRenderingContext2D, scene: SceneContext): void {
    // Cue stack grows with the backlog — the questions really are piling up.
    const extra =
      scene.maxBacklog > 0
        ? Math.min(MAX_CARDS - 4, Math.round(clamp01(scene.backlog / scene.maxBacklog) * 7))
        : 0;
    if (extra > 0) {
      ctx.save();
      // The top of the stack kicks when the mic fires next to it.
      if (cardLift > 0.01 && !reduced) ctx.translate(0, -cardLift * 1.6);
      paintCueCards(ctx, statics, 4, 4 + extra);
      ctx.restore();
    }

    drawSteam(ctx);
    if (mugRipple > 0.01) {
      // The coffee answers the recoil.
      const wob = Math.sin(rawTime * 26) * mugRipple * 0.9;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(MUG_X, PROP_Y - 24.5 + wob * 0.3, 8.8, 2.3 + wob * 0.4, 0, 0, TAU);
      ctx.strokeStyle = withAlpha(WARM_WHITE, 0.1 * mugRipple);
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.restore();
    }

    drawMonitor(ctx, scene);

    // LED tape: installed brightness plus a little lift with the show's energy.
    const h = NOSE_Y - TOP_FRONT_Y;
    const chanY = TOP_FRONT_Y + h * 0.46;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.1 + scene.intensity * 0.16 + flash * 0.3;
    ctx.fillStyle = HEMI;
    ctx.fillRect(-FRONT_HALF + 3, chanY + 0.4, (FRONT_HALF - 3) * 2, 2.6);
    ctx.restore();

    // Lamp: a slow filament wander, plus a kick from the muzzle.
    if (glowArt) {
      const wander = reduced ? 0 : noise.n2(rawTime * 2.1, 41.3) * 0.05;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = clamp01(0.13 + wander + flash * 0.08);
      // Anchored tight on the bulb rather than smeared over the whole prop:
      // the glow has to look like the source, not like fog around it.
      ctx.drawImage(glowArt.canvas, LAMP_X + 38 - 34, PROP_Y - 52 - 34, 68, 68);
      ctx.restore();
    }

    // ON AIR.
    if (tallyLit && tally > 0.004) {
      const flicker = reduced ? 1 : 1 + noise.n2(rawTime * 7.4, 3.7) * 0.035;
      ctx.save();
      ctx.globalAlpha = clamp01((tally + tallyStrike) * flicker);
      ctx.drawImage(
        tallyLit.canvas,
        TALLY_BOX_X,
        TALLY_BOX_Y,
        TALLY_BOX_W,
        TALLY_BOX_H,
      );
      ctx.restore();
    }
  }

  /* ---- muzzle lighting ------------------------------------------- */

  /**
   * The flash is a real light source, so it must land on real surfaces. The
   * pool is drawn into a scratch layer, tinted, then clipped by the baked
   * receptivity mask before being added to the frame — which is what keeps the
   * light on the desk instead of hanging in the air in front of it.
   */
  function drawFlashPool(ctx: CanvasRenderingContext2D, desk: DeskView): void {
    if (flash <= 0.012 || !glowArt) return;
    const amount = flash;
    const localMx = clamp(frame.muzzleX - desk.x, -FRONT_HALF, FRONT_HALF);

    if (tier.maskedFlash && lit && mask) {
      const lw = BOX_X1 - BOX_X0;
      const lh = boxY1 - BOX_Y0;
      const c = lit.ctx;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, lit.w, lit.h);
      c.restore();
      c.globalCompositeOperation = "lighter";
      // Pool on the top surface, squashed because the plane is near-horizontal.
      c.drawImage(glowArt.canvas, localMx - 230, PROP_Y - 44, 460, 128);
      // A second, tighter pool where the light actually falls hardest.
      c.drawImage(glowArt.canvas, localMx - 96, PROP_Y - 30, 192, 66);
      c.globalCompositeOperation = "source-in";
      c.fillStyle = "#ffb877";
      c.fillRect(BOX_X0, BOX_Y0, lw, lh);
      c.globalCompositeOperation = "destination-in";
      c.drawImage(mask.canvas, BOX_X0, BOX_Y0, lw, lh);
      c.globalCompositeOperation = "source-over";

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = clamp01(amount * 0.95);
      ctx.drawImage(lit.canvas, BOX_X0, BOX_Y0, lw, lh);
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = clamp01(amount * 0.42);
      ctx.drawImage(glowArt.canvas, localMx - 190, PROP_Y - 46, 380, 104);
      ctx.restore();
    }

    // Hot return along the machined nosing: a genuine specular the bloom pass
    // can grab, rather than a soft blob pretending to be glow.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = clamp01(amount * 0.55);
    ctx.fillStyle = WARM_WHITE;
    ctx.fillRect(-FRONT_HALF, TOP_FRONT_Y - 1, FRONT_HALF * 2, 1.1);
    ctx.globalAlpha = clamp01(amount * 0.3);
    ctx.fillRect(-FRONT_HALF, NOSE_Y - 1.2, FRONT_HALF * 2, 0.9);
    ctx.restore();
  }

  /** Light thrown past the desk onto the studio deck either side of it. */
  function drawFloorPool(ctx: CanvasRenderingContext2D, desk: DeskView): void {
    if (flash <= 0.012 || !glowArt) return;
    const amount = flash;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = clamp01(amount * 0.34);
    const cy = desk.y + Math.max(floorY + 16, TOP_BACK_Y + 26);
    ctx.drawImage(glowArt.canvas, desk.x - 430, cy - 92, 860, 184);
    ctx.globalAlpha = clamp01(amount * 0.2);
    ctx.drawImage(glowArt.canvas, desk.x - 240, cy - 54, 480, 108);
    ctx.restore();
  }

  /* ---- the rig ---------------------------------------------------- */

  /** Traces a tapered strip through a sampled centreline. */
  function stripPath(
    ctx: CanvasRenderingContext2D,
    n: number,
    hw0: number,
    hw1: number,
    off: number,
  ): void {
    ctx.beginPath();
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < n; k++) {
        const i = pass === 0 ? k : n - 1 - k;
        const t = i / (n - 1);
        const pi = i > 0 ? i - 1 : 0;
        const ni = i < n - 1 ? i + 1 : n - 1;
        let tx = armX[ni] - armX[pi];
        let ty = armY[ni] - armY[pi];
        const l = Math.hypot(tx, ty) || 1;
        tx /= l;
        ty /= l;
        const hw = lerp(hw0, hw1, t) * (pass === 0 ? 1 : -1);
        const nx = -ty;
        const ny = tx;
        const x = armX[i] + nx * (hw + off);
        const y = armY[i] + ny * (hw + off);
        if (pass === 0 && k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
  }

  function drawBoom(ctx: CanvasRenderingContext2D, desk: DeskView): void {
    const bx = desk.x;
    const by = desk.y + BOOM_BASE_Y - 3;
    const ex = frame.yokeX;
    const ey = frame.yokeY;
    let ux = ex - bx;
    let uy = ey - by;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len;
    uy /= len;
    // Bow the arm away from the deck, and let the flex spring bend it further.
    let px = -uy;
    let py = ux;
    if (py > 0) {
      px = -px;
      py = -py;
    }
    const bow = 9 + flex.value;
    const cx = (bx + ex) * 0.5 + px * bow;
    const cy = (by + ey) * 0.5 + py * bow;

    const n = armX.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const it = 1 - t;
      armX[i] = it * it * bx + 2 * it * t * cx + t * t * ex;
      armY[i] = it * it * by + 2 * it * t * cy + t * t * ey;
    }

    ctx.save();
    ctx.lineJoin = "round";
    stripPath(ctx, n, 3.7, 2.4, 0);
    ctx.fillStyle = "#2b2724";
    ctx.fill();
    // Specular return along the lit side, and occlusion on the other.
    stripPath(ctx, n, 1, 0.7, -2.1);
    ctx.fillStyle = ALU_80;
    ctx.fill();
    stripPath(ctx, n, 0.9, 0.6, 2.3);
    ctx.fillStyle = "rgba(3,2,2,0.6)";
    ctx.fill();

    // Knuckle joint, two thirds of the way out.
    const ki = Math.round((n - 1) * 0.46);
    ctx.beginPath();
    ctx.arc(armX[ki], armY[ki], 4.4, 0, TAU);
    ctx.fillStyle = "#4a443e";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(armX[ki] - 0.8, armY[ki] - 0.8, 4.4, Math.PI * 1.02, Math.PI * 1.98);
    ctx.strokeStyle = BONE_60;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(armX[ki], armY[ki], 1.5, 0, TAU);
    ctx.fillStyle = "#171412";
    ctx.fill();
    ctx.restore();
  }

  /* Shock-mount band table: rest lengths depend only on constants, so they are
   * solved once per band count and reused. */
  let bandCount = 0;
  const bandTheta = new Float32Array(8);
  const bandBx = new Float32Array(8);
  const bandBy = new Float32Array(8);
  const bandRest = new Float32Array(8);
  const YOKE_RX = 6.4;
  const YOKE_RY = 19;

  function ensureBands(n: number): void {
    if (bandCount === n) return;
    bandCount = n;
    const dx0 = MIC_R - YOKE_R;
    for (let i = 0; i < n; i++) {
      const th = -Math.PI * 0.5 + ((i + 0.5) * TAU) / n;
      bandTheta[i] = th;
      // Alternate fore and aft cradle points so the suspension really triangulates.
      const bx = (i & 1) === 0 ? -9 : 5;
      const by = Math.sign(Math.sin(th) || 1) * BODY_R * 0.86;
      bandBx[i] = bx;
      bandBy[i] = by;
      const rx = YOKE_RX * Math.cos(th);
      const ry = YOKE_RY * Math.sin(th);
      bandRest[i] = Math.hypot(dx0 + bx - rx, by - ry);
    }
  }

  function drawShockMount(ctx: CanvasRenderingContext2D, desk: DeskView): void {
    const n = Math.min(8, tier.shockBands);
    ensureBands(n);
    const ca = Math.cos(desk.aim);
    const sa = Math.sin(desk.aim);

    // Elastics first: they pass behind the body and in front of the ring.
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const th = bandTheta[i];
      const lrx = YOKE_RX * Math.cos(th);
      const lry = YOKE_RY * Math.sin(th);
      const rx = frame.yokeX + ca * lrx - sa * lry;
      const ry = frame.yokeY + sa * lrx + ca * lry;
      micToWorld(bandBx[i], bandBy[i]);
      const bx = pt.x;
      const by = pt.y;
      const d = Math.hypot(bx - rx, by - ry);
      // Slack turns into visible sag; stretch pulls the band straight and pale.
      const slack = Math.max(0, bandRest[i] + 0.6 - d);
      const stretch = clamp01((d - bandRest[i]) / 5);
      let nx = -(by - ry);
      let ny = bx - rx;
      const l = Math.hypot(nx, ny) || 1;
      nx = (nx / l) * slack * 1.5;
      ny = (ny / l) * slack * 1.5;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.quadraticCurveTo((rx + bx) * 0.5 + nx, (ry + by) * 0.5 + ny, bx, by);
      ctx.strokeStyle = withAlpha(BONE, 0.3 + stretch * 0.4);
      ctx.lineWidth = 1.5 - stretch * 0.4;
      ctx.stroke();
      ctx.strokeStyle = "rgba(3,2,2,0.5)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    ctx.restore();

    // Yoke ring, rigid on the boom: this is what the body swings inside.
    ctx.save();
    ctx.translate(frame.yokeX, frame.yokeY);
    ctx.rotate(desk.aim);
    ctx.beginPath();
    ctx.ellipse(0, 0, YOKE_RX, YOKE_RY, 0, 0, TAU);
    ctx.strokeStyle = "#241f1c";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = ALU_MID;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-0.5, -0.6, YOKE_RX, YOKE_RY, 0, Math.PI * 0.72, Math.PI * 1.32);
    ctx.strokeStyle = BONE_60;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function drawMic(ctx: CanvasRenderingContext2D, desk: DeskView): void {
    const charge = clamp01(desk.charge);
    ctx.save();
    ctx.translate(frame.yokeX, frame.yokeY);
    ctx.rotate(frame.ang);
    ctx.translate(frame.dx, 0);

    if (micArt) ctx.drawImage(micArt.canvas, MIC_BOX_X, MIC_Y0, MIC_BOX_W, MIC_BOX_H);
    else paintMic(ctx, bakery, tier);

    /* --- loaded-letter readout ------------------------------------ */
    const rw = READOUT_W - 3.2;
    const rh = READOUT_H - 3.2;
    const rx = READOUT_X - rw * 0.5;
    const ry = -rh * 0.5;
    roundRect(ctx, rx, ry, rw, rh, 1);
    ctx.fillStyle = "#180b04";
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = clamp01(0.16 + charge * 0.34 + flash * 0.24 + heat * 0.1);
    ctx.fillStyle = HEMI;
    roundRect(ctx, rx, ry, rw, rh, 1);
    ctx.fill();
    // The glyph is the brightest thing on the rig, so the bloom pass finds it.
    ctx.globalAlpha = clamp01(0.62 + charge * 0.38);
    ctx.fillStyle = WARM_WHITE;
    ctx.save();
    ctx.translate(READOUT_X, 0.3);
    // The readout is upright relative to the barrel: its "up" points at the
    // capsule, so it stays legible across the whole aim arc.
    ctx.rotate(Math.PI * 0.5);
    ctx.font = FONT_READOUT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(desk.letter.slice(0, 1), 0, 0);
    ctx.restore();
    ctx.restore();
    // Panel structure: two dead rows, as any real segment display has.
    ctx.fillStyle = "rgba(6,3,1,0.4)";
    ctx.fillRect(rx, ry + rh * 0.34, rw, 0.7);
    ctx.fillRect(rx, ry + rh * 0.66, rw, 0.7);

    /* --- charge collar -------------------------------------------- */
    if (charge > 0.001) {
      const start = -Math.PI * 0.5;
      const end = start + charge * TAU;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.beginPath();
      ctx.ellipse(COLLAR_X, 0, 4.6, COLLAR_RY, 0, start, end);
      ctx.strokeStyle = HEMI;
      ctx.lineWidth = 2.2;
      ctx.globalAlpha = 0.55 + charge * 0.3;
      ctx.stroke();
      ctx.strokeStyle = WARM_WHITE;
      ctx.lineWidth = 0.9;
      ctx.globalAlpha = 0.4 + charge * 0.4;
      ctx.stroke();
      // Leading edge, so the fill reads as a moving quantity.
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(COLLAR_X + Math.cos(end) * 4.6, Math.sin(end) * COLLAR_RY, 1.5, 0, TAU);
      ctx.fillStyle = WARM_WHITE;
      ctx.fill();
      if (charge > 0.995 && glowArt) {
        // Armed: the collar throws a little light of its own.
        const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(rawTime * 4.4);
        ctx.globalAlpha = 0.16 + pulse * 0.12;
        ctx.drawImage(glowArt.canvas, COLLAR_X - 26, -26, 52, 52);
      }
      ctx.restore();
    }

    /* --- specular that tracks real world-up ----------------------- */
    // The baked shading rotates with the sprite; this puts a highlight back
    // where the studio key actually is, and fades as the barrel turns edge-on.
    const upY = -Math.cos(frame.ang);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.08 + Math.abs(upY) * 0.2;
    ctx.strokeStyle = WARM_WHITE;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-26, upY * BODY_R * 0.5);
    ctx.lineTo(4, upY * BODY_R * 0.5);
    ctx.stroke();
    ctx.restore();

    /* --- residual barrel heat ------------------------------------- */
    if (heat > 0.02 && glowArt) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = heat * 0.26;
      ctx.drawImage(glowArt.canvas, HEAD_X - 22, -22, 44, 44);
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---- docked target readout ------------------------------------ *
   * A machined pocket on the desk fascia, on the same baseline grid as the MWM
   * ident plate opposite it, so the desk reads as one console rather than a
   * plate with a caption stuck to it. Everything on it is measured before it is
   * placed: the badge column is reserved first and the caller label is
   * ellipsised into what is left, never hard-cut mid-word.
   */
  const DOCK_X = 130;
  const DOCK_W = 122;
  const DOCK_H = 21;
  /** The pocket's inner shading never changes, so it is built once. */
  let dockPocket: CanvasGradient | null = null;

  function drawTargetDock(ctx: CanvasRenderingContext2D): void {
    if (hudAlpha < 0.008) return;
    const a = clamp01(hudAlpha);
    const x = DOCK_X;
    const y = IDENT_Y;

    ctx.save();
    ctx.globalAlpha = a;

    // Recessed pocket, matching the ident inlay: shadow along the top edge, a
    // catch-light along the bottom.
    roundRect(ctx, x, y, DOCK_W, DOCK_H, 2.5);
    ctx.fillStyle = "#12100f";
    ctx.fill();
    if (!dockPocket) {
      const g = ctx.createLinearGradient(0, y, 0, y + DOCK_H);
      g.addColorStop(0, "rgba(3,2,2,0.9)");
      g.addColorStop(0.45, "rgba(3,2,2,0)");
      g.addColorStop(1, "rgba(255,235,214,0.13)");
      dockPocket = g;
    }
    ctx.fillStyle = dockPocket;
    ctx.fill();

    // State rail down the inboard edge: hemi on a lock, aluminium on standby.
    ctx.fillStyle = hudLocked ? HEMI_80 : withAlpha(ALU_MID, 0.85);
    ctx.fillRect(x, y + 2, 1.8, DOCK_H - 4);

    const padL = x + 7;
    const padR = x + DOCK_W - 6;

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = FONT_CAPTION;
    ctx.fillStyle = withAlpha(ALUMINIUM, 0.62);
    trackedText(ctx, "ON CALL", padL, y + 6, 5.6, -1);

    const badge = hudLocked ? "LOCK" : "STBY";
    ctx.font = FONT_BADGE;
    ctx.textAlign = "right";
    ctx.fillStyle = hudLocked ? withAlpha(HEMI_HOT, 0.95) : withAlpha(ALUMINIUM, 0.7);
    ctx.fillText(badge, padR, y + 6);

    // Range counter, right-aligned on the label row so it can never meet it.
    ctx.font = FONT_MONO;
    ctx.fillStyle = ALU_80;
    const rangeText = `R${pad3(hudRange)}`;
    const rangeW = Math.ceil(ctx.measureText(rangeText).width);
    ctx.fillText(rangeText, padR, y + 15);

    ctx.textAlign = "left";
    ctx.font = FONT_HUD;
    ctx.fillStyle = BONE_85;
    ctx.fillText(fitLabel(ctx, hudLabel, padR - rangeW - SLAB_BADGE_GAP - padL), padL, y + 15);

    // Confidence hairline along the bottom of the pocket.
    ctx.fillStyle = withAlpha(ALU_DARK, 0.8);
    ctx.fillRect(padL, y + DOCK_H - 3.4, padR - padL, 1.4);
    ctx.fillStyle = withAlpha(hudLocked ? HEMI : ALUMINIUM, 0.9);
    ctx.fillRect(padL, y + DOCK_H - 3.4, (padR - padL) * clamp01(hudConf), 1.4);

    ctx.restore();
  }

  function drawMuzzleFlare(ctx: CanvasRenderingContext2D, aim: number): void {
    if (flash <= 0.02) return;
    const amount = flash;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (glowArt) {
      ctx.globalAlpha = clamp01(amount * 0.85);
      ctx.drawImage(glowArt.canvas, frame.muzzleX - 46, frame.muzzleY - 46, 92, 92);
    }
    // Anamorphic star from the lens, aligned with the shot.
    ctx.globalAlpha = clamp01(amount * 0.5);
    ctx.translate(frame.muzzleX, frame.muzzleY);
    ctx.rotate(aim);
    const s = 90 + amount * 60;
    ctx.drawImage(bakery.get("star-flare"), -s * 0.5, -s * 0.5, s, s);
    ctx.restore();
  }

  /* ---- draw ------------------------------------------------------- */

  function draw(context: CanvasRenderingContext2D, desk: DeskView, scene: SceneContext): void {
    ensureLayers(scene, desk);
    syncFrame(desk);

    drawFloorPool(context, desk);

    context.save();
    context.translate(desk.x, desk.y);
    if (base) {
      context.drawImage(base.canvas, BOX_X0, BOX_Y0, BOX_X1 - BOX_X0, boxY1 - BOX_Y0);
    } else {
      // No offscreen canvas on this host: the identical art, painted inline.
      paintDeskBody(context, bakery, tier, statics, floorY, boxY1);
    }
    drawDressing(context, scene);
    drawTargetDock(context);
    drawFlashPool(context, desk);
    context.restore();

    if (rope) rope.draw(context, { width: 5, color: "#151211", highlight: "#5f574f" });
    drawBoom(context, desk);
    drawShockMount(context, desk);
    drawMic(context, desk);
    drawMuzzleFlare(context, desk.aim);
  }

  /* ---- aim guide --------------------------------------------------- */

  /** Corner brackets on the card's real bounds — the extent read-out. */
  function drawBounds(
    ctx: CanvasRenderingContext2D,
    hw: number,
    hh: number,
    arm: number,
    alpha: number,
  ): void {
    ctx.strokeStyle = withAlpha(BONE, alpha);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        ctx.moveTo(sx * hw - sx * arm, sy * hh);
        ctx.lineTo(sx * hw, sy * hh);
        ctx.moveTo(sx * hw, sy * hh - sy * arm);
        ctx.lineTo(sx * hw, sy * hh);
      }
    }
    ctx.stroke();
  }

  /* ---- readout typography ---------------------------------------- *
   * Everything on the status slab is measured before it is placed, and every
   * measurement is cached on the string that produced it — so the per-frame
   * path costs a comparison, never a text layout.
   */

  const labelFit = { source: "", max: -1, out: "" };

  /** Longest prefix of `text` that fits `max`, ellipsised properly if trimmed. */
  function fitLabel(ctx: CanvasRenderingContext2D, text: string, max: number): string {
    if (labelFit.source === text && labelFit.max === max) return labelFit.out;
    ctx.font = FONT_HUD;
    let out = text;
    if (ctx.measureText(out).width > max) {
      while (out.length > 1 && ctx.measureText(out + "…").width > max) out = out.slice(0, -1);
      // Never leave the ellipsis hanging off a space or a punctuation mark.
      let end = out.length;
      while (end > 1 && " .,;:!?-".indexOf(out.charAt(end - 1)) >= 0) end--;
      out = out.slice(0, end) + "…";
    }
    labelFit.source = text;
    labelFit.max = max;
    labelFit.out = out;
    return out;
  }

  function drawReticle(
    ctx: CanvasRenderingContext2D,
    desk: DeskView,
    target: QuestionView,
    energy: number,
  ): void {
    const tx = target.x;
    const ty = target.y;
    const dx = tx - frame.muzzleX;
    const dy = ty - frame.muzzleY;
    const dist = Math.hypot(dx, dy);

    // Confidence: how well the barrel is actually pointed, gated by whether the
    // loaded letter is the one this caller is waiting for.
    const off = Math.abs(angleDelta(desk.aim, Math.atan2(dy, dx)));
    const aimQuality = 1 - smoothstep(0.02, 0.36, off);
    const conf = clamp01(
      aimQuality * (0.55 + 0.45 * clamp01(desk.charge)) * (target.targeted ? 1 : 0.5),
    );
    confidence.set(conf);
    const shown = clamp01(confidence.value);

    if (target.id !== lockedId) {
      lockedId = target.id;
      lock.snap(0);
      lock.set(1);
    }
    const converge = ease.outCubic(clamp01(lock.value));
    const spread = lerp(1.9, 1, converge);
    const R = clamp(Math.max(target.width, target.height) * 0.52, 26, 72);
    const locked = target.targeted && shown > 0.55;
    const key = locked ? HEMI : ALUMINIUM;

    ctx.save();
    ctx.translate(tx, ty);
    ctx.globalAlpha = energy * lerp(0.45, 1, converge);
    ctx.lineCap = "round";

    // Card extent, unrotated so it stays a measurement rather than decoration.
    drawBounds(ctx, target.width * 0.5 + 6, target.height * 0.5 + 6, 9, 0.3);

    // Converging brackets. They arrive with a twist that unwinds as they lock.
    ctx.save();
    ctx.rotate((1 - converge) * 0.44 + (reduced ? 0 : Math.sin(spinPhase * 2.1) * 0.012));
    const arm = R * 0.46;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        const cx = sx * R * spread;
        const cy = sy * R * spread * 0.74;
        ctx.beginPath();
        ctx.moveTo(cx - sx * arm, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy - sy * arm * 0.7);
        ctx.strokeStyle = withAlpha(BONE, 0.85);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - sx * arm * 0.72, cy + sy * 2.4);
        ctx.lineTo(cx - sx * 2.4, cy + sy * 2.4);
        ctx.strokeStyle = withAlpha(key, 0.8);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();

    // Graduated ring: 24 ticks, four of them cardinal. Rotates while hunting.
    ctx.save();
    ctx.rotate(reduced ? 0 : spinPhase * 0.7);
    const ringR = R * 0.78 + 8;
    ctx.strokeStyle = withAlpha(ALUMINIUM, 0.28);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      const long = i % 6 === 0;
      const r0 = ringR;
      const r1 = ringR + (long ? 6 : 2.6);
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * 0.74);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 * 0.74);
    }
    ctx.stroke();
    ctx.restore();

    // Confidence arc: a real gauge, drawn on its own track.
    const arcR = ringR + 11;
    const a0 = -Math.PI * 0.5 - 2.16;
    const a1 = -Math.PI * 0.5 + 2.16;
    ctx.beginPath();
    ctx.arc(0, 0, arcR, a0, a1);
    ctx.strokeStyle = withAlpha(ALU_DARK, 0.75);
    ctx.lineWidth = 3;
    ctx.stroke();
    const aEnd = a0 + (a1 - a0) * shown;
    ctx.beginPath();
    ctx.arc(0, 0, arcR, a0, aEnd);
    ctx.strokeStyle = withAlpha(key, 0.95);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(Math.cos(aEnd) * arcR, Math.sin(aEnd) * arcR, 2, 0, TAU);
    ctx.fillStyle = locked ? WARM_WHITE : BONE;
    ctx.fill();

    // Centre reference.
    ctx.strokeStyle = withAlpha(key, 0.7);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI * 0.25;
      ctx.moveTo(Math.cos(a) * 5, Math.sin(a) * 5);
      ctx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10);
    }
    ctx.stroke();

    /* Range mark on the near edge of the card: the one piece of the old status
       slab worth keeping in the play field, because it is a measurement of the
       card rather than a caption about it. */
    ctx.globalAlpha = energy * converge * 0.5;
    ctx.strokeStyle = withAlpha(key, 0.8);
    ctx.lineWidth = 1;
    const edge = target.height * 0.5 + 6;
    ctx.beginPath();
    ctx.moveTo(-9, dy > 0 ? -edge : edge);
    ctx.lineTo(9, dy > 0 ? -edge : edge);
    ctx.stroke();
    ctx.restore();

    /* The caption itself is handed to the desk dock, which paints it in `draw`
       below the stage line — clear of every caller by construction. */
    hudWanted = true;
    hudAlpha = Math.max(hudAlpha, energy * converge);
    hudLabel = target.label;
    hudLocked = locked;
    hudConf = shown;
    hudRange = dist / 4;
  }

  /**
   * The aim guide is *targeting hardware*, not light.
   *
   * It has to be findable across a busy frame while sitting well below the
   * caller cards and the practicals in brightness, so it is built as a dark
   * sight rail — it reads by occluding the set, not by adding to it — carrying
   * a dashed centre line, machined range ticks and a terminus bracket landing
   * on the card's near edge. The only additive element of a *resting* aim is a
   * small emitter bloom at the capsule.
   *
   * Firing is a different graphic altogether: for a quarter of a second the
   * rail carries a hot tapered channel, so a letter in flight can never be
   * mistaken for an aim. Reduced motion keeps the composition and stops the
   * dash travelling and the channel strobing.
   */
  function drawAimGuide(
    context: CanvasRenderingContext2D,
    desk: DeskView,
    scene: SceneContext,
    target: QuestionView | null,
  ): void {
    ensureLayers(scene, desk);
    syncFrame(desk);

    const ready = clamp01(desk.charge);
    const phaseEnergy =
      scene.phase === "playing" ? 1 : scene.phase === "idle" ? 0.4 : 0.12;
    // Dim on cooldown, a little firmer when the fire control is armed.
    const energy = phaseEnergy * (0.42 + 0.58 * ready);
    if (energy < 0.03) return;
    if (!target) confidence.set(0);

    const mx = frame.muzzleX;
    const my = frame.muzzleY;
    const far = Math.hypot(sceneW, sceneH);
    // Terminate on the card's *near edge*, not short of it: a guide that stops
    // in the air below the caller is what put the old beam's bright tip 16 px
    // beneath the panel it was pointing at.
    const len = target
      ? clamp(Math.hypot(target.x - mx, target.y - my) - target.height * 0.5, 48, far)
      : Math.min(far, 430);

    context.save();
    context.translate(mx, my);
    context.rotate(desk.aim);
    context.lineCap = "butt";

    // 1 — the rail body. Dark, source-over: no light is added to the frame.
    context.globalAlpha = clamp01(energy * 0.34);
    context.fillStyle = RAIL_INK;
    context.fillRect(0, -3.2, len, 6.4);

    // 2 — machined section: a lit upper lip and a shadowed lower one.
    context.globalAlpha = clamp01(energy * 0.3);
    context.fillStyle = ALU_55;
    context.fillRect(0, -3.3, len, 0.7);
    context.globalAlpha = clamp01(energy * 0.14);
    context.fillRect(0, 2.6, len, 0.7);

    // 3 — dashed centre line running out toward the caller.
    context.globalAlpha = clamp01(energy * (0.3 + 0.18 * ready));
    context.strokeStyle = BONE_38;
    context.lineWidth = 1;
    context.setLineDash(GUIDE_DASH);
    context.lineDashOffset = reduced ? 0 : -guidePhase * 46;
    context.beginPath();
    context.moveTo(3, 0.5);
    context.lineTo(len, 0.5);
    context.stroke();
    context.setLineDash(NO_DASH);
    context.lineDashOffset = 0;

    // 4 — range graticule. Every fourth tick is long, which is what turns a
    // line into an instrument.
    context.globalAlpha = clamp01(energy * 0.28);
    context.strokeStyle = ALU_55;
    context.beginPath();
    let index = 0;
    for (let d = TICK_STEP; d < len - 7; d += TICK_STEP) {
      const t = index % 4 === 3 ? 6 : 3;
      context.moveTo(d + 0.5, -t);
      context.lineTo(d + 0.5, t);
      index++;
    }
    context.stroke();

    // 5 — terminus bracket, sitting on the surface the letter will strike.
    if (target) {
      context.globalAlpha = clamp01(energy * 0.62);
      context.strokeStyle = BONE_60;
      context.lineWidth = 1.2;
      context.beginPath();
      context.moveTo(len - 5, -7.5);
      context.lineTo(len - 0.5, -7.5);
      context.lineTo(len - 0.5, 7.5);
      context.lineTo(len - 5, 7.5);
      context.stroke();
    }

    // 6 — shot channel: the rail goes hot only while a letter is in flight.
    const channel = flashT < CHANNEL_SECONDS ? 1 - flashT / CHANNEL_SECONDS : 0;
    if (channel > 0.01 && beamArt) {
      const amp = channel * channel * (reduced ? 0.42 : 1);
      const width = 6 + 7 * amp;
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = clamp01(amp * 0.9);
      context.drawImage(beamArt.canvas, 0, -width * 0.5, len, width);
      context.globalCompositeOperation = "source-over";
    }
    context.restore();

    // 7 — emitter bloom at the capsule. Small: the guide has to come from
    // somewhere, but the capsule is not the brightest thing in the studio.
    if (glowArt) {
      context.save();
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = clamp01(energy * 0.1);
      context.drawImage(glowArt.canvas, mx - 22, my - 22, 44, 44);
      context.restore();
    }

    if (target) drawReticle(context, desk, target, energy);
    else lockedId = -1;
  }

  return { update, draw, drawAimGuide, onFire };
}
