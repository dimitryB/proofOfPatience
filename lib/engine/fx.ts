/**
 * POP effects layer — particles, ribbon trails and verlet ropes.
 *
 * Everything here is built for a late-night broadcast studio: sparks are hot
 * bone cooling to hemi orange, smoke is warm neutral going cold, debris is a
 * real object that bounces off the studio floor. No second saturated hue ever
 * enters the palette — the caller supplies a tint and the presets decide how it
 * is used.
 *
 * Performance contract (docs/ENGINE_ARCHITECTURE.md):
 *   - struct-of-arrays pool over a fixed capacity, dense packing plus
 *     swap-remove, so `update` and `draw` allocate nothing at all;
 *   - every sprite is drawn with `drawImage` from a *pre-tinted* ramp atlas.
 *     The colour lerp from `color` to `color2` happens once, in linear light,
 *     at bake time — never per particle per frame;
 *   - `draw` walks four prebuilt index buckets (layer × blend) so
 *     `globalCompositeOperation` is written twice per layer, not per particle;
 *   - no `Math.random`, no DOM at module scope, no Node built-ins.
 */

import type {
  EmitOptions,
  Noise,
  ParticlePreset,
  ParticleSystem,
  QualityTier,
  Ribbon,
  Rng,
  Rope,
  TextureBakery,
  TextureId,
} from "../render/types";
import { GAME_HEIGHT, GAME_WIDTH, LETTERS, STAGE_Y } from "../pop";
import { clamp, clamp01, ease, mixColor, parseColor, shade, smoothstep } from "./core";

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Palette
 *
 * The only saturated hue in the game is hemi orange. Hot things start near
 * bone-white and cool *toward* orange; cold things live in warm neutrals.
 * ------------------------------------------------------------------ */

const HOT = "#fff4e6";
const HOT_DEEP = "#ffc48a";
const HEMI = "#ff4600";
const HEMI_EMBER = "#8f2000";
const BONE = "#efe7e0";
const ALUMINIUM = "#8d8781";
const PAPER_SHADE = "#c8bcb1";
const SMOKE_WARM = "#7a6858";
const SMOKE_COOL = "#3a3532";
const DUST_WARM = "#6d5e51";
const DUST_COOL = "#2e2a27";

/* ------------------------------------------------------------------ *
 * Small maths helpers
 * ------------------------------------------------------------------ */

/**
 * 32-bit integer avalanche (Murmur3 finaliser shape) returning [0, 1).
 *
 * Used for the per-frame jitter of `screen-static`, where a *stateless* hash of
 * (seed, frame) is what makes the flecks re-roll every frame without touching
 * the Rng stream and without storing anything extra per particle.
 */
function hash01(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Bounded memo for the few derived colour strings the ribbon/rope need. */
const SHADE_CACHE = new Map<string, string>();

function cachedShade(color: string, amount: number): string {
  const key = color + "|" + amount;
  let hit = SHADE_CACHE.get(key);
  if (hit === undefined) {
    // Renderers can generate colours dynamically; clear rather than leak.
    if (SHADE_CACHE.size >= 96) SHADE_CACHE.clear();
    hit = shade(color, amount);
    SHADE_CACHE.set(key, hit);
  }
  return hit;
}

/* ------------------------------------------------------------------ *
 * Offscreen surfaces (bake targets)
 * ------------------------------------------------------------------ */

interface Surface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
}

/**
 * Creates a rectangular bake target. Prefers `OffscreenCanvas`, falls back to a
 * DOM canvas, and returns null when neither exists — which is exactly what
 * happens during server rendering, where nothing may be baked at all.
 */
function createSurface(width: number, height: number): Surface | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // The 2D interfaces are API-identical for everything used below; the cast
    // keeps one code path instead of a union TypeScript cannot call through.
    return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D };
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return { canvas, ctx };
  }
  return null;
}

/** Rounded rectangle without relying on `CanvasPath.roundRect`, which is young. */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
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
 * Sprite sheets
 *
 * A sheet is one row of `cols` white-on-transparent cells. Most sheets are a
 * single bakery sprite (cols = 1); `glyph` and `chip` are baked locally because
 * the bakery's TextureId union has no glyph or paper art and cannot grow.
 * ------------------------------------------------------------------ */

type SheetId =
  | "spark"
  | "streak"
  | "ring"
  | "glow"
  | "smoke"
  | "ember"
  | "shard"
  | "bokeh"
  | "glyph"
  | "chip";

interface SheetSpec {
  /** Bakery sprite id, for single-cell sheets. */
  texture?: TextureId;
  /** Local atlas builder key, for multi-variant sheets. */
  atlas?: "glyph" | "chip";
  cols: number;
  /** Logical cell edge used when a tint ramp of this sheet is baked. */
  cell: number;
}

/** Unique SOON glyphs — the debris is literally the ammunition that shattered. */
const GLYPHS: string[] = Array.from(new Set<string>(LETTERS));
const GLYPH_VARIANTS = 4; // whole glyph + three fracture patterns

const SHEETS: Record<SheetId, SheetSpec> = {
  spark: { texture: "spark", cols: 1, cell: 48 },
  streak: { texture: "streak", cols: 1, cell: 112 },
  ring: { texture: "ring", cols: 1, cell: 112 },
  glow: { texture: "glow", cols: 1, cell: 80 },
  smoke: { texture: "smoke", cols: 1, cell: 96 },
  ember: { texture: "ember", cols: 1, cell: 48 },
  shard: { texture: "shard", cols: 1, cell: 64 },
  bokeh: { texture: "bokeh", cols: 1, cell: 48 },
  glyph: { atlas: "glyph", cols: GLYPHS.length * GLYPH_VARIANTS, cell: 48 },
  chip: { atlas: "chip", cols: 3, cell: 40 },
};

/** Chip atlas columns. */
const CHIP_CONFETTI = 0;
const CHIP_SHRED = 1;
const CHIP_FLECK = 2;

/**
 * Glyph atlas: for every SOON letter, the whole glyph plus three fracture
 * fragments. The fragments are the glyph masked by a random polygon with a hot
 * stroke along the break, so a shattered "O" reads as broken material rather
 * than a smaller "O".
 */
