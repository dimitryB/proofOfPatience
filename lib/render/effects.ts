/**
 * POP — projectiles and every impact moment.
 *
 * This module owns *game feel*: the thing that makes a correct letter land like
 * a rivet gun and a wrong one land like a door slammed in your face. Nothing in
 * here is decorative filler — each event is authored as a stack of layers that
 * arrive on different curves, because a single burst on a single curve always
 * reads as a particle preset rather than as an event.
 *
 * The five moments, and what makes each one legible at a glance:
 *
 *   HIT      white-hot flash (~80 ms, hottest on frame one) → back-scattered
 *            sparks along the real impact normal → a shock ring squashed into
 *            the surface → glyph shrapnel → camera punch *along* the shot.
 *   REJECT   achromatic deflection plate, a *contracting* ring, dull dust, the
 *            shot's own letter tumbling back out, and a broadcast error tick.
 *            Camera punches *backwards*. Nothing here is ever hot or orange.
 *   ANSWER   double flash, staggered wide rings, confetti and shreds, embers,
 *            a real lens-flare chain (ghosts mirrored through the frame centre)
 *            and typography that grows with the combo. x9 dwarfs x1.
 *   LAND     dust kicked along the floor, bouncing debris, two pressure fronts
 *            that travel *outward along the stage line* lifting dust as they
 *            go, video static, and the hardest camera hit in the game.
 *   POP OFF  a radial sweep from frame centre that visibly crosses the screen,
 *            every clear point erupting as the front reaches it, a full-frame
 *            bloom veil, and a per-character tracked typographic callout.
 *
 * Craft notes that are easy to miss:
 *   - Impact direction is *measured*, not guessed: `drawShots` records each
 *     shot's last position and velocity, so `onHit`/`onReject` can spray sparks
 *     along the true normal and rebound the letter that was actually fired.
 *   - Bright means bright. The post chain thresholds bloom at ~0.95, so flashes
 *     are painted as small genuinely-white cores instead of large soft blobs —
 *     the bloom pass is what turns them into light.
 *   - World-space impact art advances on `scene.dt`, so hit-stop holds the
 *     money frame. Typography advances on `scene.rawDt`, because broadcast
 *     graphics are composited downstream of the camera and never stutter.
 *   - Particle *counts* are scaled by the particle system itself (it owns the
 *     quality and reduced-motion tables). This module scales what it owns:
 *     which authored layers exist, camera shake, flash cadence and its pools.
 *
 * Performance contract: every record is preallocated and recycled; every sprite
 * is tinted once and cached; every colour string, font string and sprite handle
 * is resolved at *spawn* time and stored on the record, so the draw loops only
 * modulate `globalAlpha`. No draw path builds a cache key, calls
 * `createLinearGradient`, or calls `measureText` (callouts measure their glyph
 * advances once and animate the tracking over the cached values).
 *
 * Hard rules honoured: no `Math.random` (everything stochastic comes from the
 * injected `Rng`), no DOM at module scope (surfaces bake lazily on first use),
 * and `scene.reducedMotion` removes shake, caps flash cadence below 3 Hz and
 * stops every strobe while leaving the composition identical.
 */

import { clamp, clamp01, ease, lerp, mixColor, parseColor, shade, withAlpha } from "../engine/core";
import { createRibbon } from "../engine/fx";
import { GAME_HEIGHT, GAME_WIDTH, STAGE_Y, patienceTier } from "../pop";
import type {
  EffectsRenderer,
  QualityTier,
  RenderDeps,
  Ribbon,
  Rng,
  SceneContext,
  ShotView,
  TextureId,
} from "./types";

/* ------------------------------------------------------------------ *
 * Palette — hemi orange is the only saturated hue on the set
 * ------------------------------------------------------------------ */

/** Near-white with a touch of tungsten: the colour of something genuinely hot. */
const HOT_WHITE = "#fff8ef";
const HOT = "#fff4e6";
const HOT_DEEP = "#ffc48a";
const HEMI = "#ff4600";
const HEMI_HOT = "#ff2a00";
const HEMI_EMBER = "#8f2000";
const BONE = "#efe7e0";
const ALUMINIUM = "#8d8781";
const ALU_MID = "#5b544e";
const ALU_DARK = "#3a3532";
const INK = "#080604";
/** Warm neutral for the air-distortion multiply and for rejected material. */
const WARM_GREY = "#9c8f82";
const DUST = "#6d5e51";

const TAU = Math.PI * 2;

/* Prebuilt translucent strings. None of these may be constructed in a draw. */
const INK_80 = withAlpha(INK, 0.8);
const INK_70 = withAlpha(INK, 0.7);
const INK_55 = withAlpha(INK, 0.55);
const INK_38 = withAlpha(INK, 0.38);
const INK_88 = withAlpha(INK, 0.88);
const BONE_18 = withAlpha(BONE, 0.18);
const BONE_30 = withAlpha(BONE, 0.3);
const BONE_50 = withAlpha(BONE, 0.5);
const BONE_55 = withAlpha(BONE, 0.55);
const BONE_82 = withAlpha(BONE, 0.82);
const ALU_45 = withAlpha(ALUMINIUM, 0.45);
const HEMI_70 = withAlpha(HEMI, 0.7);
const DENY_LINE = "#cfc6bd";

/* Type. Broadcast graphics: a heavy slab everywhere, hardware mono for labels. */
const FONT_SLAB = '900 %px "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const FONT_CAPTION = '800 8px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FONT_SUB = '800 13px "Helvetica Neue", Arial, system-ui, sans-serif';

/** Substitutes a pixel size into a font template. Only ever called on spawn. */
function sized(template: string, px: number): string {
  return template.replace("%", String(Math.round(px)));
}

/* ------------------------------------------------------------------ *
 * Quality tiers
 *
 * Particle *counts* are the particle system's business — it owns the quality
 * and reduced-motion multipliers. What this table controls is which authored
 * layers exist at all, and how finely the local sprites are baked.
 * ------------------------------------------------------------------ */

interface Tier {
  /** Supersample factor for locally baked sprites (letter tiles, tints). */
  bakeK: number;
  /** Soft light halo carried by a shot. */
  halo: boolean;
  /** Leading air-distortion smear (one `multiply` pass per shot). */
  smear: boolean;
  /** Sparks shed along a shot's path. */
  trailSparks: boolean;
  /** Ribbon sample budget. */
  ribbonPoints: number;
  /** Lens-flare chain on answers and pop-off. */
  flare: boolean;
  /** Garnish layers: smoke behind impacts, glass shards, extra rings. */
  garnish: boolean;
  /** Concentric bands in the pop-off sweep; each is one full-frame blit. */
  sweepBands: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: { bakeK: 1, halo: false, smear: false, trailSparks: false, ribbonPoints: 14, flare: false, garnish: false, sweepBands: 1 },
  medium: { bakeK: 1.25, halo: true, smear: false, trailSparks: true, ribbonPoints: 20, flare: true, garnish: false, sweepBands: 1 },
  high: { bakeK: 1.75, halo: true, smear: true, trailSparks: true, ribbonPoints: 26, flare: true, garnish: true, sweepBands: 2 },
  ultra: { bakeK: 2.25, halo: true, smear: true, trailSparks: true, ribbonPoints: 32, flare: true, garnish: true, sweepBands: 3 },
};

/* ------------------------------------------------------------------ *
 * Offscreen surfaces
 * ------------------------------------------------------------------ */

interface Surface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
}

/**
 * Bake target in *logical* units: the context is pre-scaled by `k`, so every
 * baker below draws in design pixels and supersampling is free.
 *
 * Returns null during server rendering, where no canvas exists at all; every
 * consumer treats that as "skip this layer" rather than throwing.
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
  return { canvas, ctx };
}

/** Rounded rectangle without `CanvasPath.roundRect`, which is still young. */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w * 0.5, h * 0.5);
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

/* ------------------------------------------------------------------ *
 * Pools
 *
 * Every record is allocated once at construction and then recycled forever.
 * `sweep` swap-*exchanges* references rather than splicing, so a retired record
 * lands back in the free region of the same array and is reused verbatim.
 * ------------------------------------------------------------------ */

interface Timed {
  life: number;
  maxLife: number;
}

interface Pool<T extends Timed> {
  items: T[];
  count: number;
}

function makePool<T extends Timed>(size: number, make: () => T): Pool<T> {
  const items: T[] = new Array<T>(size);
  for (let i = 0; i < size; i++) items[i] = make();
  return { items, count: 0 };
}

/**
 * Reserves a record. When the pool is saturated the record with the least life
 * left is stolen — the one whose loss the player is least able to notice.
 */
function take<T extends Timed>(pool: Pool<T>): T {
  if (pool.count < pool.items.length) return pool.items[pool.count++];
  let best = 0;
  for (let i = 1; i < pool.count; i++) {
    if (pool.items[i].life < pool.items[best].life) best = i;
  }
  return pool.items[best];
}