function bakeGlyphAtlas(cellPx: number, rng: Rng): Surface | null {
  const cols = GLYPHS.length * GLYPH_VARIANTS;
  const surface = createSurface(cols * cellPx, cellPx);
  if (!surface) return null;
  const ctx = surface.ctx;
  // Broadcast slab: heavy, condensed-ish, and available everywhere without a
  // webfont. The exact face does not matter — this is shrapnel, not a headline.
  const font = `900 ${Math.round(cellPx * 0.82)}px "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif`;

  for (let g = 0; g < GLYPHS.length; g++) {
    for (let v = 0; v < GLYPH_VARIANTS; v++) {
      const col = g * GLYPH_VARIANTS + v;
      const ox = col * cellPx;
      ctx.save();
      // Clip first: the fragment pass uses destination-in, which would erase
      // every other cell on the strip if it were not confined here.
      ctx.beginPath();
      ctx.rect(ox, 0, cellPx, cellPx);
      ctx.clip();
      ctx.translate(ox + cellPx * 0.5, cellPx * 0.5);

      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(GLYPHS[g], 0, cellPx * 0.02);

      // Inner shadow offset down-right: the key rig is above and camera-left,
      // so a glyph fragment must be brighter on its upper-left face.
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(0,0,0,0.46)";
      ctx.fillText(GLYPHS[g], cellPx * 0.045, cellPx * 0.075);
      ctx.globalCompositeOperation = "source-over";

      if (v > 0) {
        // Fracture mask: a wedge anchored off-centre. Three random vertices at
        // wide radii keep the break irregular; a convex clip would look cut.
        const a0 = rng.range(0, TAU);
        const r = cellPx * 0.95;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
        let a = a0;
        for (let k = 0; k < 3; k++) {
          a += rng.range(0.5, 1.5);
          const rr = r * rng.range(0.42, 1.05);
          ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        a += rng.range(0.5, 1.4);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.closePath();

        ctx.globalCompositeOperation = "destination-in";
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        // Hot edge on the break: freshly fractured material catches the key.
        ctx.globalCompositeOperation = "source-atop";
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = Math.max(1, cellPx * 0.035);
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    }
  }
  return surface;
}

/**
 * Chip atlas: a confetti chip, a torn paper shred and a video-noise fleck.
 * All three are white-on-transparent so the ramp bake can tint them.
 */
function bakeChipAtlas(cellPx: number, rng: Rng): Surface | null {
  const surface = createSurface(3 * cellPx, cellPx);
  if (!surface) return null;
  const ctx = surface.ctx;

  // --- confetti chip: rounded rectangle with a cross-axis sheen so the chip
  // reads as a curved piece of stock rather than a flat swatch.
  {
    const x = CHIP_CONFETTI * cellPx;
    const w = cellPx * 0.66;
    const h = cellPx * 0.9;
    const px = x + (cellPx - w) * 0.5;
    const py = (cellPx - h) * 0.5;
    const sheen = ctx.createLinearGradient(px, py, px + w, py + h * 0.35);
    sheen.addColorStop(0, "rgba(255,255,255,1)");
    sheen.addColorStop(0.44, "rgba(255,255,255,0.86)");
    sheen.addColorStop(0.72, "rgba(255,255,255,0.52)");
    sheen.addColorStop(1, "rgba(255,255,255,0.78)");
    roundedRect(ctx, px, py, w, h, cellPx * 0.09);
    ctx.fillStyle = sheen;
    ctx.fill();
  }

  // --- paper shred: a long strip with notched, fibrous ends.
  {
    const x = CHIP_SHRED * cellPx;
    const w = cellPx * 0.34;
    const px = x + (cellPx - w) * 0.5;
    const steps = 7;
    // Inset the ends: a strip that runs to the cell boundary is clipped by it,
    // and the resulting perfectly square end reads as a UI bar.
    const y0 = cellPx * 0.05;
    const y1 = cellPx * 0.95;
    const span = y1 - y0;
    ctx.beginPath();
    ctx.moveTo(px + rng.range(0.02, 0.1) * cellPx, y0);
    for (let i = 1; i <= steps; i++) {
      ctx.lineTo(px + rng.range(-0.06, 0.06) * cellPx, y0 + (i / steps) * span);
    }
    ctx.lineTo(px + w - rng.range(0.02, 0.1) * cellPx, y1);
    for (let i = steps - 1; i >= 0; i--) {
      ctx.lineTo(px + w + rng.range(-0.06, 0.06) * cellPx, y0 + (i / steps) * span);
    }
    ctx.closePath();
    const fibre = ctx.createLinearGradient(px, 0, px + w, 0);
    fibre.addColorStop(0, "rgba(255,255,255,0.72)");
    fibre.addColorStop(0.38, "rgba(255,255,255,1)");
    fibre.addColorStop(1, "rgba(255,255,255,0.6)");
    ctx.fillStyle = fibre;
    ctx.fill();
  }

  // --- static fleck: hard-edged, deliberately unsoftened. Video noise is
  // sensor-sharp; a soft dot reads as a bokeh highlight instead.
  {
    const x = CHIP_FLECK * cellPx;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x + cellPx * 0.22, cellPx * 0.3, cellPx * 0.56, cellPx * 0.4);
  }

  return surface;
}

/* ------------------------------------------------------------------ *
 * Tint ramps
 *
 * A ramp is a `cols × steps` atlas of one sheet, pre-tinted along the
 * colour → colour2 lerp. Row r holds the sheet tinted at t = r / (steps − 1),
 * mixed in linear light. Drawing a particle is therefore a single drawImage of
 * the right cell with a globalAlpha — no filters, no per-particle compositing.
 * ------------------------------------------------------------------ */

interface Ramp {
  sheet: SheetId;
  colorA: string;
  colorB: string;
  steps: number;
  cols: number;
  /** Device pixels per cell edge. */
  cellPx: number;
  image: CanvasImageSource | null;
  /** Bake attempted and impossible (no canvas). Such particles are skipped. */
  failed: boolean;
}

/** Colour keys are quantised to 16 levels per channel so near-identical tints
 * collapse onto one ramp. Worst-case shift is ±8/255 — below the noticeable
 * threshold on a moving particle, and it keeps the ramp table small no matter
 * how many colours the game throws at it. */
function quantiseColor(css: string): string {
  const c = parseColor(css);
  const q = (v: number): string => {
    const s = (Math.round(v / 17) * 17).toString(16);
    return s.length < 2 ? "0" + s : s;
  };
  return "#" + q(c.r) + q(c.g) + q(c.b);
}

const RAMP_LIMIT = 56;

/* ------------------------------------------------------------------ *
 * Behaviours
 *
 * A ParticlePreset is a *design*; a behaviour is the simulation and draw code
 * it is built from. Composite presets (answer-burst, muzzle-flash) are simply
 * several behaviour layers emitted together.
 * ------------------------------------------------------------------ */

const B_SPARK = 0;
const B_RING = 1;
const B_SHOCK = 2;
const B_FLASH = 3;
const B_STREAK = 4;
const B_DEBRIS = 5;
const B_EMBER = 6;
const B_CONFETTI = 7;
const B_SMOKE = 8;
const B_DUST = 9;
const B_SHARD = 10;
const B_SHRED = 11;
const B_AMBIENT = 12;
const B_CROWD = 13;
const B_STATIC = 14;

const F_BEHIND = 1;
const F_ADDITIVE = 2;
const F_BOUNCE = 4;
const F_GLINT = 8;
const F_TURB = 16;
const F_LIFT = 32;
const F_JITTER = 64;
const F_WRAP = 128;

/** Bucket index: layer × blend. */
const BK_BEHIND_NORMAL = 0;
const BK_BEHIND_ADD = 1;
const BK_FRONT_NORMAL = 2;
const BK_FRONT_ADD = 3;

/** Marks a bucket entry as the additive specular pass of a glass shard. */
const GLINT_BIT = 1 << 22;

interface LayerSpec {
  behaviour: number;
  sheet: SheetId;
  /** Nominal emission count at "high" quality. */
  count: number;
  /** Count is a fixed structural element (a single ring, one flash). */
  fixed: boolean;
  /** Sheet column, or −1 to pick one per particle. */
  variant: number;
  life: number;
  lifeVar: number;
  size: number;
  sizeVar: number;
  speed: number;
  speedVar: number;
  angle: number;
  spread: number;
  gravity: number;
  drag: number;
  turbulence: number;
  spin: number;
  restitution: number;
  /** Fraction of the emitter's own velocity the particle inherits. */
  inherit: number;
  /** Height / width of the sprite cell at rest. */
  squash: number;
  alpha: number;
  /** Random spawn offset around the emit point, in pixels. */
  scatterX: number;
  scatterY: number;
  additive: boolean;
  behind: boolean;
  glint: boolean;
  lift: boolean;
  jitter: boolean;
  wrap: boolean;
  colorA: string;
  colorB: string;
  /**
   * Where a single caller `color` lands on the ramp. "b" keeps the designed hot
   * start and only recolours the cool end — which is why a tinted answer burst
   * still flashes bone-white before it settles into the caller's hue.
   */
  tint: "a" | "b" | "none";
}

const LAYER_DEFAULTS: LayerSpec = {
  behaviour: B_SPARK,
  sheet: "spark",
  count: 12,
  fixed: false,
  variant: 0,
  life: 0.5,
  lifeVar: 0.35,
  size: 14,
  sizeVar: 0.35,
  speed: 200,
  speedVar: 0.5,
  angle: -Math.PI / 2,
  spread: Math.PI * 2,
  gravity: 0,
  drag: 1,
  turbulence: 0,
  spin: 0,
  restitution: 0,
  inherit: 0,
  squash: 1,
  alpha: 1,
  scatterX: 0,
  scatterY: 0,
  additive: true,
  behind: false,
  glint: false,
  lift: false,
  jitter: false,
  wrap: false,
  colorA: HOT,
  colorB: HEMI,
  tint: "b",
};

function layer(patch: Partial<LayerSpec>): LayerSpec {
  return { ...LAYER_DEFAULTS, ...patch };
}

/**
 * The preset catalogue. Each entry is an ordered list of layers; layer 0 is the
 * "primary" one whose count/life/speed the caller's EmitOptions are measured
 * against, so `count: 30` on a composite scales the whole burst proportionally
 * instead of stamping 30 of everything.
 */
const PRESETS: Record<ParticlePreset, LayerSpec[]> = {
  /* Hot, fast, gravity + drag, stretched along velocity. */
  "impact-spark": [
    layer({
      behaviour: B_SPARK,
      sheet: "spark",
      count: 18,
      life: 0.36,
      lifeVar: 0.45,
      size: 13,
      sizeVar: 0.45,
      speed: 330,
      speedVar: 0.6,
      spread: 3.5,
      gravity: 880,
      drag: 2.6,
      inherit: 0.16,
      colorA: HOT,
      colorB: HEMI,
      tint: "b",
    }),
  ],

  /* One expanding ring: eased scale, fast alpha fall. */
  "impact-ring": [
    layer({
      behaviour: B_RING,
      sheet: "ring",
      count: 1,
      fixed: true,
      life: 0.42,
      lifeVar: 0,
      size: 44,
      sizeVar: 0.1,
      speed: 0,
      speedVar: 0,
      drag: 0,
      colorA: HOT_DEEP,
      colorB: HEMI,
      tint: "b",
      alpha: 0.95,
    }),
  ],

  /* Tumbling glyph fragments that bounce off the studio floor. */
  "letter-debris": [
    layer({
      behaviour: B_DEBRIS,
      sheet: "glyph",
      variant: -1,
      count: 10,
      life: 1.7,
      lifeVar: 0.4,
      size: 23,
      sizeVar: 0.4,
      speed: 215,
      speedVar: 0.65,
      spread: 2.7,
      gravity: 1180,
      drag: 0.45,
      spin: 9,
      restitution: 0.36,
      inherit: 0.3,
      additive: false,
      colorA: BONE,
      colorB: PAPER_SHADE,
      tint: "b",
    }),
  ],

  /* Layered answer: soft flash, ring, hot core sparks, slow embers, breath of
     smoke behind. This is the money moment of the game. */
  "answer-burst": [
    layer({
      behaviour: B_FLASH,
      sheet: "glow",
      count: 1,
      fixed: true,
      life: 0.3,
      lifeVar: 0,
      size: 150,
      sizeVar: 0,
      speed: 0,
      speedVar: 0,
      drag: 0,
      colorA: HOT,
      colorB: HEMI,
      tint: "b",
      alpha: 0.9,
    }),
    layer({
      behaviour: B_RING,
      sheet: "ring",
      count: 1,
      fixed: true,
      life: 0.52,
      lifeVar: 0,
      size: 52,
      sizeVar: 0,
      speed: 0,
      speedVar: 0,
      drag: 0,
      colorA: HOT_DEEP,
      colorB: HEMI,
      tint: "b",
    }),
    layer({
      behaviour: B_SPARK,
      sheet: "spark",
      count: 24,
      life: 0.55,
      lifeVar: 0.5,
      size: 14,
      sizeVar: 0.5,
      speed: 400,
      speedVar: 0.65,
      gravity: 700,
      drag: 2.1,
      colorA: HOT,
      colorB: HEMI,
      tint: "b",
    }),
    layer({
      behaviour: B_EMBER,
      sheet: "ember",
      count: 11,
      life: 1.6,
      lifeVar: 0.55,
      size: 9,
      sizeVar: 0.6,
      speed: 105,
      speedVar: 0.75,
      gravity: -60,
      drag: 1.15,
      turbulence: 52,
      colorA: HOT_DEEP,
      colorB: HEMI_EMBER,
      tint: "none",
    }),
    layer({
      behaviour: B_SMOKE,
      sheet: "smoke",
      count: 3,
      life: 1.5,
      lifeVar: 0.4,
      size: 46,
      sizeVar: 0.4,
      speed: 60,
      speedVar: 0.8,
      gravity: -22,
      drag: 1.7,
      turbulence: 30,
      spin: 0.6,
      additive: false,
      behind: true,
      alpha: 0.3,
      colorA: SMOKE_WARM,
      colorB: SMOKE_COOL,
      tint: "none",
    }),
  ],

  /* Thin quads flipping in 3D, air drag, gentle sway. */
  confetti: [
    layer({
      behaviour: B_CONFETTI,
      sheet: "chip",
      variant: CHIP_CONFETTI,
      count: 26,
      life: 2.8,
      lifeVar: 0.35,
      size: 13,
      sizeVar: 0.35,
      speed: 265,
      speedVar: 0.55,
      spread: 1.6,
      gravity: 430,
      drag: 1.5,
      turbulence: 26,
      spin: 3.4,
      squash: 1.5,
      additive: false,
      inherit: 0.2,
      colorA: BONE,
      colorB: HEMI,
      tint: "b",
    }),
  ],

  /* Grows, slows, curls on noise, warm to neutral. */
  "smoke-puff": [
    layer({
      behaviour: B_SMOKE,
      sheet: "smoke",
      count: 5,
      life: 2,
      lifeVar: 0.4,
      size: 56,
      sizeVar: 0.4,
      speed: 58,
      speedVar: 0.75,
      spread: Math.PI * 1.1,
      gravity: -20,
      drag: 1.5,
      turbulence: 36,
      spin: 0.55,
      additive: false,
      behind: true,
      alpha: 0.42,
      colorA: SMOKE_WARM,
      colorB: SMOKE_COOL,
      tint: "none",
    }),
  ],

  /* Low, wide, floor-hugging. */
  "dust-kick": [
    layer({
      behaviour: B_DUST,
      sheet: "smoke",
      count: 8,
      life: 1.45,
      lifeVar: 0.4,
      size: 42,
      sizeVar: 0.4,
      speed: 140,
      speedVar: 0.6,
      angle: 0,
      spread: 0.85,
      gravity: -8,
      drag: 2.8,
      turbulence: 14,
      spin: 0.4,
      restitution: 0.02,
      squash: 0.42,
      additive: false,
      behind: true,
      alpha: 0.34,
      colorA: DUST_WARM,
      colorB: DUST_COOL,
      tint: "none",
    }),
  ],

  /* Slow rising, flickering brightness, cools over life. */
  ember: [
    layer({
      behaviour: B_EMBER,
      sheet: "ember",
      count: 8,
      life: 2.5,
      lifeVar: 0.5,
      size: 8,
      sizeVar: 0.55,
      speed: 48,
      speedVar: 0.8,
      spread: 1.5,
      gravity: -44,
      drag: 0.95,
      turbulence: 48,
      colorA: HOT_DEEP,
      colorB: HEMI_EMBER,
      tint: "none",
    }),
  ],

  /* Angular, spins, catches a specular flash twice per revolution. */
  "glass-shard": [
    layer({
      behaviour: B_SHARD,
      sheet: "shard",
      count: 12,
      life: 1.5,
      lifeVar: 0.4,
      size: 19,
      sizeVar: 0.5,
      speed: 285,
      speedVar: 0.6,
      spread: 2.5,
      gravity: 1250,
      drag: 0.4,
      spin: 12,
      restitution: 0.42,
      inherit: 0.25,
      additive: false,
      glint: true,
      colorA: BONE,
      colorB: ALUMINIUM,
      tint: "none",
    }),
  ],

  /* Flutters with a lift force. */
  "paper-shred": [
    layer({
      behaviour: B_SHRED,
      sheet: "chip",
      variant: CHIP_SHRED,
      count: 16,
      life: 3,
      lifeVar: 0.35,
      size: 17,
      sizeVar: 0.4,
      speed: 200,
      speedVar: 0.6,
      spread: 2.2,
      gravity: 300,
      drag: 1.9,
      turbulence: 22,
      spin: 1.8,
      squash: 2.1,
      lift: true,
      additive: false,
      inherit: 0.2,
      colorA: BONE,
      colorB: PAPER_SHADE,
      tint: "b",
    }),
  ],

  /* Two-to-three frame anisotropic burst: a bar, a core, a few sparks. */
  "muzzle-flash": [
    layer({
      behaviour: B_STREAK,
      sheet: "streak",
      count: 1,
      fixed: true,
      life: 0.055,
      lifeVar: 0,
      size: 128,
      sizeVar: 0,
      speed: 0,
      speedVar: 0,
      angle: 0,
      drag: 0,
      squash: 0.3,
      colorA: HOT,
      colorB: HOT_DEEP,
      tint: "none",
    }),
    layer({
      behaviour: B_FLASH,
      sheet: "glow",
      count: 1,
      fixed: true,
      life: 0.08,
      lifeVar: 0,
      size: 78,
      sizeVar: 0,
      speed: 0,
      speedVar: 0,
      drag: 0,
      squash: 0.72,
      colorA: HOT,
      colorB: HEMI,
      tint: "b",
    }),
    layer({
      behaviour: B_SPARK,
      sheet: "spark",
      count: 5,
      life: 0.2,
      lifeVar: 0.5,
      size: 10,
      sizeVar: 0.4,
      speed: 470,
      speedVar: 0.55,
      angle: 0,
      spread: 0.6,
      gravity: 520,
      drag: 3.2,
      colorA: HOT,
      colorB: HEMI,
      tint: "b",
    }),
  ],

  /* A ring that also distorts scale non-uniformly as it passes. */
  shockwave: [
    layer({
      behaviour: B_SHOCK,
      sheet: "ring",
      count: 1,
      fixed: true,
      life: 0.66,
      lifeVar: 0,
      size: 62,
      sizeVar: 0,
      speed: 0,
      speedVar: 0,
      drag: 0,
      colorA: HOT_DEEP,
      colorB: HEMI,
      tint: "b",
      alpha: 0.9,
    }),
  ],

  /* Persistent slow drift on curl noise, respawning at the bounds. */
  "ambient-dust": [
    layer({
      behaviour: B_AMBIENT,
      sheet: "bokeh",
      count: 40,
      life: 26,
      lifeVar: 0.6,
      size: 5,
      sizeVar: 1.1,
      speed: 10,
      speedVar: 0.9,
      spread: Math.PI * 2,
      gravity: 0.8,
      drag: 0.12,
      turbulence: 9,
      behind: true,
      wrap: true,
      alpha: 0.17,
      colorA: "#cdbaa6",
      colorB: "#6a5d54",
      tint: "none",
    }),
  ],

  /* Audience camera flashes: a hot point plus its anamorphic bar. */
  "crowd-flash": [
    layer({
      behaviour: B_CROWD,
      sheet: "glow",
      count: 1,
      fixed: true,
      life: 0.26,
      lifeVar: 0.3,
      size: 34,
      sizeVar: 0.35,
      speed: 0,
      speedVar: 0,
      drag: 0,
      behind: true,
      colorA: "#ffffff",
      colorB: HOT_DEEP,
      tint: "none",
      alpha: 0.85,
    }),
    layer({
      behaviour: B_STREAK,
      sheet: "streak",
      count: 1,
      fixed: true,
      life: 0.22,
      lifeVar: 0.3,
      size: 64,
      sizeVar: 0.35,
      speed: 0,
      speedVar: 0,
      angle: 0,
      drag: 0,
      squash: 0.16,
      behind: true,
      colorA: "#ffffff",
      colorB: HOT_DEEP,
      tint: "none",
      alpha: 0.5,
    }),
  ],

  /* Short-lived noise flecks for damage. */
  "screen-static": [
    layer({
      behaviour: B_STATIC,
      sheet: "chip",
      variant: CHIP_FLECK,
      count: 44,
      life: 0.16,
      lifeVar: 0.7,
      size: 4.5,
      sizeVar: 1.1,
      speed: 0,
      speedVar: 0,
      drag: 0,
      // Damage noise belongs to the frame, not to a point: the flecks scatter
      // across half the stage from wherever they are emitted.
      scatterX: 470,
      scatterY: 290,
      jitter: true,
      alpha: 0.8,
      colorA: "#ffffff",
      colorB: HOT_DEEP,
      tint: "none",
    }),
  ],
};

/* ------------------------------------------------------------------ *
 * Quality
 * ------------------------------------------------------------------ */

const QUALITY_EMIT: Record<QualityTier, number> = { low: 0.34, medium: 0.62, high: 1, ultra: 1.3 };
const QUALITY_RAMP_STEPS: Record<QualityTier, number> = { low: 4, medium: 5, high: 6, ultra: 8 };
const QUALITY_SPRITE_SCALE: Record<QualityTier, number> = { low: 0.7, medium: 0.85, high: 1, ultra: 1.2 };

/** ~70 % fewer particles when the player has asked for reduced motion. */
const REDUCED_EMIT = 0.3;

interface ParticleSystemDeps {
  rng: Rng;
  noise: Noise;
  bakery: TextureBakery;
  /** Hard pool size. Default 2400, which fits a full answer-burst chain. */
  capacity?: number;
  /** Live quality hint; pass a getter to change tier without rebuilding. */
  quality?: QualityTier | (() => QualityTier);
  reducedMotion?: boolean | (() => boolean);
  /** Studio floor line for the bouncing presets. Defaults to STAGE_Y. */
  floorY?: number;
  /** Region ambient dust wraps around. Mutate in place on resize. */
  bounds?: { x: number; y: number; width: number; height: number };
}

/* ------------------------------------------------------------------ *
 * Particle system
 * ------------------------------------------------------------------ */

export function createParticleSystem(deps: ParticleSystemDeps): ParticleSystem {
  const capacity = Math.round(clamp(deps.capacity ?? 2400, 128, 20000));
  const noise = deps.noise;
  const bakery = deps.bakery;
  // Separate streams: baking must never shift the emission sequence, and vice
  // versa, or a lazily baked atlas would change every later particle.
  const emitRng = deps.rng.fork(0x5041_5254);
  const bakeRng = deps.rng.fork(0x4241_4b45);
  const floorY = deps.floorY ?? STAGE_Y;
  const bounds = deps.bounds ?? { x: 0, y: 0, width: GAME_WIDTH, height: GAME_HEIGHT };

  const resolveQuality = (): QualityTier => {
    const q = deps.quality;
    if (typeof q === "function") return q();
    return q ?? "high";
  };
  const resolveReduced = (): boolean => {
    const r = deps.reducedMotion;
    if (typeof r === "function") return r();
    return r ?? false;
  };

  /* ---- struct-of-arrays pool ---------------------------------- */

  const px = new Float32Array(capacity);
  const py = new Float32Array(capacity);
  const vx = new Float32Array(capacity);
  const vy = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const maxLife = new Float32Array(capacity);
  const size = new Float32Array(capacity);
  const rot = new Float32Array(capacity);
  const spin = new Float32Array(capacity);
  const grav = new Float32Array(capacity);
  const drag = new Float32Array(capacity);
  const turb = new Float32Array(capacity);
  const seed = new Float32Array(capacity);
  const squash = new Float32Array(capacity);
  const alphaMul = new Float32Array(capacity);
  const rest = new Float32Array(capacity);
  const beh = new Uint8Array(capacity);
  const flags = new Uint8Array(capacity);
  const rampIdx = new Uint8Array(capacity);
  const variant = new Uint8Array(capacity);

  let count = 0;
  let stealCursor = 0;
  let time = 0;
  let frame = 0;

  /* ---- draw buckets -------------------------------------------- */

  // A particle contributes at most two entries (body + specular glint), so each
  // bucket is sized for the worst case and never grows.
  const buckets: Int32Array[] = [
    new Int32Array(capacity * 2),
    new Int32Array(capacity * 2),
    new Int32Array(capacity * 2),
    new Int32Array(capacity * 2),
  ];
  const bucketCount = new Int32Array(4);
  let bucketsDirty = true;

  /* ---- sheets and ramps ---------------------------------------- */

  const atlases = new Map<string, Surface | null>();
  const ramps: Ramp[] = [];
  const rampByKey = new Map<string, number>();
  const rampDefaultBySheet = new Map<SheetId, number>();
  let spriteScale = 0; // resolved at first bake, from the quality tier then

  const sheetCellPx = (sheet: SheetId): number =>
    Math.max(8, Math.round(SHEETS[sheet].cell * (spriteScale || 1)));

  const getAtlas = (key: "glyph" | "chip"): Surface | null => {
    const hit = atlases.get(key);
    if (hit !== undefined) return hit;
    const cellPx = key === "glyph" ? sheetCellPx("glyph") : sheetCellPx("chip");
    const made =
      key === "glyph"
        ? bakeGlyphAtlas(cellPx, bakeRng.fork(0x676c7970))
        : bakeChipAtlas(cellPx, bakeRng.fork(0x63686970));
    atlases.set(key, made);
    return made;
  };

  /** Blits one untinted cell of a sheet into a bake target. */
  const blitCell = (
    ctx: CanvasRenderingContext2D,
    sheet: SheetId,
    col: number,
    dx: number,
    dy: number,
    d: number,
  ): void => {
    const spec = SHEETS[sheet];
    if (spec.texture) {
      ctx.drawImage(bakery.get(spec.texture), dx, dy, d, d);
      return;
    }
    if (spec.atlas) {
      const atlas = getAtlas(spec.atlas);
      if (!atlas) return;
      const cellPx = sheetCellPx(sheet);
      ctx.drawImage(atlas.canvas, col * cellPx, 0, cellPx, cellPx, dx, dy, d, d);
    }
  };

  /**
   * Bakes a ramp: `cols × steps` cells, row r tinted at t = r / (steps − 1).
   *
   * Tinting is `multiply` (so the sprite's own shading — the ember's heat ramp,
   * the smoke's self-shadowing — survives) followed by `destination-in` with the
   * same art to restore the alpha the opaque fill destroyed. The row is clipped
   * first, because destination-in erases everything outside the source inside
   * the current clip, which would otherwise wipe the rows already baked.
   */
  const bakeRamp = (ramp: Ramp): void => {
    const d = ramp.cellPx;
    const surface = createSurface(ramp.cols * d, ramp.steps * d);
    if (!surface) {
      ramp.failed = true;
      return;
    }
    const ctx = surface.ctx;
    const denom = Math.max(1, ramp.steps - 1);
    for (let row = 0; row < ramp.steps; row++) {
      const y = row * d;
      const tint = mixColor(ramp.colorA, ramp.colorB, row / denom, "linear");
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, ramp.cols * d, d);
      ctx.clip();
      for (let col = 0; col < ramp.cols; col++) blitCell(ctx, ramp.sheet, col, col * d, y, d);
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = tint;
      ctx.fillRect(0, y, ramp.cols * d, d);
      ctx.globalCompositeOperation = "destination-in";
      for (let col = 0; col < ramp.cols; col++) blitCell(ctx, ramp.sheet, col, col * d, y, d);
      ctx.globalCompositeOperation = "source-over";
      ctx.restore();
    }
    ramp.image = surface.canvas;
  };

  /**
   * Resolves a (sheet, colourA, colourB) triple to a ramp slot. The canvas is
   * *not* baked here — emit() can run during a server render, so the actual
   * pixel work is deferred to the first draw.
   */
  const pickRamp = (sheet: SheetId, colorA: string, colorB: string): number => {
    const a = quantiseColor(colorA);
    const b = quantiseColor(colorB);
    const key = sheet + "|" + a + "|" + b;
    const hit = rampByKey.get(key);
    if (hit !== undefined) return hit;
    if (ramps.length >= RAMP_LIMIT) {
      // Table is full: fall back to the first ramp already baked for this sheet
      // so the effect still draws, just in an earlier tint.
      const fallback = rampDefaultBySheet.get(sheet);
      return fallback ?? 0;
    }
    if (spriteScale === 0) spriteScale = QUALITY_SPRITE_SCALE[resolveQuality()];
    const index = ramps.length;
    ramps.push({
      sheet,
      colorA: a,
      colorB: b,
      steps: QUALITY_RAMP_STEPS[resolveQuality()],
      cols: SHEETS[sheet].cols,
      cellPx: sheetCellPx(sheet),
      image: null,
      failed: false,
    });
    rampByKey.set(key, index);
    if (!rampDefaultBySheet.has(sheet)) rampDefaultBySheet.set(sheet, index);
    return index;
  };

  /* ---- pool management ------------------------------------------ */

  /**
   * Reserves a slot. When the pool is full the shortest-lived of four probes is
   * recycled: a bounded, allocation-free approximation of "drop the least
   * important particle" that never steals long-lived ambient dust.
   */
  const acquire = (): number => {
    if (count < capacity) return count++;
    let best = stealCursor % count;
    let bestLife = life[best];
    for (let k = 1; k < 4; k++) {
      const i = (stealCursor + k * 397) % count;
      if (life[i] < bestLife) {
        bestLife = life[i];
        best = i;
      }
    }
    stealCursor = (stealCursor + 1) % count;
    return best;
  };

  const kill = (i: number): void => {
    const last = --count;
    if (i === last) return;
    px[i] = px[last];
    py[i] = py[last];
    vx[i] = vx[last];
    vy[i] = vy[last];
    life[i] = life[last];
    maxLife[i] = maxLife[last];
    size[i] = size[last];
    rot[i] = rot[last];
    spin[i] = spin[last];
    grav[i] = grav[last];
    drag[i] = drag[last];
    turb[i] = turb[last];
    seed[i] = seed[last];
    squash[i] = squash[last];
    alphaMul[i] = alphaMul[last];
    rest[i] = rest[last];
    beh[i] = beh[last];
    flags[i] = flags[last];
    rampIdx[i] = rampIdx[last];
    variant[i] = variant[last];
  };

  /* ---- emission -------------------------------------------------- */

  // Resolved emitter state, reused across every spawn of one emit() call so the
  // inner loop passes no arguments and allocates nothing.
  const em = {
    x: 0,
    y: 0,
    ivx: 0,
    ivy: 0,
    angle: 0,
    spread: 0,
    speed: 0,
    speedVar: 0,
    sizeMul: 1,
    lifeMul: 1,
    gravity: 0,
    drag: 0,
    ramp: 0,
    spec: LAYER_DEFAULTS,
    flags: 0,
  };

  const spawnOne = (): void => {
    const s = em.spec;
    const i = acquire();

    const ang = em.angle + emitRng.range(-0.5, 0.5) * em.spread;
    const sp = em.speed * (1 + emitRng.range(-1, 1) * em.speedVar);
    if (s.wrap) {
      // A volume of dust has no emission point: seed it across the whole frame
      // so the first second already looks like a room with air in it.
      px[i] = bounds.x + emitRng.next() * bounds.width;
      py[i] = bounds.y + emitRng.next() * bounds.height;
    } else {
      px[i] = em.x + (s.scatterX === 0 ? 0 : emitRng.range(-s.scatterX, s.scatterX));
      py[i] = em.y + (s.scatterY === 0 ? 0 : emitRng.range(-s.scatterY, s.scatterY));
    }
    vx[i] = Math.cos(ang) * sp + em.ivx * s.inherit;
    vy[i] = Math.sin(ang) * sp + em.ivy * s.inherit;

    const ml = Math.max(0.016, s.life * em.lifeMul * (1 + emitRng.range(-1, 1) * s.lifeVar));
    life[i] = ml;
    maxLife[i] = ml;
    size[i] = Math.max(0.5, s.size * em.sizeMul * (1 + emitRng.range(-1, 1) * s.sizeVar));
    rot[i] = s.behaviour === B_STREAK || s.behaviour === B_FLASH || s.behaviour === B_SHOCK ? em.angle : emitRng.range(0, TAU);
    spin[i] = s.spin === 0 ? 0 : emitRng.range(-s.spin, s.spin);
    grav[i] = em.gravity;
    drag[i] = em.drag;
    turb[i] = s.turbulence;
    // Phase in seconds-of-arc; the fractional part also seeds the flip rate and
    // the static jitter hash, so one float carries every per-particle offset.
    seed[i] = emitRng.range(0, 1000);
    squash[i] = s.squash;
    alphaMul[i] = s.alpha;
    rest[i] = s.restitution;
    beh[i] = s.behaviour;
    flags[i] = em.flags;
    rampIdx[i] = em.ramp;
    variant[i] = s.variant < 0 ? emitRng.int(0, SHEETS[s.sheet].cols - 1) : s.variant;

  };

  const emit = (preset: ParticlePreset, options: EmitOptions): void => {
    const layers = PRESETS[preset];
    if (!layers) return;
    const reduced = resolveReduced();
    const qScale = QUALITY_EMIT[resolveQuality()] * (reduced ? REDUCED_EMIT : 1);

    const primary = layers[0];
    // Caller-facing counts, lives and speeds are expressed against layer 0, so a
    // composite scales as a whole instead of stamping N of every sub-layer.
    const countRatio =
      options.count !== undefined && primary.count > 0 ? options.count / primary.count : 1;
    const lifeMul = options.life !== undefined && primary.life > 0 ? options.life / primary.life : 1;
    const speedMul =
      options.speed !== undefined && primary.speed > 0 ? options.speed / primary.speed : 1;

    em.x = options.x;
    em.y = options.y;
    em.ivx = options.vx ?? 0;
    em.ivy = options.vy ?? 0;
    em.sizeMul = options.scale ?? 1;
    em.lifeMul = lifeMul;

    for (let l = 0; l < layers.length; l++) {
      const s = layers[l];
      const n = s.fixed
        ? s.count
        : Math.max(1, Math.round(s.count * countRatio * qScale));

      // Tint routing. Both ends given: honour the contract literally and lerp
      // color → color2. One end given: route it to whichever end the preset was
      // designed around, so a single tint never flattens a two-colour ramp.
      let ca = s.colorA;
      let cb = s.colorB;
      if (s.tint !== "none") {
        const c1 = options.color;
        const c2 = options.color2;
        if (c1 !== undefined && c2 !== undefined) {
          ca = c1;
          cb = c2;
        } else if (c1 !== undefined) {
          if (s.tint === "a") ca = c1;
          else cb = c1;
        } else if (c2 !== undefined) {
          cb = c2;
        }
      }

      const additive = options.additive ?? s.additive;
      const behind = options.behind ?? s.behind;
      let f = 0;
      if (behind) f |= F_BEHIND;
      if (additive) f |= F_ADDITIVE;
      if (s.restitution > 0) f |= F_BOUNCE;
      if (s.glint) f |= F_GLINT;
      if (s.turbulence > 0) f |= F_TURB;
      if (s.lift) f |= F_LIFT;
      // Reduced motion keeps the composition but stops anything strobing.
      if (s.jitter && !reduced) f |= F_JITTER;
      if (s.wrap) f |= F_WRAP;

      em.spec = s;
      em.flags = f;
      em.ramp = pickRamp(s.sheet, ca, cb);
      em.angle = options.angle ?? s.angle;
      em.spread = options.spread ?? s.spread;
      em.speed = s.speed * speedMul;
      em.speedVar = options.speedVariance ?? s.speedVar;
      // Physical overrides apply to every layer: they describe the world, not
      // the design of one sub-emitter.
      em.gravity = options.gravity ?? s.gravity;
      em.drag = options.drag ?? s.drag;
      for (let k = 0; k < n; k++) spawnOne();
    }
    bucketsDirty = true;
  };

  /* ---- simulation ------------------------------------------------ */

  // Curl-noise sampling constants. `S` is the spatial frequency (one eddy per
  // ~160 px) and `E` the finite-difference step in field units (~2.6 px). GAIN
  // normalises the result: the mean gradient magnitude of this noise over that
  // step measures 0.0433, so 23 turns it into unity and a `turbulence` of 50
  // really is ~50 px/s² of swirl — the same scale the cheap path below uses.
  const CURL_S = 0.0062;
  const CURL_E = 0.016;
  const CURL_GAIN = 23;

  const update = (dtRaw: number): void => {
    if (!(dtRaw > 0) || !Number.isFinite(dtRaw)) return;
    // A backgrounded tab returns with a huge delta; clamping stops every
    // particle tunnelling through the floor in one step.
    const dt = Math.min(dtRaw, 0.05);
    time += dt;
    frame++;

    const quality = resolveQuality();
    // The true 3-sample curl is divergence free (particles swirl, never pile
    // into sinks). On the low tiers a 2-sample decorrelated field costs a third
    // as much and, at these amplitudes, is indistinguishable in motion.
    const cheapCurl = quality === "low" || quality === "medium";
    const wrapLeft = bounds.x - 40;
    const wrapTop = bounds.y - 40;
    const wrapW = bounds.width + 80;
    const wrapH = bounds.height + 80;

    for (let i = 0; i < count; ) {
      const f = flags[i];
      const b = beh[i];
      life[i] -= dt;

      if (life[i] <= 0) {
        if ((f & F_WRAP) !== 0) {
          // Ambient dust never dies; it is re-seeded somewhere in frame so the
          // volume stays populated for the whole broadcast. The refreshed life
          // stays inside the first 6 % of the span so the mote lands inside its
          // own fade-in window and never pops back into existence.
          const ml = maxLife[i];
          life[i] = ml * emitRng.range(0.94, 1);
          px[i] = bounds.x + emitRng.next() * bounds.width;
          py[i] = bounds.y + emitRng.next() * bounds.height;
        } else {
          kill(i);
          continue;
        }
      }

      if ((f & F_TURB) !== 0) {
        const bx = px[i] * CURL_S + time * 0.045;
        const by = py[i] * CURL_S;
        const t0 = noise.n2(bx, by);
        if (cheapCurl) {
          const t1 = noise.n2(bx + 31.7, by - 17.3);
          vx[i] += t1 * turb[i] * dt;
          vy[i] += t0 * turb[i] * dt;
        } else {
          const t1 = noise.n2(bx + CURL_E, by);
          const t2 = noise.n2(bx, by + CURL_E);
          // curl of a scalar potential ψ in 2D is (∂ψ/∂y, −∂ψ/∂x): divergence
          // free by construction, which is what makes smoke swirl instead of
          // collapsing into the noise field's minima.
          vx[i] += (t2 - t0) * CURL_GAIN * turb[i] * dt;
          vy[i] -= (t1 - t0) * CURL_GAIN * turb[i] * dt;
        }
      }

      if ((f & F_LIFT) !== 0) {
        // Paper flutter: a lift force that oscillates as the sheet presents its
        // face to the airflow, plus the sideways slip that comes with it.
        const ph = time * 4.3 + seed[i];
        const lift = 0.55 + 0.45 * Math.sin(ph);
        vy[i] -= grav[i] * lift * 0.72 * dt;
        vx[i] += Math.cos(ph * 0.63 + seed[i]) * 46 * dt;
      }

      vy[i] += grav[i] * dt;

      // Implicit-Euler linear drag: v ← v / (1 + k·dt). Unconditionally stable
      // and exact for the linear model, unlike the explicit v ← v·(1 − k·dt)
      // which explodes as soon as k·dt > 1.
      const d = drag[i];
      if (d > 0) {
        const damp = 1 / (1 + d * dt);
        vx[i] *= damp;
        vy[i] *= damp;
      }

      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      if (spin[i] !== 0) rot[i] += spin[i] * dt;

      if ((f & F_BOUNCE) !== 0 && py[i] > floorY) {
        const r = rest[i];
        // Reflect the overshoot as well as the velocity, or fast debris loses a
        // frame of travel on every contact and creeps into the floor.
        py[i] = floorY - (py[i] - floorY) * r;
        vy[i] = -vy[i] * r;
        vx[i] *= 0.74; // tangential friction against a polished studio floor
        spin[i] *= 0.6;
        if (vy[i] > -28) {
          // Settled: stop the micro-bounce jitter and let it lie there.
          py[i] = floorY;
          vy[i] = 0;
          grav[i] = 0;
          spin[i] *= 0.25;
          vx[i] *= 0.86;
        }
      }

      if ((f & F_WRAP) !== 0) {
        // Toroidal wrap with a margin, so a mote leaving frame reappears on the
        // far side instead of the volume slowly emptying.
        if (px[i] < wrapLeft) px[i] += wrapW;
        else if (px[i] > wrapLeft + wrapW) px[i] -= wrapW;
        if (py[i] < wrapTop) py[i] += wrapH;
        else if (py[i] > wrapTop + wrapH) py[i] -= wrapH;
      }

      if (b === B_DUST && py[i] > floorY - 1) py[i] = floorY - 1;

      i++;
    }
    bucketsDirty = true;
  };

  /* ---- bucketing -------------------------------------------------- */

  const rebuildBuckets = (): void => {
    bucketCount[0] = 0;
    bucketCount[1] = 0;
    bucketCount[2] = 0;
    bucketCount[3] = 0;
    for (let i = 0; i < count; i++) {
      const f = flags[i];
      const behind = (f & F_BEHIND) !== 0;
      const add = (f & F_ADDITIVE) !== 0;
      const bk = (behind ? 0 : 2) + (add ? 1 : 0);
      buckets[bk][bucketCount[bk]++] = i;
      if ((f & F_GLINT) !== 0) {
        // The specular flash of a glass shard rides in the additive bucket of
        // the same layer, tagged so the draw pass knows which pass it is.
        const gk = behind ? BK_BEHIND_ADD : BK_FRONT_ADD;
        buckets[gk][bucketCount[gk]++] = i | GLINT_BIT;
      }
    }
    bucketsDirty = false;
  };

  /* ---- drawing ---------------------------------------------------- */

  // Base transform of the target context, captured once per draw() so every
  // rotated particle can be composed against it without save/restore churn.
  let baseA = 1;
  let baseB = 0;
  let baseC = 0;
  let baseD = 1;
  let baseE = 0;
  let baseF = 0;
  /**
   * True when the context exposes `getTransform`, which lets rotated particles
   * be composed against the live camera matrix by hand. Without it there is no
   * way to read the caller's transform, so the slower save/rotate/restore path
   * is the only correct one.
   */
  let fastMatrix = true;
  /** Ramp slot for the shard specular pass, resolved on first additive draw. */
  let glintSlot = 0;
  /** Ember flicker rate; held under 3 Hz when reduced motion is requested. */
  let flickerHz = 9.5;

  const drawBucket = (
    ctx: CanvasRenderingContext2D,
    bk: number,
    blend: GlobalCompositeOperation,
  ): void => {
    const n = bucketCount[bk];
    if (n === 0) return;
    const list = buckets[bk];
    ctx.globalCompositeOperation = blend;
    let matrixSet = false;

    for (let k = 0; k < n; k++) {
      const entry = list[k];
      const glintPass = (entry & GLINT_BIT) !== 0;
      const i = entry & (GLINT_BIT - 1);

      const ml = maxLife[i];
      const t = ml > 0 ? clamp01(1 - life[i] / ml) : 1;
      const u = 1 - t;
      const s = size[i];
      const b = beh[i];

      let w = s;
      let h = s * squash[i];
      let angle = rot[i];
      let a = alphaMul[i];
      let rowT = t;
      let ramp = rampIdx[i];
      let col = variant[i];
      // Draw-space offset; only sensor noise uses it, and it is never written
      // back into the simulation.
      let ox = 0;
      let oy = 0;

      if (glintPass) {
        // Two flashes per revolution, with a narrow lobe: a shard only catches
        // the key when a facet is square to it.
        const c = Math.cos(rot[i] * 2 + seed[i]);
        const lobe = c > 0 ? c * c * c * c * c * c : 0;
        if (lobe < 0.02) continue;
        a = lobe * (1 - smoothstep(0.7, 1, t)) * 0.95;
        w = s * (1.05 + 1.7 * lobe);
        h = w;
        angle = 0;
        rowT = 0;
        ramp = glintSlot;
        col = 0;
      } else {
        switch (b) {
          case B_SPARK: {
            // Velocity-stretched billboard: the sprite is elongated along the
            // direction of travel and thinned across it, the 2D stand-in for a
            // motion-blurred point light.
            const sx = vx[i];
            const sy = vy[i];
            const sp = Math.sqrt(sx * sx + sy * sy);
            const stretch = 1 + Math.min(5.2, sp * 0.0105);
            w = s * stretch;
            h = s / (1 + (stretch - 1) * 0.45);
            angle = Math.atan2(sy, sx);
            // Snap-on, then a fall between quadratic and cubic: sparks are hot
            // instantly and die faster than a linear fade suggests.
            a *= smoothstep(0, 0.06, t) * u * u * (0.28 + 0.72 * u);
            rowT = Math.sqrt(t); // cools quickly, then holds near the cool end
            break;
          }
          case B_RING: {
            const e = ease.outQuart(t);
            const r = s * (0.34 + 1.8 * e);
            w = r;
            h = r;
            angle = 0;
            a *= smoothstep(0, 0.05, t) * u * u * u;
            rowT = e;
            break;
          }
          case B_SHOCK: {
            const e = ease.outQuint(t);
            const r = s * (0.3 + 2.7 * e);
            // Non-uniform distortion: the wave leads along its axis and pinches
            // across it, peaking mid-flight and relaxing as it dissipates.
            const k2 = Math.sin(t * Math.PI) * 0.3;
            w = r * (1 + k2);
            h = r * (1 - k2 * 0.72);
            a *= smoothstep(0, 0.05, t) * u * u * (0.25 + 0.75 * u);
            rowT = e;
            break;
          }
          case B_FLASH: {
            const g = 1 + 1.5 * ease.outCubic(t);
            w = s * g;
            h = s * squash[i] * g;
            a *= smoothstep(0, 0.045, t) * u * u * u * u;
            rowT = ease.outQuad(t);
            break;
          }
          case B_STREAK: {
            w = s * (1 + 0.85 * t);
            h = s * squash[i] * (1 - 0.32 * t);
            a *= smoothstep(0, 0.03, t) * u * u * u;
            rowT = t;
            break;
          }
          case B_DEBRIS: {
            // Holds full strength while it tumbles, then goes in the last third:
            // a fragment does not dim as it flies, it leaves.
            a *= 1 - smoothstep(0.62, 1, t);
            rowT = smoothstep(0, 0.45, t);
            break;
          }
          case B_EMBER: {
            // Two incommensurate sines: the product never repeats on any short
            // window, so the flicker reads as combustion, not as a sine wave.
            const hz = flickerHz;
            const fl = 0.6 + 0.4 * Math.sin(time * hz + seed[i]) * Math.sin(time * hz * 0.61 + seed[i] * 1.7);
            const shrink = 1 - 0.42 * t;
            w = s * shrink;
            h = w;
            a *= smoothstep(0, 0.09, t) * u * (0.3 + 0.7 * u) * fl;
            rowT = ease.outQuad(t); // cools fast at first, then holds
            break;
          }
          case B_CONFETTI:
          case B_SHRED: {
            // 3D flip faked by oscillating the horizontal scale. The back face
            // is unlit, so it also loses two thirds of its brightness.
            const rate = b === B_CONFETTI ? 3 + (seed[i] % 4.2) : 1.9 + (seed[i] % 2.4);
            const c = Math.cos(time * rate + seed[i]);
            const face = Math.abs(c);
            w = s * (0.1 + 0.9 * face);
            h = s * squash[i];
            a *= (1 - smoothstep(0.78, 1, t)) * (c < 0 ? 0.42 : 1);
            rowT = t;
            break;
          }
          case B_SMOKE: {
            // Grows on a square-root curve: fast expansion at birth, then the
            // puff runs out of momentum exactly as a real one does.
            const g = 0.5 + 1.6 * Math.sqrt(t);
            w = s * g;
            h = s * squash[i] * g;
            a *= smoothstep(0, 0.15, t) * u * u * (0.4 + 0.6 * u);
            rowT = ease.outQuad(t); // warm to neutral, quickly
            break;
          }
          case B_DUST: {
            const g = 0.6 + 1.9 * Math.sqrt(t);
            w = s * g;
            h = s * squash[i] * g * 0.85;
            a *= smoothstep(0, 0.12, t) * u * u * (0.3 + 0.7 * u);
            rowT = t;
            break;
          }
          case B_SHARD: {
            a *= 1 - smoothstep(0.72, 1, t);
            rowT = smoothstep(0, 0.6, t);
            break;
          }
          case B_AMBIENT: {
            // A defocused disc a few pixels across has no readable orientation,
            // so skipping the rotation drops one matrix write per mote — and
            // ambient dust is the most numerous thing on screen.
            angle = 0;
            // Long fades at both ends so a re-seeded mote never pops in.
            a *= smoothstep(0, 0.1, t) * (1 - smoothstep(0.82, 1, t));
            // Each mote keeps its own tone for its whole life; a drifting hue
            // would read as an animated light rather than as dust.
            rowT = (seed[i] * 0.131) % 1;
            break;
          }
          case B_CROWD: {
            // A camera flash is a spike: instant rise, quintic fall. That shape
            // is what the bloom pass turns into a believable burst of light.
            w = s * (0.6 + 0.9 * ease.outCubic(t));
            h = w;
            angle = 0;
            a *= smoothstep(0, 0.07, t) * u * u * u * u * u;
            rowT = t;
            break;
          }
          case B_STATIC: {
            if ((flags[i] & F_JITTER) !== 0) {
              // Stateless re-roll every frame: sensor noise has no continuity,
              // so hashing (seed, frame) beats storing any per-particle state.
              const base = (seed[i] * 8191) | 0;
              const h1 = hash01(base ^ Math.imul(frame, 0x9e3779b1));
              const h2 = hash01(base ^ Math.imul(frame, 0x85ebca6b));
              const h3 = hash01(base ^ Math.imul(frame, 0xc2b2ae35));
              w = s * (0.5 + 1.1 * h1);
              h = s * (0.4 + 1.3 * h2);
              ox = (h2 - 0.5) * s * 5;
              oy = (h1 - 0.5) * s * 3;
              a *= h3 > 0.34 ? 1 : 0.22;
            }
            a *= 1 - smoothstep(0.72, 1, t);
            angle = 0;
            rowT = t;
            break;
          }
          default:
            break;
        }
      }

      if (a <= 0.004 || w <= 0.15 || h <= 0.15) continue;

      const r = ramps[ramp];
      if (!r) continue;
      if (r.image === null) {
        if (r.failed) continue;
        try {
          bakeRamp(r);
        } catch {
          // A bakery that cannot produce its source art must cost one dropped
          // effect, never a dropped frame.
          r.failed = true;
        }
        if (r.image === null) continue;
      }

      const row = Math.min(r.steps - 1, Math.max(0, Math.round(rowT * (r.steps - 1))));
      const cell = r.cellPx;
      const sx = Math.min(col, r.cols - 1) * cell;
      const sy = row * cell;

      ctx.globalAlpha = a > 1 ? 1 : a;
      const wx = px[i] + ox;
      const wy = py[i] + oy;

      if (angle !== 0 && !fastMatrix) {
        // No getTransform: the caller's matrix is unreadable, so compose in the
        // context itself rather than risk stamping particles in the wrong space.
        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(angle);
        ctx.drawImage(r.image, sx, sy, cell, cell, -w * 0.5, -h * 0.5, w, h);
        ctx.restore();
      } else if (angle !== 0) {
        // Compose base · translate(x,y) · rotate(θ) by hand: one setTransform
        // instead of a save/rotate/restore triple per particle, and no
        // DOMMatrix allocation. Scale rides in the drawImage extents.
        const c = Math.cos(angle);
        const sn = Math.sin(angle);
        const la = c;
        const lb = sn;
        const lc = -sn;
        const ld = c;
        ctx.setTransform(
          baseA * la + baseC * lb,
          baseB * la + baseD * lb,
          baseA * lc + baseC * ld,
          baseB * lc + baseD * ld,
          baseA * wx + baseC * wy + baseE,
          baseB * wx + baseD * wy + baseF,
        );
        matrixSet = true;
        ctx.drawImage(r.image, sx, sy, cell, cell, -w * 0.5, -h * 0.5, w, h);
      } else {
        if (matrixSet) {
          ctx.setTransform(baseA, baseB, baseC, baseD, baseE, baseF);
          matrixSet = false;
        }
        ctx.drawImage(r.image, sx, sy, cell, cell, wx - w * 0.5, wy - h * 0.5, w, h);
      }
    }

    if (matrixSet) ctx.setTransform(baseA, baseB, baseC, baseD, baseE, baseF);
  };

  const draw = (ctx: CanvasRenderingContext2D, layerName: "behind" | "front"): void => {
    if (count === 0) return;
    if (bucketsDirty) rebuildBuckets();
    const normalBk = layerName === "behind" ? BK_BEHIND_NORMAL : BK_FRONT_NORMAL;
    const addBk = layerName === "behind" ? BK_BEHIND_ADD : BK_FRONT_ADD;
    if (bucketCount[normalBk] === 0 && bucketCount[addBk] === 0) return;

    // Above 3 Hz counts as flashing; reduced motion drops the ember flicker to
    // a slow breath while keeping the same composition and brightness range.
    flickerHz = resolveReduced() ? 2.4 : 9.5;
    if (bucketCount[addBk] > 0) glintSlot = pickRamp("spark", "#ffffff", BONE);

    // The caller may have a camera transform live; capture it once so the
    // manual per-particle composition below lands in the right space.
    ctx.save();
    fastMatrix = typeof ctx.getTransform === "function";
    if (fastMatrix) {
      const m = ctx.getTransform();
      baseA = m.a;
      baseB = m.b;
      baseC = m.c;
      baseD = m.d;
      baseE = m.e;
      baseF = m.f;
    }

    // Normal first, additive on top: light always sits above matter.
    drawBucket(ctx, normalBk, "source-over");
    drawBucket(ctx, addBk, "lighter");

    ctx.restore();
  };

  return {
    emit,
    update,
    draw,
    clear(): void {
      count = 0;
      bucketsDirty = true;
    },
    get count(): number {
      return count;
    },
    get capacity(): number {
      return capacity;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Ribbon
 * ------------------------------------------------------------------ */

export function createRibbon(
  maxPoints = 44,
  options?: { spacing?: number; maxSpacing?: number; life?: number },
): Ribbon {
  const cap = Math.max(4, Math.round(maxPoints));
  const minSpacing = Math.max(0.5, options?.spacing ?? 2.2);
  const maxSpacing = Math.max(minSpacing + 0.5, options?.maxSpacing ?? 9);
  const pointLife = Math.max(0.05, options?.life ?? 0.42);

  const xs = new Float32Array(cap);
  const ys = new Float32Array(cap);
  const ages = new Float32Array(cap);
  // Offsets are rebuilt in place every draw; the ribbon never allocates.
  const lx = new Float32Array(cap);
  const ly = new Float32Array(cap);
  const rx = new Float32Array(cap);
  const ry = new Float32Array(cap);

  let start = 0;
  let n = 0;

  const at = (k: number): number => (start + k) % cap;

  const append = (x: number, y: number): void => {
    if (n === cap) {
      // Full: drop the oldest sample and reuse its slot.
      start = (start + 1) % cap;
      n--;
    }
    const i = (start + n) % cap;
    xs[i] = x;
    ys[i] = y;
    ages[i] = 0;
    n++;
  };

  return {
    push(x: number, y: number): void {
      if (n === 0) {
        append(x, y);
        return;
      }
      const last = at(n - 1);
      const dx = x - xs[last];
      const dy = y - ys[last];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minSpacing) {
        // Too slow to justify a new sample: slide the head instead, so the
        // ribbon stays glued to the emitter without bunching up points.
        xs[last] = x;
        ys[last] = y;
        return;
      }
      if (d > maxSpacing) {
        // Resample: a fast frame would otherwise leave a straight gap with no
        // intermediate ages, and the taper would jump instead of flowing.
        const steps = Math.min(cap - 1, Math.ceil(d / maxSpacing));
        const bx = xs[last];
        const by = ys[last];
        // Read before appending: a long insert can wrap the ring and overwrite
        // the slot this age came from.
        const baseAge = ages[last];
        for (let s = 1; s < steps; s++) {
          const f = s / steps;
          append(bx + dx * f, by + dy * f);
          // Interpolated samples inherit a proportional age so the tail fade
          // stays continuous across the inserted run.
          ages[at(n - 1)] = baseAge * (1 - f);
        }
      }
      append(x, y);
    },

    update(dt: number): void {
      if (!(dt > 0)) return;
      for (let k = 0; k < n; k++) ages[at(k)] += dt;
      // Retire from the tail; ages increase monotonically toward the tail, so a
      // single walk is enough.
      while (n > 0 && ages[start] > pointLife) {
        start = (start + 1) % cap;
        n--;
      }
    },

    draw(
      ctx: CanvasRenderingContext2D,
      opts: { width: number; color: string; fade?: number; additive?: boolean },
    ): void {
      if (n < 2) return;
      const width = Math.max(0.4, opts.width);
      const fade = clamp01(opts.fade ?? 0.85);
      const additive = opts.additive !== false;

      // Build the left/right offset polylines. The half-width tapers with
      // position along the ribbon *and* with sample age, so a trail narrows
      // toward its tail whether it is old or simply long.
      for (let k = 0; k < n; k++) {
        const i = at(k);
        const prev = at(k > 0 ? k - 1 : 0);
        const next = at(k < n - 1 ? k + 1 : n - 1);
        let tx = xs[next] - xs[prev];
        let ty = ys[next] - ys[prev];
        const len = Math.sqrt(tx * tx + ty * ty);
        if (len > 1e-4) {
          tx /= len;
          ty /= len;
        } else {
          tx = 1;
          ty = 0;
        }
        const s = k / (n - 1); // 0 = oldest, 1 = head
        const ageFade = 1 - clamp01(ages[i] / pointLife);
        // sqrt profile: wide most of the way, closing to a point at the tail —
        // a stroked line with a linear taper looks like a wedge, this does not.
        const hw = width * 0.5 * Math.sqrt(s) * (0.35 + 0.65 * ageFade);
        const nx = -ty * hw;
        const ny = tx * hw;
        lx[k] = xs[i] + nx;
        ly[k] = ys[i] + ny;
        rx[k] = xs[i] - nx;
        ry[k] = ys[i] - ny;
      }

      ctx.save();
      ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
      ctx.fillStyle = opts.color;

      // Alpha bands: each band is one quad strip filled at its own alpha, with
      // a one-segment overlap so the joins do not show. Six bands read as a
      // continuous ramp and cost six fills instead of one per segment.
      const bands = fade > 0.02 ? Math.min(6, n - 1) : 1;
      const tailAlpha = 1 - fade;
      for (let bnd = 0; bnd < bands; bnd++) {
        const i0 = Math.floor((bnd * (n - 1)) / bands);
        // One segment of overlap into the next band. Butt-jointed bands share an
        // edge at two different alphas, which shows as a hard step; overlapping
        // them lets the composite carry the transition instead.
        const over = bnd < bands - 1 ? 1 : 0;
        const i1 = Math.min(n - 1, Math.ceil(((bnd + 1) * (n - 1)) / bands) + over);
        if (i1 <= i0) continue;
        ctx.globalAlpha = clamp01(tailAlpha + fade * ((bnd + 0.5) / bands));
        traceStrip(ctx, lx, ly, rx, ry, i0, i1);
        ctx.fill();
      }

      if (additive) {
        // Hot core: a narrow, brighter strip inside the body. This is what makes
        // a trail read as emissive rather than as a painted stroke.
        for (let k = 0; k < n; k++) {
          const cxm = (lx[k] + rx[k]) * 0.5;
          const cym = (ly[k] + ry[k]) * 0.5;
          lx[k] = cxm + (lx[k] - cxm) * 0.34;
          ly[k] = cym + (ly[k] - cym) * 0.34;
          rx[k] = cxm + (rx[k] - cxm) * 0.34;
          ry[k] = cym + (ry[k] - cym) * 0.34;
        }
        ctx.fillStyle = cachedShade(opts.color, 0.62);
        ctx.globalAlpha = 0.85;
        traceStrip(ctx, lx, ly, rx, ry, 0, n - 1);
        ctx.fill();
      }

      ctx.restore();
    },

    clear(): void {
      start = 0;
      n = 0;
    },

    get length(): number {
      return n;
    },
  };
}

/**
 * Traces a closed quad strip: down the left offsets, back along the right ones.
 * Midpoint quadratics smooth the silhouette so a coarse polyline still reads as
 * a curve rather than a chain of facets.
 */
function traceStrip(
  ctx: CanvasRenderingContext2D,
  lx: Float32Array,
  ly: Float32Array,
  rx: Float32Array,
  ry: Float32Array,
  i0: number,
  i1: number,
): void {
  ctx.beginPath();
  ctx.moveTo(lx[i0], ly[i0]);
  for (let i = i0 + 1; i < i1; i++) {
    ctx.quadraticCurveTo(lx[i], ly[i], (lx[i] + lx[i + 1]) * 0.5, (ly[i] + ly[i + 1]) * 0.5);
  }
  ctx.lineTo(lx[i1], ly[i1]);
  ctx.lineTo(rx[i1], ry[i1]);
  for (let i = i1 - 1; i > i0; i--) {
    ctx.quadraticCurveTo(rx[i], ry[i], (rx[i] + rx[i - 1]) * 0.5, (ry[i] + ry[i - 1]) * 0.5);
  }
  ctx.lineTo(rx[i0], ry[i0]);
  ctx.closePath();
}

/* ------------------------------------------------------------------ *
 * Verlet rope
 * ------------------------------------------------------------------ */

export function createRope(x: number, y: number, segments: number, length: number): Rope {
  const segCount = Math.max(1, Math.round(segments));
  const n = segCount + 1;
  const segLen = Math.max(0.5, length / segCount);

  const points: { x: number; y: number; px: number; py: number; pinned: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const py = y + segLen * i;
    points.push({ x, y: py, px: x, py, pinned: i === 0 });
  }

  // Offset buffers for the tapered cable, allocated once.
  const lx = new Float32Array(n);
  const ly = new Float32Array(n);
  const rx = new Float32Array(n);
  const ry = new Float32Array(n);
  const hx = new Float32Array(n);
  const hy = new Float32Array(n);
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);

  let endPinned = false;
  let endX = points[n - 1].x;
  let endY = points[n - 1].y;
  let prevDt = 1 / 60;

  const solve = (iterations: number): void => {
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1e-6) continue;
        // Positional relaxation: distribute the length error between the two
        // ends, or push it entirely onto the free one if the other is pinned.
        const diff = (d - segLen) / d;
        if (a.pinned && b.pinned) continue;
        if (a.pinned) {
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else if (b.pinned) {
          a.x += dx * diff;
          a.y += dy * diff;
        } else {
          const hxs = dx * diff * 0.5;
          const hys = dy * diff * 0.5;
          a.x += hxs;
          a.y += hys;
          b.x -= hxs;
          b.y -= hys;
        }
      }
    }
  };

  return {
    points,

    update(dt: number, gravity: number, iterations = 3): void {
      if (!(dt > 0) || !Number.isFinite(dt)) return;
      const step = Math.min(dt, 0.05);
      // Time-corrected verlet: scaling the inherited step by dt/prevDt keeps the
      // rope's stiffness constant when the frame rate wobbles. Plain verlet
      // silently changes its damping with every hitch.
      const ratio = clamp(step / prevDt, 0.25, 4);
      const damping = 0.992;
      const g = gravity * step * step;

      if (endPinned) {
        const last = points[n - 1];
        last.x = endX;
        last.y = endY;
        last.pinned = true;
      }

      for (let i = 0; i < n; i++) {
        const p = points[i];
        if (p.pinned) {
          p.px = p.x;
          p.py = p.y;
          continue;
        }
        const vxi = (p.x - p.px) * damping * ratio;
        const vyi = (p.y - p.py) * damping * ratio;
        p.px = p.x;
        p.py = p.y;
        p.x += vxi;
        p.y += vyi + g;
      }

      solve(Math.max(1, Math.round(iterations)));
      prevDt = step;
    },

    setEnd(ex: number, ey: number): void {
      endPinned = true;
      endX = ex;
      endY = ey;
      const last = points[n - 1];
      // Carry the previous position with it, or a jump would inject a huge
      // verlet velocity and whip the whole cable.
      last.px += ex - last.x;
      last.py += ey - last.y;
      last.x = ex;
      last.y = ey;
      last.pinned = true;
    },

    draw(
      ctx: CanvasRenderingContext2D,
      opts: { width: number; color: string; highlight?: string },
    ): void {
      const width = Math.max(0.6, opts.width);
      for (let i = 0; i < n; i++) {
        const prev = points[i > 0 ? i - 1 : 0];
        const next = points[i < n - 1 ? i + 1 : n - 1];
        let tx = next.x - prev.x;
        let ty = next.y - prev.y;
        const len = Math.sqrt(tx * tx + ty * ty);
        if (len > 1e-4) {
          tx /= len;
          ty /= len;
        } else {
          tx = 0;
          ty = 1;
        }
        // Cables thin toward the free end: partly real (strain relief at the
        // anchor), mostly a depth cue that keeps the run from looking printed.
        const hw = width * 0.5 * (1 - 0.26 * (i / (n - 1)));
        const nx = -ty;
        const ny = tx;
        const p = points[i];
        lx[i] = p.x + nx * hw;
        ly[i] = p.y + ny * hw;
        rx[i] = p.x - nx * hw;
        ry[i] = p.y - ny * hw;
        // Specular run: a narrow strip offset toward the key side of the cable.
        const sOff = hw * 0.34;
        const sHw = Math.max(0.35, hw * 0.24);
        hx[i] = p.x + nx * (sOff + sHw);
        hy[i] = p.y + ny * (sOff + sHw);
        gx[i] = p.x + nx * (sOff - sHw);
        gy[i] = p.y + ny * (sOff - sHw);
      }

      ctx.save();
      // Body.
      ctx.fillStyle = opts.color;
      traceStrip(ctx, lx, ly, rx, ry, 0, n - 1);
      ctx.fill();

      // Occlusion on the shadow side: the underside of a round cable never
      // takes the key, and without it the run reads as a flat ribbon.
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = cachedShade(opts.color, -0.55);
      for (let i = 0; i < n; i++) {
        const mxs = (lx[i] + rx[i]) * 0.5;
        const mys = (ly[i] + ry[i]) * 0.5;
        lx[i] = mxs + (rx[i] - mxs) * 0.42;
        ly[i] = mys + (ry[i] - mys) * 0.42;
      }
      traceStrip(ctx, lx, ly, rx, ry, 0, n - 1);
      ctx.fill();

      // Specular highlight line, offset along the normal.
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = opts.highlight ?? cachedShade(opts.color, 0.5);
      traceStrip(ctx, hx, hy, gx, gy, 0, n - 1);
      ctx.fill();
      ctx.restore();
    },
  };
}