function sweep<T extends Timed>(pool: Pool<T>, dt: number): void {
  for (let i = 0; i < pool.count; ) {
    const item = pool.items[i];
    item.life -= dt;
    if (item.life <= 0) {
      const last = pool.count - 1;
      pool.items[i] = pool.items[last];
      pool.items[last] = item;
      pool.count = last;
    } else {
      i++;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Record shapes
 * ------------------------------------------------------------------ */

/** Flash styles. A hit flares round; a rejection flares as a flat plate. */
const FL_ROUND = 0;
const FL_PLATE = 1;

interface Flash extends Timed {
  x: number;
  y: number;
  size: number;
  /** Anamorphic bar strength, 0 = none. */
  bar: number;
  /** Peak alpha, after the reduced-motion cadence limiter has had its say. */
  peak: number;
  rot: number;
  style: number;
  /** Body colour, resolved to a tinted sprite once at spawn. */
  color: string;
  art: CanvasImageSource | null;
  coreArt: CanvasImageSource | null;
  barArt: CanvasImageSource | null;
}

/** Ring styles. */
const RS_SHOCK = 0;
const RS_WIDE = 1;
const RS_DENY = 2;
const RS_SWEEP = 3;
/** The pop-off detonation front: a struck leading edge over a dark compression. */
const RS_FRONT = 4;

interface Ring extends Timed {
  x: number;
  y: number;
  r0: number;
  r1: number;
  /** Squash across the impact normal: a shock off a surface is a hemisphere. */
  squash: number;
  rot: number;
  alpha: number;
  width: number;
  style: number;
  bands: number;
  color: string;
  art: CanvasImageSource | null;
}

interface Wave extends Timed {
  x: number;
  y: number;
  dir: number;
  dist: number;
  speed: number;
  strength: number;
  /** Distance accumulator for the dust the front lifts as it travels. */
  dust: number;
  seed: number;
}

interface Ghost extends Timed {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  size: number;
  letter: string;
  font: string;
}

interface Tick extends Timed {
  x: number;
  y: number;
  letter: string;
  font: string;
}

interface Flare extends Timed {
  x: number;
  y: number;
  strength: number;
}

interface Popup extends Timed {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  font: string;
  /** Horizontal drift, so simultaneous popups separate as they rise. */
  driftX: number;
  rise: number;
  seed: number;
  /** Estimated half width, used by the stacking solver. */
  halfWidth: number;
}

/** Callout styles. A reward arrives as free type; a failure arrives as plant. */
const CO_TIER = 0;
const CO_FAIL = 1;

interface Callout extends Timed {
  title: string;
  sub: string;
  x: number;
  y: number;
  size: number;
  /** 0–1 escalation: drives rule weight and the impact double strike. */
  power: number;
  titleFont: string;
  measured: boolean;
  advances: Float32Array;
  /** Sum of the cached advances, before tracking is applied. */
  rawWidth: number;
  style: number;
}

/** Deferred eruption scheduled by the pop-off wave. */
interface Erupt {
  x: number;
  y: number;
  delay: number;
  size: number;
  color: string;
  used: boolean;
}

/** Per-shot presentation state, keyed by `ShotView.id`. */
interface Trail {
  id: number;
  ribbon: Ribbon;
  /** Frame index this trail was last seen alive; drives orphan detection. */
  frame: number;
  orphan: boolean;
  orphanAge: number;
  x: number;
  y: number;
  /** Unit travel direction, retained after the shot itself is gone. */
  dx: number;
  dy: number;
  letter: string;
  /** Distance accumulator for path sparks. */
  shed: number;
  seed: number;
  started: boolean;
  /** Resolved tile art, so the draw loop never builds a cache key. */
  tile: Tile | null;
  /** Bake scale the cached tile was made at; a tier change re-resolves it. */
  tileK: number;
}

interface Tile {
  body: CanvasImageSource;
  hot: CanvasImageSource;
}

/* ------------------------------------------------------------------ *
 * Pool sizes — the worst honest case, not a pathological one: a pop-off
 * with twenty clears landing while four shots are still in flight.
 * ------------------------------------------------------------------ */

const MAX_TRAILS = 20;
const MAX_FLASH = 40;
const MAX_RING = 48;
const MAX_WAVE = 6;
const MAX_GHOST = 10;
const MAX_TICK = 8;
const MAX_FLARE = 10;
const MAX_POPUP = 32;
const MAX_CALLOUT = 3;
const MAX_ERUPT = 28;

/** Projectile geometry, in logical pixels. */
const TILE_CELL = 64;
const TILE_W = 30;
const TILE_H = 34;
/** Nominal muzzle speed (see the simulation): the reference for stretch. */
const NOMINAL_SPEED = 1060;

/**
 * Contact correction, in logical pixels along the travel direction.
 *
 * The simulation reports an impact at the *projectile's* position on the frame
 * the collision test passed, and that test runs against a box inflated by the
 * difficulty's aim assist — `CARD_HALF_HEIGHT + 3 + hitPadding × 0.35`, up to
 * 44.5 px against a card whose real half height is 31 — sampled once per
 * 1/60 s step at 2 300 px/s. The reported point therefore sits *below* the
 * caller's lower bevel, and the whole impact stack (flash, ring, sparks, the
 * score popup) lands in empty air under the panel it was supposed to hit.
 *
 * Pushing the event forward along the measured travel direction puts it back on
 * the surface that was actually struck. The card's own on-panel reaction lives
 * in `question.ts`, which can follow the card as it recoils; this only has to
 * put the world-space debris in the right place at the moment it spawns.
 */
const CONTACT_BIAS = 26;
/** The tile glyph face, built once — never inside a bake loop or a draw path. */
const FONT_TILE = sized(FONT_SLAB, TILE_H * 0.62);

/** Ribbon tint ramp, indexed by scene intensity. Built once per renderer. */
const RIBBON_STEPS = 6;

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export function createEffectsRenderer(deps: RenderDeps): EffectsRenderer {
  const { bakery, camera, particles, noise } = deps;
  // Independent streams: baking must never shift the effect sequence, and an
  // effect must never shift a bake. Salts are stable, so replays are identical.
  const fxRng: Rng = deps.rng.fork(0x4546_5843);

  /* ---- live scene snapshot ------------------------------------- *
   * Event callbacks arrive from the simulation and can land before the first
   * `update`, so every field has a defensible default from the game constants.
   */
  let tier: Tier = TIERS.high;
  let quality: QualityTier = "high";
  let reduced = false;
  let viewW = GAME_WIDTH;
  let viewH = GAME_HEIGHT;
  let floorY = STAGE_Y;
  let intensity = 0;
  /** Unscaled seconds; drives the reduced-motion flash cadence limiter. */
  let uiTime = 0;
  let frame = 0;
  let warmed = false;

  /* ---- pools ---------------------------------------------------- */

  const flashes = makePool<Flash>(MAX_FLASH, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, size: 40, bar: 0, peak: 1, rot: 0,
    style: FL_ROUND, color: HOT_WHITE, art: null, coreArt: null, barArt: null,
  }));
  const rings = makePool<Ring>(MAX_RING, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, r0: 8, r1: 60, squash: 1, rot: 0,
    alpha: 1, width: 2, style: RS_SHOCK, bands: 1, color: HEMI, art: null,
  }));
  const waves = makePool<Wave>(MAX_WAVE, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, dir: 1, dist: 0, speed: 900, strength: 1, dust: 0, seed: 0,
  }));
  const ghosts = makePool<Ghost>(MAX_GHOST, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, vx: 0, vy: 0, rot: 0, spin: 0, size: 30, letter: "S", font: sized(FONT_SLAB, 30),
  }));
  const ticks = makePool<Tick>(MAX_TICK, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, letter: "S", font: sized(FONT_SLAB, 22),
  }));
  const flares = makePool<Flare>(MAX_FLARE, () => ({ life: 0, maxLife: 1, x: 0, y: 0, strength: 1 }));
  const popups = makePool<Popup>(MAX_POPUP, () => ({
    life: 0, maxLife: 1, x: 0, y: 0, text: "", color: BONE, size: 18,
    font: sized(FONT_SLAB, 18), driftX: 0, rise: 34, seed: 0, halfWidth: 10,
  }));
  const callouts = makePool<Callout>(MAX_CALLOUT, () => ({
    life: 0, maxLife: 1, title: "", sub: "", x: 0, y: 0, size: 62, power: 1,
    titleFont: sized(FONT_SLAB, 62), measured: false, advances: new Float32Array(48),
    rawWidth: 0, style: CO_TIER,
  }));

  /** Trails are keyed by shot id rather than by life, so they live outside the pools. */
  const trails: Trail[] = [];
  const trailById = new Map<number, Trail>();

  /** Pop-off eruption schedule. A flat ring of records; `used` marks spent ones. */
  const erupts: Erupt[] = new Array<Erupt>(MAX_ERUPT);
  for (let i = 0; i < MAX_ERUPT; i++) erupts[i] = { x: 0, y: 0, delay: 0, size: 40, color: HEMI, used: true };
  let eruptCount = 0;

  /** Full-frame bloom veil for pop-off. One at a time by construction. */
  let veilLife = 0;
  let veilMax = 1;
  let veilPeak = 0;

  /** Damage surge for the failure beat. Also one at a time by construction. */
  let failLife = 0;
  let failMax = 1;
  let failArt: CanvasImageSource | null = null;
  let failBaked = false;

  /** Reduced motion must not strobe: full-intensity flashes are rate limited. */
  let lastBigFlash = -10;

  /** Ribbon tints, mixed once in OKLab so the ramp never dips through mud. */
  const ribbonRamp: string[] = new Array<string>(RIBBON_STEPS);
  for (let i = 0; i < RIBBON_STEPS; i++) {
    ribbonRamp[i] = mixColor(HEMI, HOT_DEEP, 0.16 + 0.36 * (i / (RIBBON_STEPS - 1)), "oklab");
  }

  /**
   * Eruption tints, drawn from a *fixed* four-entry palette rather than a
   * continuous ramp. A pop-off fires up to `MAX_ERUPT` bursts inside one
   * second; picking a fresh colour per burst would push that many one-off
   * entries through the tint cache and force re-bakes during the single most
   * expensive moment in the game. Four tints read as varied and cache forever.
   */
  const eruptTints: string[] = [
    HEMI,
    mixColor(HEMI, HOT_DEEP, 0.34, "oklab"),
    mixColor(HEMI, HOT_DEEP, 0.68, "oklab"),
    HOT_DEEP,
  ];

  /* ---- tinted sprite cache --------------------------------------- *
   * The bakery's sprites are white-on-transparent, so drawing one with
   * `lighter` always produces white; a coloured shock ring needs a pre-tinted
   * copy. Tint = sprite × colour (multiply), alpha restored with
   * `destination-in`, then an optional concentrated white core added back on
   * top so the element still reads as *hot* rather than merely orange.
   */

  // Sized to hold the whole realistic working set at once — the nine fixed
  // sprites plus a glow and a ring tint for every caller-card colour in the
  // catalogue — so the cache never clears and re-bakes during a round.
  const tintCache = new Map<string, CanvasImageSource | null>();
  const TINT_LIMIT = 64;

  function quantise(css: string): string {
    const c = parseColor(css);
    const q = (v: number): string => {
      const s = (Math.round(v / 17) * 17).toString(16);
      return s.length < 2 ? "0" + s : s;
    };
    return "#" + q(c.r) + q(c.g) + q(c.b);
  }

  function tinted(id: TextureId, color: string, core: number): CanvasImageSource | null {
    // The core amount is part of the identity, quantised to quarters so a
    // continuous authoring value cannot spray one-off entries into the cache.
    const key = id + "|" + quantise(color) + "|" + Math.round(core * 4) + "|" + tier.bakeK;
    const hit = tintCache.get(key);
    if (hit !== undefined) return hit;
    if (tintCache.size >= TINT_LIMIT) tintCache.clear();

    const logical = bakery.size(id);
    const surface = createSurface(logical, logical, tier.bakeK);
    if (!surface) {
      // No canvas anywhere (server render). Cache the miss so we do not retry
      // the allocation every frame, and let every consumer skip the layer.
      tintCache.set(key, null);
      return null;
    }
    const ctx = surface.ctx;
    const art = bakery.get(id);
    ctx.drawImage(art, 0, 0, logical, logical);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, logical, logical);
    // Multiply painted an opaque rectangle; the sprite's own alpha is the mask.
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(art, 0, 0, logical, logical);
    if (core > 0) {
      // A concentrated white core, taken from the *untinted* art at half scale.
      // This is the part the post chain's bloom threshold actually sees.
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = core;
      const s = logical * 0.5;
      ctx.drawImage(art, logical * 0.25, logical * 0.25, s, s);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = "source-over";
    tintCache.set(key, surface.canvas);
    return surface.canvas;
  }

  /**
   * The sprites used every frame, resolved once per quality tier so no draw
   * path ever builds a cache key. Dynamic tints (per-card ring and flash
   * colours) are resolved once per *event* and stored on the record instead.
   */
  interface SpriteSet {
    bakeK: number;
    glowHemi: CanvasImageSource | null;
    glowWarm: CanvasImageSource | null;
    glowWhite: CanvasImageSource | null;
    glowFloor: CanvasImageSource | null;
    streakHot: CanvasImageSource | null;
    smokeDust: CanvasImageSource | null;
    flareHex: CanvasImageSource | null;
    flareBokeh: CanvasImageSource | null;
    flareStar: CanvasImageSource | null;
  }
  let sprites: SpriteSet | null = null;

  function ensureSprites(): SpriteSet {
    if (sprites && sprites.bakeK === tier.bakeK) return sprites;
    sprites = {
      bakeK: tier.bakeK,
      glowHemi: tinted("glow", HEMI, 0),
      glowWarm: tinted("glow", WARM_GREY, 0),
      glowWhite: tinted("glow", HOT_WHITE, 0.5),
      glowFloor: tinted("glow", HEMI_HOT, 0.3),
      streakHot: tinted("streak", HOT_DEEP, 0.6),
      smokeDust: tinted("smoke", DUST, 0),
      flareHex: tinted("flare", HOT_DEEP, 0),
      flareBokeh: tinted("bokeh", HEMI, 0),
      flareStar: tinted("star-flare", HOT, 0.5),
    };
    return sprites;
  }

  /* ---- letter tiles ---------------------------------------------- *
   * A machined tile, baked once per glyph as two cells:
   *
   *   body  aluminium slab — vertical light ramp, brushed grain, a chamfer lit
   *         from the upper-left key, knurled flanks, rivets, and the glyph cut
   *         *into* a recessed channel (dark groove, bright far wall).
   *   hot   the emissive channel alone: a layered halo under a white glyph plus
   *         a hot rim along the leading edge. Composited with `lighter` at a
   *         pulsing alpha, so the tile has a real filament rather than a tint.
   */

  const tileCache = new Map<string, Tile | null>();

  function bakeTileBody(letter: string, k: number): Surface | null {
    const surface = createSurface(TILE_CELL, TILE_CELL, k);
    if (!surface) return null;
    const ctx = surface.ctx;
    const cx = TILE_CELL * 0.5;
    const cy = TILE_CELL * 0.5;
    const x0 = cx - TILE_W * 0.5;
    const y0 = cy - TILE_H * 0.5;
    const r = 5;

    // --- contact shadow: the tile is an object in a lit room, not a decal.
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = INK;
    roundedRect(ctx, x0 + 1.6, y0 + 2.4, TILE_W, TILE_H, r);
    ctx.fill();
    ctx.globalAlpha = 1;

    // --- body ramp. The key rig is above, so the top face is the brightest.
    const ramp = ctx.createLinearGradient(0, y0, 0, y0 + TILE_H);
    ramp.addColorStop(0, shade(ALUMINIUM, 0.24));
    ramp.addColorStop(0.34, ALUMINIUM);
    ramp.addColorStop(0.72, ALU_MID);
    ramp.addColorStop(1, shade(ALU_DARK, -0.25));
    roundedRect(ctx, x0, y0, TILE_W, TILE_H, r);
    ctx.fillStyle = ramp;
    ctx.fill();

    ctx.save();
    roundedRect(ctx, x0, y0, TILE_W, TILE_H, r);
    ctx.clip();

    // --- brushed grain. `overlay` keeps the ramp's luminance and adds only the
    // anisotropic streaking, which is what "brushed" actually looks like.
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = bakery.pattern(ctx, "brushed-metal", "repeat");
    ctx.fillRect(x0 - 2, y0 - 2, TILE_W + 4, TILE_H + 4);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // --- chamfer: the same silhouette stroked twice, offset toward and away
    // from the key. Clipped, so only the inner half of each stroke survives —
    // which is exactly how a machined bevel catches light.
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = BONE_50;
    ctx.save();
    ctx.translate(-0.9, -1);
    roundedRect(ctx, x0, y0, TILE_W, TILE_H, r);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = withAlpha(INK, 0.62);
    ctx.save();
    ctx.translate(1, 1.1);
    roundedRect(ctx, x0, y0, TILE_W, TILE_H, r);
    ctx.stroke();
    ctx.restore();

    // --- knurled flanks: three machined ticks a side, each with its own lit lip.
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? withAlpha(INK, 0.45) : withAlpha(BONE, 0.22);
      ctx.lineWidth = 1;
      const off = pass === 0 ? 0 : 1;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const yy = y0 + TILE_H * (0.3 + i * 0.2) + off;
        ctx.moveTo(x0 + 1.4, yy);
        ctx.lineTo(x0 + 4.2, yy);
        ctx.moveTo(x0 + TILE_W - 4.2, yy);
        ctx.lineTo(x0 + TILE_W - 1.4, yy);
      }
      ctx.stroke();
    }

    // --- recessed channel the glyph is cut into.
    const inset = 3.4;
    const iw = TILE_W - inset * 2;
    const ih = TILE_H - inset * 2;
    roundedRect(ctx, x0 + inset, y0 + inset, iw, ih, r - 2);
    ctx.fillStyle = withAlpha("#1a1512", 0.86);
    ctx.fill();
    // Inner shadow down the top wall of the recess.
    const recess = ctx.createLinearGradient(0, y0 + inset, 0, y0 + inset + ih * 0.6);
    recess.addColorStop(0, withAlpha(INK, 0.75));
    recess.addColorStop(1, withAlpha(INK, 0));
    ctx.fillStyle = recess;
    ctx.fill();
    // Bright lip on the lower wall, which faces up toward the key.
    ctx.strokeStyle = withAlpha(ALUMINIUM, 0.5);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x0 + inset + 2, y0 + inset + ih - 0.4);
    ctx.lineTo(x0 + inset + iw - 2, y0 + inset + ih - 0.4);
    ctx.stroke();

    // --- engraved glyph: a dark groove with a highlight on its far wall.
    ctx.font = FONT_TILE;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = BONE_30;
    ctx.fillText(letter, cx + 0.7, cy + 1.4);
    ctx.fillStyle = "#141010";
    ctx.fillText(letter, cx, cy + 0.6);

    // --- rivets on the diagonal.
    ctx.fillStyle = withAlpha(BONE, 0.4);
    ctx.beginPath();
    ctx.arc(x0 + 3.1, y0 + 3.4, 0.95, 0, TAU);
    ctx.arc(x0 + TILE_W - 3.1, y0 + TILE_H - 3.4, 0.95, 0, TAU);
    ctx.fill();
    ctx.fillStyle = INK_55;
    ctx.beginPath();
    ctx.arc(x0 + 3.1, y0 + 3.9, 0.6, 0, TAU);
    ctx.arc(x0 + TILE_W - 3.1, y0 + TILE_H - 2.9, 0.6, 0, TAU);
    ctx.fill();

    ctx.restore();
    return surface;
  }

  function bakeTileHot(letter: string, k: number): Surface | null {
    const surface = createSurface(TILE_CELL, TILE_CELL, k);
    if (!surface) return null;
    const ctx = surface.ctx;
    const cx = TILE_CELL * 0.5;
    const cy = TILE_CELL * 0.5;
    const y0 = cy - TILE_H * 0.5;

    // Broad heat bloom around the channel, taken from the bakery's glow sprite
    // so the falloff matches every other light element in the game.
    const halo = tinted("glow", HEMI, 0);
    if (halo) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.55;
      const d = TILE_CELL * 0.84;
      ctx.drawImage(halo, cx - d * 0.5, cy - d * 0.5, d, d);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    ctx.font = FONT_TILE;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalCompositeOperation = "lighter";
    // Three concentric strikes stand in for a blur: the widest is deep ember,
    // the middle is hemi, and the core is bone-white and small enough to
    // survive the bloom threshold as a genuine highlight rather than a wash.
    for (let pass = 0; pass < 2; pass++) {
      ctx.save();
      ctx.translate(cx, cy + 0.6);
      ctx.globalAlpha = pass === 0 ? 0.5 : 0.75;
      ctx.fillStyle = pass === 0 ? HEMI_EMBER : HEMI;
      const s = pass === 0 ? 1.3 : 1.12;
      ctx.scale(s, s);
      ctx.fillText(letter, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = HOT_WHITE;
    ctx.fillText(letter, cx, cy + 0.6);

    // Hot rim on the leading edge: the face meeting the air is the one glowing.
    const rim = ctx.createLinearGradient(0, y0 - 1, 0, y0 + 5);
    rim.addColorStop(0, withAlpha(HOT_WHITE, 0.9));
    rim.addColorStop(1, withAlpha(HEMI, 0));
    ctx.fillStyle = rim;
    ctx.fillRect(cx - TILE_W * 0.42, y0 - 1, TILE_W * 0.84, 6);

    ctx.globalCompositeOperation = "source-over";
    return surface;
  }

  function letterTile(letter: string): Tile | null {
    const key = letter + "|" + tier.bakeK;
    const hit = tileCache.get(key);
    if (hit !== undefined) return hit;
    if (tileCache.size >= 16) tileCache.clear();
    const body = bakeTileBody(letter, tier.bakeK);
    const hot = bakeTileHot(letter, tier.bakeK);
    const made = body && hot ? { body: body.canvas, hot: hot.canvas } : null;
    tileCache.set(key, made);
    return made;
  }

  /* ---- camera ---------------------------------------------------- *
   * Reduced motion keeps the *direction* of every reaction and removes the
   * shake: the frame still leans into an impact, it simply does not rattle.
   */

  function punch(dx: number, dy: number, trauma: number, zoom: number): void {
    if (reduced) {
      camera.addImpulse(dx * 0.25, dy * 0.25);
      camera.addZoom(zoom * 0.2);
      return;
    }
    camera.addImpulse(dx, dy);
    camera.addTrauma(trauma);
    camera.addZoom(zoom);
  }

  /**
   * Flash intensity gate. Reduced motion forbids flashing above 3 Hz, so a
   * flash arriving inside a 340 ms window is dimmed rather than suppressed —
   * the event stays readable, and the strobe never happens.
   */
  function flashPeak(base: number): number {
    if (!reduced) {
      lastBigFlash = uiTime;
      return base;
    }
    if (uiTime - lastBigFlash < 0.34) return Math.min(base, 0.26);
    lastBigFlash = uiTime;
    return Math.min(base, 0.62);
  }

  /* ---- impact direction ------------------------------------------ *
   * Measured from the projectile that actually caused the event: `drawShots`
   * keeps each shot's last position and unit velocity, and retired shots linger
   * for a moment so the impact frame can still find the one that landed.
   */

  const dir = { x: 0, y: -1, letter: "" };

  function resolveDirection(x: number, y: number): void {
    let best: Trail | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < trails.length; i++) {
      const t = trails[i];
      if (!t.started) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 160 * 160) continue;
      // Prefer a *recently* retired shot over a live one at the same distance:
      // the shot that just vanished is almost always the one that landed.
      const score = d2 + t.orphanAge * 4000 + (t.orphan ? 0 : 9000);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best) {
      dir.x = best.dx;
      dir.y = best.dy;
      dir.letter = best.letter;
      return;
    }
    // Fallback: shots come from the host desk, which sits at the bottom centre.
    const fx = x - viewW * 0.5;
    const fy = y - (floorY + 22);
    const len = Math.sqrt(fx * fx + fy * fy);
    dir.x = len > 1e-3 ? fx / len : 0;
    dir.y = len > 1e-3 ? fy / len : -1;
    dir.letter = "";
  }

  /* ---- spawn helpers --------------------------------------------- */

  /**
   * `bodyCore` is how much untinted white is baked into the *skirt*. A small,
   * genuinely hot detonation wants a lot of it — that white pixel is what the
   * bloom threshold sees. A wide warm flare wants almost none: baking a white
   * core into a 400 px skirt is exactly how an event turns into an achromatic
   * wash and takes the set, the callers and the wordmark with it.
   */
  function spawnFlash(
    x: number, y: number, size: number, life: number, peak: number,
    color: string, core: string, bar: number, rot: number, style: number,
    bodyCore = 0.9,
  ): void {
    const f = take(flashes);
    f.x = x;
    f.y = y;
    f.size = size;
    f.life = life;
    f.maxLife = life;
    f.peak = peak;
    f.color = color;
    f.bar = bar;
    f.rot = rot;
    f.style = style;
    // Tints resolve once, here — never inside the draw loop.
    if (style === FL_ROUND) {
      f.art = tinted("glow", color, bodyCore);
      f.coreArt = tinted("glow", core, 0.95);
      f.barArt = bar > 0 ? tinted("streak", core, 0.6) : null;
    } else {
      f.art = null;
      f.coreArt = null;
      f.barArt = null;
    }
  }

  function spawnRing(
    x: number, y: number, r0: number, r1: number, life: number, color: string,
    alpha: number, style: number, squash: number, rot: number, width: number, bands: number,
  ): void {
    const r = take(rings);
    r.x = x;
    r.y = y;
    r.r0 = r0;
    r.r1 = r1;
    r.life = life;
    r.maxLife = life;
    r.color = color;
    r.alpha = alpha;
    r.style = style;
    r.squash = squash;
    r.rot = rot;
    r.width = width;
    r.bands = bands;
    r.art =
      style === RS_DENY || style === RS_FRONT
        ? null
        : tinted("ring", color, style === RS_SWEEP ? 0.35 : 0.55);
  }

  /* ---- popups ----------------------------------------------------- *
   * Motion design: an outBack rise (overshoot up, settle back), an outBack
   * scale pop on a shorter clock so the type snaps before it travels, a slow
   * continued drift, and an outQuart fade. Three passes give it a shadow that
   * reads over a white caller card and over the black floor alike.
   */

  function popup(x: number, y: number, text: string, color?: string, size?: number): void {
    const px = Math.round(clamp(size ?? 18, 8, 96));
    const p = take(popups);
    p.text = text;
    p.size = px;
    p.font = sized(FONT_SLAB, px);
    p.color = color ?? BONE;
    p.life = clamp(0.85 + px * 0.022, 0.85, 1.9);
    p.maxLife = p.life;
    p.rise = 26 + px * 0.95;
    p.seed = fxRng.range(0, TAU);
    p.driftX = fxRng.range(-1, 1) * (6 + px * 0.2);
    // The broadcast slab averages ~0.62 em of advance; half of that is the
    // half-width the stacking solver needs, and it costs no measureText.
    p.halfWidth = Math.max(8, text.length * px * 0.31);

    // A popup *travels*: clamping only its origin lets a high one drive its own
    // cap straight through the top of the frame, so the ceiling has to account
    // for the whole rise. Clamp first, then resolve collisions — the other way
    // round, every popup near the top gets clamped onto the same line and the
    // stacking solver's work is thrown away.
    const ceiling = px * 0.9 + 6 + p.rise * 1.35;
    const bottom = Math.max(ceiling, viewH - 12);
    const row = px * 1.25;
    let ty = clamp(y, ceiling, bottom);
    // Stack upward where there is room above, downward when already at the cap.
    const step = ty - row < ceiling ? row : -row;
    for (let attempt = 0; attempt < 6; attempt++) {
      let clash = false;
      for (let i = 0; i < popups.count; i++) {
        const other = popups.items[i];
        if (other === p) continue;
        if (Math.abs(other.y - ty) > row) continue;
        if (Math.abs(other.x - x) > other.halfWidth + p.halfWidth) continue;
        clash = true;
        break;
      }
      if (!clash) break;
      ty = clamp(ty + step, ceiling, bottom);
    }
    const margin = p.halfWidth + 10;
    p.x = clamp(x, margin, Math.max(margin, viewW - margin));
    p.y = ty;
  }

  /* ---- events ------------------------------------------------------ */

  function onHit(rawX: number, rawY: number, color: string, letter: string): void {
    resolveDirection(rawX, rawY);
    const nx = dir.x;
    const ny = dir.y;
    // Land the whole stack on the card, not in the air beneath it.
    const x = rawX + nx * CONTACT_BIAS;
    const y = rawY + ny * CONTACT_BIAS;
    const back = Math.atan2(-ny, -nx);
    const along = Math.atan2(ny, nx);
    // Warm the card's tint toward hemi: a card colour is a pastel, and pastel
    // sparks read as confetti. The hot end of every ramp stays bone-white.
    const hotTint = mixColor(color, HEMI, 0.5, "oklab");

    // 1 — white-hot flash. Small, genuinely white, gone in ~80 ms. The bloom
    // pass is what makes it big; painting it big here would just be a smudge.
    spawnFlash(x, y, 54, 0.085, flashPeak(1), HOT_WHITE, HOT_WHITE, 0.85, along, FL_ROUND);
    // A wider, cooler flare underneath carries the colour of the card it hit.
    spawnFlash(x, y, 96, 0.16, flashPeak(0.55), hotTint, HOT, 0, along, FL_ROUND);

    // 2 — sparks. The bulk back-scatters along the normal; a thin jet punches
    // through. Emitter velocity is the shot's, so the spray inherits its drift.
    const sp = NOMINAL_SPEED;
    particles.emit("impact-spark", {
      x, y, count: 20, angle: back, spread: 2.3, speed: 360, speedVariance: 0.62,
      color: hotTint, vx: nx * sp * 0.4, vy: ny * sp * 0.4,
    });
    particles.emit("impact-spark", {
      x: x + nx * 5, y: y + ny * 5, count: 6, angle: along, spread: 0.55, speed: 560,
      color: HOT_DEEP, vx: nx * sp * 0.5, vy: ny * sp * 0.5, life: 0.26,
    });

    // 3 — shock ring, squashed across the normal because the front spreads over
    // the surface it struck rather than through it.
    spawnRing(x, y, 10, 78, 0.4, hotTint, 0.95, RS_SHOCK, 0.62, along, 2, 1);
    particles.emit("impact-ring", { x, y, color: hotTint, scale: 0.9 });

    // 4 — glyph shrapnel: the ammunition that just shattered.
    particles.emit("letter-debris", {
      x, y, count: 9, angle: back, spread: 2.6, speed: 230, color: shade(color, -0.12),
      vx: nx * sp * 0.25, vy: ny * sp * 0.25,
    });

    if (tier.garnish) {
      particles.emit("smoke-puff", { x, y, count: 2, speed: 44, scale: 0.55, life: 0.9 });
      particles.emit("glass-shard", {
        x, y, count: 5, angle: back, spread: 2.1, speed: 250, vx: nx * sp * 0.2, vy: ny * sp * 0.2,
      });
    }

    // 5 — camera: a punch *along* the shot, small trauma, a hair of push-in.
    punch(nx * 5.5, ny * 5.5, 0.16, 0.012);

    // 6 — popup: the letter that just locked, small and hot.
    popup(x + nx * 12, y + ny * 14, letter, hotTint, 17);
  }

  function onReject(rawX: number, rawY: number, requiredLetter: string): void {
    resolveDirection(rawX, rawY);
    const nx = dir.x;
    const ny = dir.y;
    // Same inflated hit box, same correction: a rejection happens on the card.
    const x = rawX + nx * CONTACT_BIAS;
    const y = rawY + ny * CONTACT_BIAS;
    const along = Math.atan2(ny, nx);
    const back = along + Math.PI;
    // The letter that bounces is the one that was fired, whenever we can
    // measure it; the required letter is only the fallback.
    const thrown = dir.letter.length > 0 ? dir.letter : requiredLetter;

    // 1 — hard stop. A flat deflection plate square to the incoming shot, dull
    // aluminium rather than hot, over in ~70 ms. Never round, never orange.
    spawnFlash(x - nx * 3, y - ny * 3, 46, 0.07, flashPeak(0.72), BONE, BONE, 0, along + Math.PI * 0.5, FL_PLATE);

    // 2 — a *contracting* ring. Every other ring in the game expands; this one
    // collapses, which is the clearest possible "energy rejected" tell.
    spawnRing(x, y, 44, 12, 0.3, DENY_LINE, 0.85, RS_DENY, 1, 0, 2.2, 1);

    // 3 — dull dust, not sparks: no additive blending anywhere in a rejection.
    particles.emit("dust-kick", {
      x, y, count: 5, angle: back, spread: 1.9, speed: 105, scale: 0.55, life: 0.72,
      color: WARM_GREY, color2: DUST, additive: false, behind: true,
    });
    particles.emit("smoke-puff", { x, y, count: 2, speed: 38, scale: 0.42, life: 0.7 });

    // 4 — bounce-back ghost: the rejected tile tumbling back out of frame.
    const g = take(ghosts);
    g.x = x;
    g.y = y;
    g.vx = -nx * 190 + fxRng.range(-40, 40);
    g.vy = -ny * 190 - 60;
    g.rot = fxRng.range(-0.3, 0.3);
    g.spin = fxRng.range(-7, 7);
    g.size = 30;
    g.letter = thrown;
    g.font = sized(FONT_SLAB, 30);
    g.life = 0.62;
    g.maxLife = g.life;

    // 5 — broadcast error tick naming the letter the card actually wants.
    const t = take(ticks);
    t.x = clamp(x, 74, Math.max(74, viewW - 74));
    t.y = clamp(y - 40, 40, Math.max(40, viewH - 40));
    t.letter = requiredLetter;
    t.font = sized(FONT_SLAB, 22);
    t.life = 1.05;
    t.maxLife = t.life;

    // 6 — the camera recoils *away* from the card: the inverse of a hit.
    punch(-nx * 4.5, -ny * 4.5, 0.1, -0.01);
  }

  function onAnswer(x: number, y: number, color: string, value: number, combo: number): void {
    // x9 is ZEN MODE, the top tier the game recognises.
    const power = clamp01((Math.max(1, combo) - 1) / 8);
    // Push well past the card's own pastel: at 0.42 a bone-tinted caller made
    // an achromatic flare, which is a white-out with extra steps.
    const hotTint = mixColor(color, HEMI, 0.66, "oklab");

    // 1 — core burst. Three flashes on three clocks, because an answer has to
    // out-measure a letter hit on the first frame and *keep* out-measuring it:
    // a tiny white detonation over in three frames, a broad warm bloom that
    // holds, and a slow halo underneath that scales hard with the chain. A x9
    // answer is a different object from a x1 answer, not the same one louder.
    spawnFlash(x, y, 58 + 52 * power, 0.08, flashPeak(1), HOT_WHITE, HOT_WHITE, 1.2, 0, FL_ROUND);
    spawnFlash(x, y, 150 + 90 * power, 0.3 + 0.2 * power, flashPeak(0.6 + 0.1 * power), hotTint, HOT, 0.55, 0, FL_ROUND, 0.28);
    spawnFlash(x, y, 235 + 105 * power, 0.44 + 0.3 * power, flashPeak(0.18 + 0.08 * power), hotTint, HOT_DEEP, 0, 0, FL_ROUND, 0.1);

    // 2 — wide rings, staggered so the front reads as a pressure pulse train
    // rather than as one expanding circle.
    const ringCount = 2 + Math.round(power * 2);
    for (let i = 0; i < ringCount; i++) {
      spawnRing(
        x, y, 14 + i * 10, 190 + 210 * power + i * 52, 0.5 + 0.26 * power + i * 0.07,
        hotTint, 0.92 - i * 0.19, RS_WIDE, 1, 0, 2.6 + power * 2.2, 1,
      );
    }

    // 3 — the burst proper, plus paper. `answer-burst` is already a five-layer
    // composite, so the count scales the whole thing, not one sub-emitter.
    // `answer-burst` is a five-layer additive composite: pushed past about
    // thirty it stops reading as a burst and becomes a white disc, which is the
    // POP OFF failure mode arriving one tier early. It escalates by *reach*,
    // not by filling more of the frame with light.
    particles.emit("answer-burst", {
      x, y, count: Math.round(17 + 13 * power), color: hotTint,
      scale: 0.85 + 0.3 * power, speed: 380 + 240 * power,
    });
    particles.emit("confetti", {
      x, y, count: Math.round(16 + 18 * power), angle: -Math.PI / 2, spread: 2.4,
      speed: 270 + 200 * power, color,
    });
    particles.emit("paper-shred", {
      x, y, count: Math.round(10 + 16 * power), speed: 200 + 140 * power, color: BONE,
    });
    particles.emit("ember", {
      x, y, count: Math.round(7 + 11 * power), speed: 95 + 90 * power, scale: 1 + 0.5 * power,
    });
    if (tier.garnish) {
      particles.emit("glass-shard", {
        x, y, count: Math.round(6 + 10 * power), speed: 300 + 180 * power, spread: TAU,
      });
    }

    // 4 — lens flare. Iris ghosts appear on the line joining the source and the
    // optical axis; the element below places them there for real.
    if (tier.flare) {
      const fl = take(flares);
      fl.x = x;
      fl.y = y;
      fl.strength = 0.55 + 0.45 * power;
      fl.life = 0.46 + 0.3 * power;
      fl.maxLife = fl.life;
    }

    // 5 — score. Size and travel scale with the combo, so a x9 popup is a
    // different object from a x1 popup rather than the same one held longer.
    const size = 24 + 20 * power;
    popup(x, y - 16, "+" + Math.round(value), hotTint, size);
    if (combo > 1) popup(x, y - 16 - size * 1.15, "×" + combo, HOT_DEEP, 15 + 9 * power);

    // 6 — milestone flourish, on the same 3-step ladder the game scores on.
    if (combo >= 3 && combo % 3 === 0) comboFlourish(x, y, combo, power, hotTint);

    punch(0, -6 - 9 * power, 0.18 + 0.22 * power, 0.02 + 0.05 * power);
  }

  /** Tier milestone: a second ring pair, audience flashes and a centred slab. */
  function comboFlourish(x: number, y: number, combo: number, power: number, tint: string): void {
    spawnRing(x, y, 30, 260 + 180 * power, 0.72, HOT_DEEP, 0.7, RS_WIDE, 1, 0, 1.6, 2);
    spawnFlash(x, y, 190 + 100 * power, 0.22, flashPeak(0.3), tint, HOT, 0, 0, FL_ROUND, 0.2);
    // The audience reacts: camera flashes ripple through the stands behind.
    particles.emit("crowd-flash", { x: viewW * 0.5, y: viewH * 0.22, count: 1, scale: 1.4 });
    particles.emit("crowd-flash", {
      x: viewW * 0.5 + fxRng.range(-260, 260), y: viewH * 0.18, count: 1, scale: 1.2,
    });

    const c = take(callouts);
    c.title = patienceTier(combo);
    c.sub = "×" + combo + " PATIENCE CHAIN";
    c.x = viewW * 0.5;
    c.y = viewH * 0.32;
    c.size = 34 + 12 * power;
    c.power = power;
    c.style = CO_TIER;
    c.titleFont = sized(FONT_SLAB, c.size);
    c.measured = false;
    c.rawWidth = 0;
    c.life = 1.25;
    c.maxLife = c.life;
  }

  /**
   * A caller reached the floor.
   *
   * This is the only beat in the game the player is meant to *dread*, so it is
   * authored as the heaviest event on the board and the only one with its own
   * damage language: a wide floor detonation, a debris field that scatters
   * across a third of the stage, two pressure fronts that visibly travel, a
   * dark surge that closes in from the frame edges, and a planted broadcast
   * failure plate. Nothing here is a reward colour — the light is hemi pushed
   * hot, the debris is dead aluminium, and the frame goes *darker* at its
   * edges while it goes brighter at the floor.
   */
  function onLand(x: number, y: number): void {
    const gy = Math.max(y, floorY - 6);
    const wide = Math.min(viewW * 0.36, 340);

    // 1 — dust. Two heavy jets along the floor, a rising column, and a second
    // pair further out so the cloud has a real footprint rather than a puff.
    particles.emit("dust-kick", { x, y: gy, count: 14, angle: 0, spread: 0.7, speed: 300, scale: 1.55 });
    particles.emit("dust-kick", { x, y: gy, count: 14, angle: Math.PI, spread: 0.7, speed: 300, scale: 1.55 });
    particles.emit("dust-kick", { x, y: gy - 4, count: 8, angle: -Math.PI / 2, spread: 1.6, speed: 190, scale: 1.2, life: 1.3 });
    particles.emit("smoke-puff", { x, y: gy - 10, count: 7, speed: 96, scale: 1.7, life: 1.8 });

    // 2 — debris that bounces. Both presets restitute off the fx floor line.
    particles.emit("letter-debris", {
      x, y: gy - 10, count: 20, angle: -Math.PI / 2, spread: 3, speed: 400, color: ALUMINIUM,
    });
    particles.emit("paper-shred", { x, y: gy - 14, count: 12, speed: 300, color: WARM_GREY });
    if (tier.garnish) {
      particles.emit("glass-shard", { x, y: gy - 12, count: 18, angle: -Math.PI / 2, spread: 2.8, speed: 430 });
    }
    particles.emit("impact-spark", { x, y: gy, count: 22, angle: -Math.PI / 2, spread: 2.9, speed: 430, color: HEMI_HOT });

    // 3 — two pressure fronts travelling outward along the stage line.
    for (let s = -1; s <= 1; s += 2) {
      const w = take(waves);
      w.x = x;
      w.y = floorY;
      w.dir = s;
      w.dist = 0;
      w.speed = 980;
      w.strength = 1;
      w.dust = 0;
      w.seed = fxRng.range(0, 100);
      w.life = 0.95;
      w.maxLife = w.life;
    }

    // 4 — the detonation on the deck. A hard white-hot scuff exactly where the
    // panel struck (metal on a studio floor really does spark), inside a wide,
    // low, saturated wash that is never allowed to go white.
    spawnFlash(x, gy, 86, 0.055, flashPeak(0.95), HOT_DEEP, HOT_WHITE, 1.1, 0, FL_ROUND);
    spawnFlash(x, gy, 210, 0.34, flashPeak(1), HEMI_HOT, HOT_DEEP, 1.1, 0, FL_ROUND, 0.75);
    spawnFlash(x, gy, wide, 0.46, flashPeak(0.95), HEMI_HOT, HEMI, 0.4, 0, FL_ROUND, 0.5);
    spawnFlash(x, gy, wide * 2.1, 0.82, flashPeak(0.55), HEMI_EMBER, HEMI, 0, 0, FL_ROUND, 0.25);
    spawnRing(x, gy, 16, 190, 0.44, HEMI_HOT, 0.92, RS_SHOCK, 0.26, 0, 3.2, 1);
    spawnRing(x, gy, 40, 330, 0.66, HEMI, 0.6, RS_SHOCK, 0.2, 0, 2.2, 2);

    // 5 — video static across the frame. The preset scatters itself, and
    // reduced motion drops its per-frame jitter inside the particle system.
    particles.emit("screen-static", { x: viewW * 0.5, y: viewH * 0.5, count: 44 });

    // 6 — the damage surge: the frame edges close in and take a hemi fringe.
    // This is the graphic that makes the beat read as *bad* rather than merely
    // large, and it costs one blit of a sprite baked at first use.
    failLife = reduced ? 0.8 : 0.6;
    failMax = failLife;

    // 7 — the hardest camera hit in the game: down, hard, with a pull-back.
    punch(0, 15, 0.62, -0.06);

    // 8 — the failure plate. Planted on the stage line over the impact, on a
    // grid, with a rule and an underlay: broadcast furniture, not floating type.
    const c = take(callouts);
    c.title = "DROPPED";
    c.sub = "QUESTION RETURNED TO THE BACKLOG";
    // Anchored to the caller that fell — a failure plate parked dead centre
    // every time stops being about the thing that happened — but pulled a third
    // of the way back toward the frame so it never hugs an edge.
    c.x = lerp(x, viewW * 0.5, 0.34);
    // Clear of both the stage line and the chatter ticker that runs above it:
    // the plate is planted furniture and must never overprint another surface.
    c.y = floorY - 138;
    c.size = 30;
    c.power = 1;
    c.style = CO_FAIL;
    c.titleFont = sized(FONT_SLAB, 30);
    c.measured = false;
    c.rawWidth = 0;
    c.life = 1.75;
    c.maxLife = c.life;
  }

  /**
   * POP OFF — the ultimate.
   *
   * Authored as a *detonation*, not a fade to white: an origin at the desk's
   * sight line, a front with a struck leading edge and a dark compression band
   * ahead of it that visibly crosses the frame, every cleared caller erupting
   * as the front reaches it, and real debris leaving the field. The full-frame
   * veil that used to do all the work is now a shaped, warm, low lift — enough
   * to put the bloom pass over threshold, nowhere near enough to erase the set.
   */
  function onPopOff(cleared: number): void {
    // The callout reports the true count; only the number of *eruption points*
    // is capped, so an absurd clear still reads honestly in the typography.
    const total = Math.max(0, Math.round(cleared));
    const n = Math.min(total, MAX_ERUPT);
    const cx = viewW * 0.5;
    // The blast comes off the host's rig, so it starts low and travels up the
    // field. Keeping the origin off frame centre is also what stops it sitting
    // on top of the wordmark.
    const cy = viewH * 0.62;
    const maxR = Math.hypot(Math.max(cx, viewW - cx), Math.max(cy, viewH - cy));
    // The front crosses the whole frame in a beat you can actually watch.
    const sweepLife = 0.95;
    const sweepSpeed = maxR / (sweepLife * 0.86);

    // The front: a dark compression band with a struck edge riding it, plus a
    // softer luminous wake behind. Three elements on one radius, which is what
    // gives a sweep structure instead of a wash.
    spawnRing(cx, cy, 24, maxR * 1.12, sweepLife, HOT_WHITE, 1, RS_FRONT, 1, 0, 9, 1);
    spawnRing(cx, cy, 20, maxR * 1.04, sweepLife * 0.92, HOT_DEEP, 0.72, RS_SWEEP, 1, 0, 5, tier.sweepBands);
    spawnRing(cx, cy, 16, maxR * 0.7, sweepLife * 0.7, HEMI, 0.42, RS_SWEEP, 1, 0, 4, 2);
    spawnFlash(cx, cy, 210, 0.12, flashPeak(0.8), HOT, HOT_WHITE, 1.5, 0, FL_ROUND, 0.5);

    // Ignition debris straight off the rig, so the front has matter in it.
    particles.emit("paper-shred", { x: cx, y: cy, count: 26, angle: -Math.PI / 2, spread: 2.9, speed: 620, color: BONE });
    particles.emit("letter-debris", { x: cx, y: cy, count: 22, angle: -Math.PI / 2, spread: 3, speed: 560, color: ALUMINIUM });
    if (tier.garnish) {
      particles.emit("glass-shard", { x: cx, y: cy, count: 20, angle: -Math.PI / 2, spread: 3, speed: 640 });
    }

    // Shaped bloom moment. Reduced motion gets a slower, much gentler ramp so
    // the frame lifts rather than strobes.
    veilPeak = reduced ? 0.12 : 0.24;
    veilMax = reduced ? 0.85 : 0.62;
    veilLife = veilMax;

    // Eruption points. The API reports only how many cards cleared, not where
    // they were, so the points are laid out on a golden-angle spiral across the
    // play field: even coverage, no visible grid, deterministic from the Rng.
    const fieldY0 = 80;
    const fieldY1 = Math.max(fieldY0 + 40, floorY - 70);
    const fieldCy = (fieldY0 + fieldY1) * 0.5;
    const rx = viewW * 0.42;
    const ry = (fieldY1 - fieldY0) * 0.5;
    eruptCount = 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / Math.max(1, n);
      // 2.399963 rad is the golden angle: successive points never line up.
      const a = i * 2.399963 + fxRng.range(0, 0.6);
      const rr = Math.sqrt(t);
      const ex = cx + Math.cos(a) * rr * rx * fxRng.range(0.82, 1.06);
      const ey = fieldCy + Math.sin(a) * rr * ry * fxRng.range(0.82, 1.06);
      const e = erupts[eruptCount++];
      e.x = clamp(ex, 60, Math.max(60, viewW - 60));
      e.y = clamp(ey, fieldY0, fieldY1);
      // Stagger by distance from centre: each point fires as the front arrives.
      e.delay = Math.sqrt((e.x - cx) * (e.x - cx) + (e.y - cy) * (e.y - cy)) / sweepSpeed;
      e.size = fxRng.range(46, 78);
      e.color = fxRng.pick(eruptTints);
      e.used = false;
    }

    if (tier.flare) {
      const fl = take(flares);
      fl.x = cx;
      fl.y = cy - viewH * 0.12;
      fl.strength = 1;
      fl.life = 0.8;
      fl.maxLife = fl.life;
    }

    const c = take(callouts);
    c.title = "POP OFF";
    c.sub = total + (total === 1 ? " QUESTION MOVED TO NEXT WEEK" : " QUESTIONS MOVED TO NEXT WEEK");
    c.x = cx;
    // Deliberately clear of the detonation origin at 0.62 H. A wordmark sharing
    // a centre with a flash loses its middle letters to the flash, every time.
    c.y = viewH * 0.2;
    c.size = 76;
    c.power = 1;
    c.style = CO_TIER;
    c.titleFont = sized(FONT_SLAB, 76);
    c.measured = false;
    c.rawWidth = 0;
    c.life = 2.3;
    c.maxLife = c.life;

    punch(0, -7, 0.5, 0.09);
  }

  /** One clear point going up as the pop-off front reaches it. */
  function erupt(e: Erupt): void {
    // Hard and small rather than broad and soft: twenty of these have to stay
    // twenty separate detonations instead of merging into one field of light.
    spawnFlash(e.x, e.y, e.size * 0.66, 0.055, flashPeak(0.95), HOT_WHITE, HOT_WHITE, 0.9, 0, FL_ROUND);
    spawnFlash(e.x, e.y, e.size * 1.7, 0.24, flashPeak(0.52), e.color, HOT, 0, 0, FL_ROUND, 0.25);
    spawnRing(e.x, e.y, 8, e.size * 2.6, 0.42, e.color, 0.95, RS_SHOCK, 1, 0, 2.2, 1);
    particles.emit("answer-burst", { x: e.x, y: e.y, count: 16, color: e.color, scale: 0.8 });
    particles.emit("confetti", { x: e.x, y: e.y, count: 14, angle: -Math.PI / 2, spread: 2.6, speed: 320 });
    // Real matter leaving each card, not just light.
    particles.emit("letter-debris", { x: e.x, y: e.y, count: 8, spread: TAU, speed: 330, color: ALUMINIUM });
    if (tier.garnish) {
      particles.emit("paper-shred", { x: e.x, y: e.y, count: 8 });
      particles.emit("glass-shard", { x: e.x, y: e.y, count: 7, spread: TAU, speed: 380 });
    }
    // Each eruption nudges the rig, so twenty of them read as a sustained
    // rumble rather than as one big shove.
    punch(fxRng.range(-2.4, 2.4), -2.2, 0.09, 0.008);
  }

  /* ---- update ------------------------------------------------------ */

  function update(scene: SceneContext): void {
    quality = scene.quality;
    tier = TIERS[scene.quality] ?? TIERS.high;
    reduced = scene.reducedMotion;
    viewW = scene.width > 0 ? scene.width : GAME_WIDTH;
    viewH = scene.height > 0 ? scene.height : GAME_HEIGHT;
    floorY = scene.stageY > 0 ? scene.stageY : STAGE_Y;
    intensity = clamp01(scene.intensity);
    // A new scene restarts rawTime, which would leave the cadence limiter with
    // a timestamp in the future and dim every flash until it caught up.
    if (scene.rawTime < uiTime) lastBigFlash = scene.rawTime - 10;
    uiTime = scene.rawTime;
    frame++;

    // Bake everything the first frame can possibly need while the round is
    // still starting, so the first shot fired never pays for an atlas.
    if (!warmed) {
      warmed = true;
      ensureSprites();
      letterTile("S");
      letterTile("O");
      letterTile("N");
    }

    // World art advances on scaled time, so a hit-stop holds the impact frame;
    // typography advances on raw time, because broadcast graphics are
    // composited downstream of the camera and must never stutter.
    const dt = Math.min(scene.dt, 0.05);
    const raw = Math.min(scene.rawDt, 0.05);

    // --- trails. Orphan anything that missed a frame, then age it out.
    for (let i = trails.length - 1; i >= 0; i--) {
      const t = trails[i];
      t.ribbon.update(dt);
      if (!t.orphan && t.frame < frame - 1) {
        t.orphan = true;
        t.orphanAge = 0;
      }
      if (t.orphan) {
        t.orphanAge += dt;
        // The ribbon retires its own points; once the trail is too short to
        // draw and the impact frame has passed, the slot returns to the pool.
        if (t.ribbon.length < 2 && t.orphanAge > 0.35) {
          trailById.delete(t.id);
          trails[i] = trails[trails.length - 1];
          trails.pop();
        }
      }
    }

    // --- travelling floor fronts.
    for (let i = 0; i < waves.count; i++) {
      const w = waves.items[i];
      w.dist += w.speed * dt;
      w.speed *= 1 / (1 + 1.5 * dt); // the front loses energy as it spreads
      // A real pressure front is not smooth: modulate its height on the noise
      // field so the two sides of one impact never look mirrored.
      w.strength = 0.78 + 0.22 * (0.5 + 0.5 * noise.n2(w.dist * 0.012, w.seed));
      w.dust += w.speed * dt;
      if (w.dust > 96 && quality !== "low") {
        w.dust = 0;
        particles.emit("dust-kick", {
          x: w.x + w.dir * w.dist, y: w.y, count: 2, angle: w.dir > 0 ? 0 : Math.PI,
          spread: 0.7, speed: 120, scale: 0.8, life: 0.9,
        });
      }
    }

    // --- ghosts: real ballistics, no bounce; they leave frame and fade.
    for (let i = 0; i < ghosts.count; i++) {
      const g = ghosts.items[i];
      g.vy += 1150 * dt;
      g.vx *= 1 / (1 + 1.1 * dt);
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.rot += g.spin * dt;
      g.spin *= 1 / (1 + 1.4 * dt);
    }

    // --- pop-off eruption schedule.
    if (eruptCount > 0) {
      let pending = 0;
      for (let i = 0; i < eruptCount; i++) {
        const e = erupts[i];
        if (e.used) continue;
        e.delay -= dt;
        if (e.delay > 0) {
          pending++;
          continue;
        }
        e.used = true;
        erupt(e);
      }
      if (pending === 0) eruptCount = 0;
    }

    if (veilLife > 0) veilLife = Math.max(0, veilLife - raw);
    if (failLife > 0) failLife = Math.max(0, failLife - raw);

    sweep(flashes, dt);
    sweep(rings, dt);
    sweep(waves, dt);
    sweep(ghosts, dt);
    sweep(flares, dt);
    sweep(ticks, raw);
    sweep(popups, raw);
    sweep(callouts, raw);
  }

  /* ---- shots -------------------------------------------------------- */

  function trailFor(shot: ShotView): Trail {
    const hit = trailById.get(shot.id);
    if (hit) return hit;

    let t: Trail;
    if (trails.length >= MAX_TRAILS) {
      // Saturated: recycle the most decayed orphan, or failing that the trail
      // that has gone unseen longest. Either way no ribbon is ever allocated
      // after warm-up.
      let best = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < trails.length; i++) {
        const cand = trails[i];
        const score = (cand.orphan ? 1000 : 0) + cand.orphanAge * 10 - cand.frame * 0.001;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      t = trails[best];
      trailById.delete(t.id);
      t.ribbon.clear();
    } else {
      t = {
        id: shot.id,
        ribbon: createRibbon(tier.ribbonPoints, { spacing: 3, maxSpacing: 15, life: 0.3 }),
        frame: 0, orphan: false, orphanAge: 0, x: shot.x, y: shot.y,
        dx: 0, dy: -1, letter: shot.letter, shed: 0, seed: 0, started: false,
        tile: null, tileK: 0,
      };
      trails.push(t);
    }

    t.id = shot.id;
    t.orphan = false;
    t.orphanAge = 0;
    t.x = shot.x;
    t.y = shot.y;
    t.letter = shot.letter;
    t.shed = 0;
    // Resolve the tile art here, once per shot, so the per-frame draw loop
    // never builds a cache key. A tier change re-resolves it on the next shot,
    // and mid-flight below.
    t.tile = letterTile(shot.letter);
    t.tileK = tier.bakeK;
    // Deterministic per-shot phase: the same shot always flickers the same way.
    t.seed = fxRng.range(0, 1000);
    t.started = false;
    trailById.set(shot.id, t);
    return t;
  }

  function drawShots(ctx: CanvasRenderingContext2D, shots: readonly ShotView[], scene: SceneContext): void {
    if (shots.length === 0) {
      drawOrphanTrails(ctx);
      return;
    }
    const s = ensureSprites();
    const time = scene.time;
    const ribbonColor = ribbonRamp[Math.min(RIBBON_STEPS - 1, Math.round(intensity * (RIBBON_STEPS - 1)))];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const t = trailFor(shot);
      t.frame = frame;

      const speed = Math.sqrt(shot.vx * shot.vx + shot.vy * shot.vy);
      const inv = speed > 1e-3 ? 1 / speed : 0;
      t.dx = speed > 1e-3 ? shot.vx * inv : 0;
      t.dy = speed > 1e-3 ? shot.vy * inv : -1;

      // Path length since the last frame drives the spark cadence, so the shed
      // rate is a function of distance travelled rather than of frame rate.
      const moved = t.started
        ? Math.sqrt((shot.x - t.x) * (shot.x - t.x) + (shot.y - t.y) * (shot.y - t.y))
        : 0;
      t.x = shot.x;
      t.y = shot.y;
      if (!t.started) {
        // A fresh shot must not trail back to wherever this slot was last used.
        t.started = true;
        t.ribbon.clear();
      }
      t.ribbon.push(shot.x, shot.y);

      if (tier.trailSparks) {
        t.shed += moved;
        if (t.shed > 46) {
          t.shed = 0;
          particles.emit("impact-spark", {
            x: shot.x - t.dx * 8, y: shot.y - t.dy * 8, count: 1, angle: Math.atan2(-t.dy, -t.dx),
            spread: 1.1, speed: 90, life: 0.22, scale: 0.62, color: HEMI,
            vx: shot.vx * 0.2, vy: shot.vy * 0.2,
          });
        }
      }

      const angle = Math.atan2(t.dy, t.dx);
      const speedT = clamp01(speed / (NOMINAL_SPEED * 1.25));
      // Velocity stretch along the travel axis, with a matching cross-axis
      // squash so the shot conserves apparent area instead of ballooning.
      const stretch = 1 + 0.42 * speedT;
      const squash = 1 / Math.sqrt(stretch);
      // Ignition: the tile leaves the mic white-hot and oversized, then settles.
      const ignite = 1 - clamp01(shot.age / 0.1);

      // --- ribbon. The engine's ribbon already lays a hot core inside the body
      // when additive, which is what makes it read as plasma rather than paint.
      t.ribbon.draw(ctx, {
        width: 13 * squash + 5 * ignite,
        color: ribbonColor,
        fade: 0.9,
        additive: true,
      });

      ctx.save();
      ctx.translate(shot.x, shot.y);

      // --- soft light halo: brightens whatever the shot passes over. World
      // oriented, additive, wide and low — a lamp, not a sprite.
      if (s.glowHemi && tier.halo) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.3 + 0.22 * ignite + 0.1 * intensity;
        const hs = 86 + 40 * ignite;
        ctx.drawImage(s.glowHemi, -hs * 0.5, -hs * 0.5, hs, hs);
        ctx.globalAlpha = 1;
      }

      ctx.rotate(angle);

      // --- leading air distortion: a warm-grey multiply lobe ahead of the nose
      // compresses what is behind it, and a thin additive bar rides the front.
      if (s.glowWarm && tier.smear) {
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = 0.34 + 0.2 * speedT;
        ctx.drawImage(s.glowWarm, 2, -13, 42, 26);
        ctx.globalAlpha = 1;
      }
      if (s.streakHot) {
        ctx.globalCompositeOperation = "lighter";
        // Compression front: a thin bar across the travel axis, at the nose.
        ctx.globalAlpha = 0.34 + 0.26 * ignite;
        ctx.drawImage(s.streakHot, 6, -17, 13, 34);
        // Core streak behind the tile — hotter and much longer than the ribbon.
        // This is the element that survives the bloom threshold.
        ctx.globalAlpha = 0.6 + 0.3 * ignite;
        const tail = 54 + 46 * speedT;
        ctx.drawImage(s.streakHot, -tail - 4, -7 * squash, tail, 14 * squash);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";

      // --- the tile. The stretch is applied in the travel frame (so the smear
      // follows the trajectory), then the tile is rotated back to a *bank* into
      // the trajectory measured from vertical rather than a full alignment: a
      // tile that points at its target reads as a dart, a tile that leans reads
      // as a thrown object.
      const bank = (angle + Math.PI * 0.5) * 0.42;
      const tileStretch = 1 + (stretch - 1) * 0.6;
      ctx.scale(tileStretch, 1 / Math.sqrt(tileStretch));
      ctx.rotate(-angle + bank);

      if (t.tileK !== tier.bakeK) {
        t.tile = letterTile(shot.letter);
        t.tileK = tier.bakeK;
      }
      const tile = t.tile;
      const cell = TILE_CELL * (1 + 0.26 * ignite);
      if (tile) {
        ctx.drawImage(tile.body, -cell * 0.5, -cell * 0.5, cell, cell);
        ctx.globalCompositeOperation = "lighter";
        // Filament flicker on band-limited noise rather than a sine: a hot
        // element under load wanders, it does not oscillate. Reduced motion
        // drops the amplitude below the perceptual threshold instead of
        // killing the element outright.
        const flick = reduced ? 0.03 : 0.2;
        const wander = noise.n2(time * 6.5 + t.seed, t.seed * 0.37);
        const pulse = 0.62 + flick * wander + 0.16 * intensity + 0.7 * ignite;
        ctx.globalAlpha = clamp01(pulse);
        ctx.drawImage(tile.hot, -cell * 0.5, -cell * 0.5, cell, cell);
        ctx.globalAlpha = 1;
      } else {
        // No canvas to bake into (server render, or a hostile host): draw the
        // glyph directly so the projectile still exists.
        ctx.fillStyle = HOT_WHITE;
        ctx.font = FONT_TILE;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(shot.letter, 0, 0);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.restore();
    }

    drawOrphanTrails(ctx);
  }

  /** Trails whose shot is gone keep decaying, so an impact never cuts a streak. */
  function drawOrphanTrails(ctx: CanvasRenderingContext2D): void {
    for (let i = 0; i < trails.length; i++) {
      const t = trails[i];
      if (!t.orphan || t.ribbon.length < 2) continue;
      const fade = clamp01(1 - t.orphanAge / 0.3);
      ctx.save();
      ctx.globalAlpha = fade;
      t.ribbon.draw(ctx, { width: 12 * fade, color: HEMI, fade: 0.95, additive: true });
      ctx.restore();
    }
  }

  /* ---- overlay effects ---------------------------------------------- */

  function drawOverlayEffects(ctx: CanvasRenderingContext2D, scene: SceneContext): void {
    if (scene.width > 0) viewW = scene.width;
    if (scene.height > 0) viewH = scene.height;
    const s = ensureSprites();

    drawWaves(ctx, s);
    drawRings(ctx);
    drawGhosts(ctx);
    drawFlashes(ctx);
    if (tier.flare) drawFlares(ctx, s);
    drawVeil(ctx, s);
    // The damage surge sits above the light and below the type: it has to be
    // able to darken a detonation, and it must never darken the callout.
    drawFailWash(ctx);
    drawTicks(ctx, scene);
    drawPopups(ctx);
    drawCallouts(ctx);
  }

  /**
   * Failure surge. A dark front closing in from the frame edges with a hemi
   * fringe just inside it — the visual opposite of every reward in the game,
   * which all *add* light from a point. Baked once, one blit per frame.
   */
  function bakeFailWash(): CanvasImageSource | null {
    const surface = createSurface(256, 256, 1);
    if (!surface) return null;
    const ctx = surface.ctx;
    // The eye of the surge stays open: the play field must remain readable while
    // the frame closes in, or the beat stops being a failure and becomes a wipe.
    const dark = ctx.createRadialGradient(128, 128, 54, 128, 128, 128);
    dark.addColorStop(0, "rgba(8,4,2,0)");
    dark.addColorStop(0.52, "rgba(9,4,2,0.09)");
    dark.addColorStop(0.78, "rgba(7,3,1,0.36)");
    dark.addColorStop(1, "rgba(3,1,1,0.8)");
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, 256, 256);
    const fringe = ctx.createRadialGradient(128, 128, 82, 128, 128, 126);
    fringe.addColorStop(0, "rgba(255,42,0,0)");
    fringe.addColorStop(0.55, "rgba(255,42,0,0.26)");
    fringe.addColorStop(1, "rgba(255,42,0,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = fringe;
    ctx.fillRect(0, 0, 256, 256);
    ctx.globalCompositeOperation = "source-over";
    return surface.canvas;
  }

  function drawFailWash(ctx: CanvasRenderingContext2D): void {
    if (failLife <= 0) return;
    if (!failBaked) {
      failBaked = true;
      failArt = bakeFailWash();
    }
    if (!failArt) return;
    const t = 1 - failLife / failMax;
    const rise = reduced ? 0.3 : 0.06;
    const level = t < rise ? ease.outQuad(t / rise) : 1 - ease.inQuad((t - rise) / (1 - rise));
    const amp = clamp01(level) * (reduced ? 0.55 : 1);
    if (amp < 0.006) return;
    // The surge *closes in*: it starts wide and contracts, which is the motion
    // of something arriving rather than of an alpha fading up.
    const k = lerp(1.44, 1.02, ease.outCubic(clamp01(t / 0.5)));
    const w = viewW * k;
    const h = viewH * k;
    ctx.save();
    ctx.globalAlpha = amp;
    ctx.drawImage(failArt, viewW * 0.5 - w * 0.5, viewH * 0.5 - h * 0.5, w, h);
    ctx.restore();
  }

  function drawWaves(ctx: CanvasRenderingContext2D, s: SpriteSet): void {
    if (waves.count === 0) return;
    ctx.save();
    for (let i = 0; i < waves.count; i++) {
      const w = waves.items[i];
      const t = 1 - w.life / w.maxLife;
      const fade = 1 - ease.inQuad(t);
      const fx = w.x + w.dir * w.dist;

      // Dust hump riding the front, behind the light so it reads as matter.
      if (s.smokeDust) {
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.34 * fade;
        const dh = (40 + w.dist * 0.05) * w.strength;
        ctx.drawImage(s.smokeDust, fx - dh * 0.9, w.y - dh * 0.75, dh * 1.8, dh);
      }
      // The band of lit floor between the impact and the front.
      if (s.streakHot) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.5 * fade;
        const span = Math.max(12, w.dist);
        ctx.drawImage(s.streakHot, w.dir > 0 ? w.x : w.x - span, w.y - 9, span, 18);
      }
      // The front itself: a compact vertical lip, the brightest thing here.
      if (s.glowFloor) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.95 * fade;
        const lh = 52 * w.strength * fade + 12;
        ctx.drawImage(s.glowFloor, fx - 15, w.y - lh * 0.72, 30, lh);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  function drawRings(ctx: CanvasRenderingContext2D): void {
    if (rings.count === 0) return;
    for (let i = 0; i < rings.count; i++) {
      const r = rings.items[i];
      const t = 1 - r.life / r.maxLife;

      if (r.style === RS_DENY) {
        // Contracting, hard-edged, achromatic. Stroked rather than sprited so
        // it stays a *line* — a rejection is a boundary, not an explosion.
        const radius = Math.max(1, lerp(r.r0, r.r1, ease.outCubic(t)));
        ctx.save();
        ctx.globalAlpha = r.alpha * (1 - ease.inQuad(t));
        ctx.strokeStyle = r.color;
        ctx.lineWidth = r.width;
        ctx.beginPath();
        ctx.arc(r.x, r.y, radius, 0, TAU);
        ctx.stroke();
        // Four heavier arcs on the diagonals: a broadcast "denied" bracket.
        ctx.lineWidth = r.width * 1.6;
        for (let k = 0; k < 4; k++) {
          const a = Math.PI * 0.25 + k * Math.PI * 0.5;
          ctx.beginPath();
          ctx.arc(r.x, r.y, radius, a - 0.2, a + 0.2);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      if (r.style === RS_FRONT) {
        // The detonation front. Three concentric strokes on one radius: a dark
        // compression band running *ahead* of the light, the struck leading
        // edge itself, and a hot inner lip. This is the element that makes the
        // sweep read as a front crossing the room rather than as a bloom.
        const k = ease.outCubic(t);
        const radius = Math.max(2, lerp(r.r0, r.r1, k));
        const fade = 1 - ease.inQuad(t);
        const width = r.width * (0.5 + 0.5 * (1 - t));
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.globalAlpha = clamp01(0.72 * fade);
        ctx.strokeStyle = INK_88;
        ctx.lineWidth = width * 1.9;
        ctx.beginPath();
        ctx.arc(0, 0, radius + width * 1.5, 0, TAU);
        ctx.stroke();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = clamp01(r.alpha * fade);
        ctx.strokeStyle = r.color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = clamp01(r.alpha * fade * 0.3);
        ctx.strokeStyle = HOT_DEEP;
        ctx.lineWidth = width * 2.6;
        ctx.beginPath();
        ctx.arc(0, 0, radius - width * 1.8, 0, TAU);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (!r.art) continue;
      // Rings decelerate: outQuart on the radius is the shape a real pressure
      // front traces as it sheds energy into the air.
      const k = r.style === RS_SWEEP ? ease.outCubic(t) : ease.outQuart(t);
      const radius = lerp(r.r0, r.r1, k);
      const fade = r.style === RS_SWEEP ? 1 - ease.inQuad(t) : (1 - t) * (1 - t);
      // The bakery's ring sprite puts its front at 0.855 of the half-size, so
      // the draw size that lands the front exactly on `radius` is this.
      const d = (radius / 0.855) * 2;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.translate(r.x, r.y);
      if (r.rot !== 0) ctx.rotate(r.rot);
      for (let b = 0; b < r.bands; b++) {
        const bd = d * (1 - b * 0.16);
        ctx.globalAlpha = clamp01(r.alpha * fade * (1 - b * 0.3));
        ctx.drawImage(r.art, -bd * 0.5, -bd * 0.5 * r.squash, bd, bd * r.squash);
      }
      ctx.restore();
    }
  }

  function drawGhosts(ctx: CanvasRenderingContext2D): void {
    if (ghosts.count === 0) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (let i = 0; i < ghosts.count; i++) {
      const g = ghosts.items[i];
      const fade = 1 - ease.inQuad(1 - g.life / g.maxLife);
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.rot);
      ctx.font = g.font;
      // Dead material: a dark body with an aluminium face and a bone edge.
      // Nothing emissive — the rejected letter has had its heat taken out.
      ctx.globalAlpha = 0.75 * fade;
      ctx.fillStyle = INK_70;
      ctx.fillText(g.letter, 1.5, 2);
      ctx.globalAlpha = 0.9 * fade;
      ctx.fillStyle = ALU_45;
      ctx.fillText(g.letter, 0, 0);
      ctx.globalAlpha = 0.55 * fade;
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = BONE_55;
      ctx.strokeText(g.letter, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawFlashes(ctx: CanvasRenderingContext2D): void {
    if (flashes.count === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < flashes.count; i++) {
      const f = flashes.items[i];
      const a = f.life / f.maxLife;
      // Hold the first quarter of the life at full intensity, then fall on a
      // steep curve. This is what makes frame one of an impact the money frame;
      // a linear decay spreads the same energy and reads as a soft glow.
      const level = a > 0.75 ? 1 : Math.pow(a / 0.75, 1.7);
      const alpha = clamp01(level * f.peak);
      if (alpha < 0.004) continue;

      if (f.style === FL_PLATE) {
        // Deflection plate: a flat, hard rectangle square to the incoming shot.
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.globalAlpha = alpha * 0.85;
        ctx.fillStyle = f.color;
        const w = f.size * (0.7 + 0.5 * (1 - level));
        const h = f.size * 0.16;
        roundedRect(ctx, -w * 0.5, -h * 0.5, w, h, h * 0.4);
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = HOT_WHITE;
        roundedRect(ctx, -w * 0.5, -h * 0.22, w, h * 0.44, h * 0.2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      if (f.art) {
        // The skirt *grows* as the flash dies, which is how a real one
        // dissipates: the core collapses while the light spreads.
        const d = f.size * (1 + 0.35 * (1 - level));
        ctx.globalAlpha = alpha;
        ctx.drawImage(f.art, f.x - d * 0.5, f.y - d * 0.5, d, d);
      }
      if (f.coreArt && level > 0.25) {
        // A small, hard, genuinely white core. This is the pixel the bloom
        // threshold sees; without it a flash blooms as a grey smudge.
        const cd = f.size * 0.34 * level;
        ctx.globalAlpha = clamp01(alpha * 1.15);
        ctx.drawImage(f.coreArt, f.x - cd * 0.5, f.y - cd * 0.5, cd, cd);
      }
      if (f.barArt && f.bar > 0) {
        // Anamorphic bar: the horizontal flare a spherical front throws off a
        // point highlight. It collapses faster than the core, as it should.
        const bw = f.size * (3.4 + 2.2 * f.bar) * level;
        const bh = f.size * 0.3 * (0.4 + 0.6 * level);
        ctx.save();
        ctx.globalAlpha = clamp01(alpha * f.bar * 0.8);
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot * 0.2);
        ctx.drawImage(f.barArt, -bw * 0.5, -bh * 0.5, bw, bh);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  /**
   * Lens flare chain. Iris ghosts appear on the line joining the light source
   * and the optical axis, mirrored through the centre — so the chain is built
   * by interpolating past the frame centre with negative factors.
   */
  const GHOST_F = [-0.62, -0.34, -0.12, 0.28, 0.55, 0.86];
  const GHOST_S = [0.5, 0.9, 0.32, 0.66, 1.15, 0.42];

  function drawFlares(ctx: CanvasRenderingContext2D, s: SpriteSet): void {
    if (flares.count === 0) return;
    if (!s.flareHex && !s.flareBokeh && !s.flareStar) return;
    const cx = viewW * 0.5;
    const cy = viewH * 0.5;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < flares.count; i++) {
      const f = flares.items[i];
      const t = 1 - f.life / f.maxLife;
      // Fast in, slow out: a flare snaps on with the event and decays with it.
      const level = t < 0.12 ? ease.outQuad(t / 0.12) : 1 - ease.inQuad((t - 0.12) / 0.88);
      const amp = clamp01(level) * f.strength;
      if (amp < 0.01) continue;

      if (s.flareStar) {
        const d = 210 * f.strength * (0.6 + 0.4 * amp);
        ctx.globalAlpha = amp * 0.7;
        ctx.drawImage(s.flareStar, f.x - d * 0.5, f.y - d * 0.5, d, d);
      }
      const vx = f.x - cx;
      const vy = f.y - cy;
      for (let k = 0; k < GHOST_F.length; k++) {
        const art = k % 2 === 0 ? s.flareHex : s.flareBokeh;
        if (!art) continue;
        const gx = cx + vx * GHOST_F[k];
        const gy = cy + vy * GHOST_F[k];
        const d = (16 + 34 * GHOST_S[k]) * f.strength;
        // Ghosts further off the axis are dimmer: they sit further from the
        // coating's design angle and scatter less energy back into the frame.
        ctx.globalAlpha = amp * 0.3 * GHOST_S[k];
        ctx.drawImage(art, gx - d * 0.5, gy - d * 0.5, d, d);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  /**
   * The pop-off bloom moment.
   *
   * Shaped, warm and *low*: a glow anchored on the detonation origin with a
   * real falloff, and only a whisper of flat lift underneath it so the frame
   * does not band. A flat full-frame white wash is not an ultimate, it is an
   * absence of one — it removes the set, the callers and the wordmark's middle
   * letters at exactly the moment the player is meant to be looking at them.
   */
  function drawVeil(ctx: CanvasRenderingContext2D, s: SpriteSet): void {
    if (veilLife <= 0) return;
    const t = 1 - veilLife / veilMax;
    // Reduced motion gets a slow, gentle ramp instead of a snap.
    const rise = reduced ? 0.34 : 0.09;
    const level = t < rise ? ease.outQuad(t / rise) : 1 - ease.outQuart((t - rise) / (1 - rise));
    const amp = clamp01(level) * veilPeak;
    if (amp < 0.004) return;

    const ox = viewW * 0.5;
    const oy = viewH * 0.62;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (s.glowWarm) {
      // A whisper of neutral haze so the lift is not a flat orange gel. Kept
      // small and weak: a wide achromatic wash over the whole frame is the
      // single biggest source of near-white in an ultimate.
      const d = Math.max(viewW, viewH) * 1.7;
      ctx.globalAlpha = amp * 0.28;
      ctx.drawImage(s.glowWarm, ox - d * 0.5, oy - d * 0.5, d, d);
    }
    if (s.glowHemi) {
      // Hemi, and deliberately *not* the sprite with the white core baked in:
      // an ultimate should saturate the room's own colour, not bleach it. It
      // also *expands* rather than sitting still, so the origin thins out as
      // the front leaves it — a static disc at the blast point is a white-out
      // wearing a gradient.
      const d = Math.max(viewW, viewH) * (0.72 + 1.05 * ease.outQuad(clamp01(t / 0.5)));
      ctx.globalAlpha = amp * 0.8;
      ctx.drawImage(s.glowHemi, ox - d * 0.5, oy - d * 0.5, d, d);
    }
    ctx.globalAlpha = amp * 0.06;
    ctx.fillStyle = HOT_DEEP;
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  /**
   * Broadcast error tick. A hard slab with a hemi rule down its leading edge, a
   * mono caption and the required letter in heavy type. It wipes open on the
   * horizontal, holds, then ticks shut — the opposite motion language to the
   * score popups, which float. Nothing about it can be mistaken for a reward.
   */
  function drawTicks(ctx: CanvasRenderingContext2D, scene: SceneContext): void {
    if (ticks.count === 0) return;
    ctx.save();
    for (let i = 0; i < ticks.count; i++) {
      const tk = ticks.items[i];
      const t = 1 - tk.life / tk.maxLife;
      // Open fast, hold, close fast: a mechanical wipe, not a fade.
      const closing = t > 0.82 ? 1 - ease.inQuad((t - 0.82) / 0.18) : 1;
      const open = t < 0.12 ? ease.outExpo(t / 0.12) : closing;
      if (open < 0.02) continue;

      const h = 30;
      const w = 96;
      ctx.save();
      ctx.translate(tk.x, tk.y);
      ctx.scale(open, 1);
      ctx.globalAlpha = closing;

      ctx.fillStyle = INK_88;
      roundedRect(ctx, -w * 0.5, -h * 0.5, w, h, 2);
      ctx.fill();
      ctx.strokeStyle = BONE_18;
      ctx.lineWidth = 1;
      ctx.stroke();
      // Leading rule, hemi: the only saturated element in the whole rejection.
      ctx.fillStyle = HEMI;
      ctx.fillRect(-w * 0.5, -h * 0.5, 3.5, h);
      // A brightness scan travelling down the rule while the tick holds. Timed
      // off raw scene time so it keeps ticking through a slow-motion beat.
      if (!reduced) {
        ctx.fillStyle = HOT_DEEP;
        ctx.globalAlpha = closing * 0.8;
        ctx.fillRect(-w * 0.5, -h * 0.5 + ((scene.rawTime * 1.7) % 1) * h, 3.5, 5);
        ctx.globalAlpha = closing;
      }

      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.font = FONT_CAPTION;
      ctx.fillStyle = ALU_45;
      ctx.fillText("NEEDS", -w * 0.5 + 11, -5);
      ctx.fillStyle = BONE_30;
      ctx.fillText("WRONG LETTER", -w * 0.5 + 11, 7);

      ctx.font = tk.font;
      ctx.textAlign = "center";
      ctx.fillStyle = BONE_82;
      ctx.fillText(tk.letter, w * 0.5 - 21, 0);
      // Machined bracket around the letter, so it reads as a slot on a rig.
      ctx.strokeStyle = ALU_45;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w * 0.5 - 36, -11);
      ctx.lineTo(w * 0.5 - 36, 11);
      ctx.moveTo(w * 0.5 - 6, -11);
      ctx.lineTo(w * 0.5 - 6, 11);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawPopups(ctx: CanvasRenderingContext2D): void {
    if (popups.count === 0) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (let i = 0; i < popups.count; i++) {
      const p = popups.items[i];
      const t = 1 - p.life / p.maxLife;

      // Rise: outBack overshoots past the target and settles — the popup
      // travels *further* than it ends up, which is what sells the impulse.
      const y = p.y - p.rise * ease.outBack(clamp01(t / 0.42)) - p.rise * 0.35 * ease.outQuad(t);
      const x = p.x + p.driftX * ease.outQuad(t) + (reduced ? 0 : Math.sin(t * 5 + p.seed) * 1.6);
      // Scale pop on a shorter clock than the rise, then a late shrink as it
      // leaves — an object receding, not a graphic fading.
      const pop = ease.outBack(clamp01(t / 0.2));
      const scale = 0.35 + 0.65 * pop - 0.1 * ease.inQuad(clamp01((t - 0.6) / 0.4));
      const alpha = t < 0.06 ? t / 0.06 : 1 - ease.inQuad(clamp01((t - 0.55) / 0.45));
      if (alpha < 0.01 || scale <= 0) continue;

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.font = p.font;
      ctx.globalAlpha = alpha;

      // A shadow that reads over anything: a heavy dark stroke for the
      // silhouette, an offset dark fill for depth, then the face. Cheaper and
      // very much crisper than `shadowBlur`, which resamples the whole glyph.
      ctx.lineWidth = p.size * 0.26;
      ctx.strokeStyle = INK_80;
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = INK_80;
      ctx.fillText(p.text, 0, p.size * 0.08);
      // Face, with a bone top bevel so the type has a lit edge under the key.
      ctx.fillStyle = BONE_50;
      ctx.fillText(p.text, 0, -p.size * 0.055);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * Typographic callout with real motion design:
   *   - per-character entry, staggered left to right on an outBack curve;
   *   - tracking that opens wide and closes to tight as the line lands;
   *   - a hemi under-rule that draws out from the centre on its own delay;
   *   - a double strike offset warm/cool on entry only, which the post chain's
   *     chromatic aberration then finishes off;
   *   - an exit that rises and re-opens the tracking, dissolving outward.
   */
  function drawCallouts(ctx: CanvasRenderingContext2D): void {
    if (callouts.count === 0) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (let i = 0; i < callouts.count; i++) {
      const c = callouts.items[i];
      const t = 1 - c.life / c.maxLife;
      const n = Math.min(c.title.length, c.advances.length);
      if (n === 0) continue;

      ctx.font = c.titleFont;
      if (!c.measured) {
        // Advance widths depend only on the font, so they are measured once and
        // the animated tracking is applied to the cached values every frame.
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const adv = ctx.measureText(c.title.charAt(k)).width;
          c.advances[k] = adv;
          sum += adv;
        }
        c.rawWidth = sum;
        c.measured = true;
      }

      if (c.style === CO_FAIL) {
        drawFailPlate(ctx, c, t, n);
        continue;
      }

      const inT = clamp01(t / 0.34);
      const outT = clamp01((t - 0.78) / 0.22);
      const size = c.size;
      // Tracking: wide on entry, tight on the hold, opening again on exit.
      const tracking = lerp(size * 0.42, size * 0.06, ease.outExpo(inT)) + size * 0.5 * ease.inQuad(outT);
      const total = c.rawWidth + tracking * (n - 1);
      const alpha = (t < 0.04 ? t / 0.04 : 1) * (1 - ease.inQuad(outT));
      if (alpha < 0.01) continue;
      const baseY = c.y - 26 * ease.outCubic(outT);

      ctx.save();
      ctx.globalAlpha = alpha;

      // Under-rule, drawn out from the centre on its own delayed curve.
      const ruleW = total * 1.04 * ease.outExpo(clamp01((t - 0.06) / 0.3));
      const ruleY = baseY + size * 0.56;
      ctx.fillStyle = HEMI;
      ctx.fillRect(c.x - ruleW * 0.5, ruleY, ruleW, 3 + 2 * c.power);
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = HEMI_70;
      ctx.fillRect(c.x - ruleW * 0.5, ruleY + 4 + 2 * c.power, ruleW, 1);
      ctx.globalAlpha = alpha;

      // Title, character by character.
      let cursor = c.x - total * 0.5;
      for (let k = 0; k < n; k++) {
        const ch = c.title.charAt(k);
        const adv = c.advances[k];
        const cxk = cursor + adv * 0.5;
        cursor += adv + tracking;
        if (ch === " ") continue;
        // Stagger: each glyph starts ~32 ms after the one before it.
        const local = clamp01((t - k * 0.032) / 0.3);
        if (local <= 0) continue;
        const drop = (1 - ease.outBack(local)) * size * 0.42;
        const chAlpha = ease.outQuad(clamp01(local / 0.4));

        ctx.save();
        ctx.translate(cxk, baseY + drop);
        // Entry squash on the vertical only: the glyph lands and compresses.
        ctx.scale(1, lerp(1.35, 1, ease.outExpo(local)));
        ctx.globalAlpha = alpha * chAlpha;

        // Weight behind the type so it survives any background.
        ctx.lineWidth = size * 0.2;
        ctx.strokeStyle = INK_55;
        ctx.strokeText(ch, 0, 0);
        ctx.fillStyle = INK_38;
        ctx.fillText(ch, 0, size * 0.06);

        // Impact double strike: warm one way, cool the other, entry only.
        if (!reduced && local < 0.7) {
          const split = (1 - local / 0.7) * size * 0.06;
          ctx.globalAlpha = alpha * chAlpha * 0.55;
          ctx.fillStyle = HEMI;
          ctx.fillText(ch, -split, 0);
          ctx.fillStyle = HOT_DEEP;
          ctx.fillText(ch, split, 0);
          ctx.globalAlpha = alpha * chAlpha;
        }

        ctx.fillStyle = BONE;
        ctx.fillText(ch, 0, 0);
        // Lit cap line: the key rig is above, so the top edge takes the light.
        ctx.globalAlpha = alpha * chAlpha * 0.55;
        ctx.fillStyle = HOT_WHITE;
        ctx.fillText(ch, 0, -size * 0.045);
        ctx.restore();
      }

      // Subline, arriving after the title has landed.
      if (c.sub.length > 0) {
        const subT = ease.outCubic(clamp01((t - 0.22) / 0.3));
        ctx.globalAlpha = alpha * subT * 0.9;
        ctx.font = FONT_SUB;
        ctx.fillStyle = INK_55;
        ctx.fillText(c.sub, c.x, baseY + size * 0.95 + 1.5);
        ctx.fillStyle = ALUMINIUM;
        ctx.fillText(c.sub, c.x, baseY + size * 0.95 - (1 - subT) * 8);
      }

      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * The failure plate.
   *
   * Broadcast furniture, not floating type: a planted slab with an underlay so
   * it survives the crowd behind it, a hemi rule down its leading edge, a
   * hazard strip along its foot, the failure in heavy slab on a real baseline
   * and a mono caption under it. It wipes open, holds and ticks shut — the
   * same mechanical language as the rejection tick, and the exact opposite of
   * the reward popups, which float. Nothing about it can read as a prize.
   */
  function drawFailPlate(ctx: CanvasRenderingContext2D, c: Callout, t: number, n: number): void {
    const size = c.size;
    const track = size * 0.1;
    const titleW = c.rawWidth + track * (n - 1);
    const padX = size * 0.6;
    const barW = 5;
    const w = Math.max(titleW + padX * 2 + barW, 216);
    const h = size * 1.02 + 24;
    const closing = t > 0.86 ? 1 - ease.inQuad((t - 0.86) / 0.14) : 1;
    const open = t < 0.1 ? ease.outExpo(t / 0.1) : closing;
    if (open < 0.02) return;

    const x = clamp(c.x, w * 0.5 + 12, Math.max(w * 0.5 + 12, viewW - w * 0.5 - 12));
    const y = clamp(c.y, h * 0.5 + 8, Math.max(h * 0.5 + 8, viewH - h * 0.5 - 8));
    const top = -h * 0.5;
    const bottom = h * 0.5;
    const left = -w * 0.5;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(open, 1);

    // Underlay, so the plate holds over a lit crowd instead of dissolving into it.
    ctx.globalAlpha = closing * 0.5;
    ctx.fillStyle = INK_70;
    roundedRect(ctx, left - 9, top - 7, w + 18, h + 14, 4);
    ctx.fill();

    ctx.globalAlpha = closing;
    ctx.fillStyle = INK_88;
    roundedRect(ctx, left, top, w, h, 2);
    ctx.fill();
    ctx.strokeStyle = BONE_18;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Leading rule.
    ctx.fillStyle = HEMI_HOT;
    ctx.fillRect(left, top, barW, h);

    // Hazard strip along the foot.
    ctx.save();
    roundedRect(ctx, left, bottom - 7, w, 7, 1);
    ctx.clip();
    ctx.fillStyle = INK_88;
    ctx.fillRect(left, bottom - 7, w, 7);
    ctx.fillStyle = HEMI;
    ctx.globalAlpha = closing * 0.75;
    for (let sx = left - 10; sx < -left + 10; sx += 13) {
      ctx.beginPath();
      ctx.moveTo(sx, bottom);
      ctx.lineTo(sx + 5.5, bottom);
      ctx.lineTo(sx + 12, bottom - 7);
      ctx.lineTo(sx + 6.5, bottom - 7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Title, tracked over the cached advances and struck in left to right.
    ctx.font = c.titleFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    let cursor = left + barW + padX;
    const baseY = top + size * 0.84;
    for (let k = 0; k < n; k++) {
      const local = clamp01((t - 0.04 - k * 0.016) / 0.14);
      if (local > 0) {
        ctx.globalAlpha = closing * local;
        ctx.fillStyle = INK_55;
        ctx.fillText(c.title.charAt(k), cursor + 1.6, baseY + 2.2);
        ctx.fillStyle = BONE;
        ctx.fillText(c.title.charAt(k), cursor, baseY);
      }
      cursor += c.advances[k] + track;
    }

    // Caption, on the plate's own baseline grid.
    ctx.globalAlpha = closing * ease.outCubic(clamp01((t - 0.14) / 0.24)) * 0.9;
    ctx.font = FONT_CAPTION;
    ctx.fillStyle = ALU_45;
    ctx.fillText(c.sub, left + barW + padX, bottom - 12);
    ctx.restore();
  }

  return {
    update,
    drawShots,
    drawOverlayEffects,
    onHit,
    onReject,
    onAnswer,
    onLand,
    onPopOff,
    popup,
  };
}
