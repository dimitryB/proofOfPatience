/**
 * POP — procedural texture bakery.
 *
 * Every surface, sprite and lens artefact in the game is generated here from
 * maths: no image files, no base64 photographs, no gradients standing in for
 * materials. Each tile is built from real signal (periodic gradient noise,
 * cellular aggregate fields, woven geometry, analytic BRDF shading) so that it
 * survives being magnified on a launch screenshot.
 *
 * Contracts honoured (see `lib/render/types.ts`):
 *  - `get(id)` bakes lazily on first call and caches forever.
 *  - `pattern(ctx, id, repeat)` caches per (context, id, repeat).
 *  - `size(id)` returns the *logical* pixel size of the texture. When the
 *    bakery is built at `scale > 1` the backing canvas is larger, and
 *    `pattern()` pre-applies a 1/scale matrix so tiles still repeat at their
 *    logical period. Callers therefore never need to know the bake scale.
 *  - `warm()` bakes everything up front.
 *
 * Hard rules honoured:
 *  - no `Math.random` (an injected `Rng` seeds a private, order-independent
 *    stream per texture, so lazy bake order can never change the output),
 *  - no `window`/`document` access at module scope (canvas creation is lazy and
 *    guarded, so the module imports cleanly during server rendering),
 *  - nothing allocates per frame — all cost is paid once, inside a bake.
 *
 * Seamlessness is guaranteed *by construction*, not by mirroring or blurring:
 *  - the noise lattice wraps modulo an integer period, so every field is
 *    exactly periodic over the tile;
 *  - the weave/twill cell counts divide the tile evenly;
 *  - drawn features (scratches, pits, motes, streaks) are re-drawn at the
 *    wrapped offsets whenever they touch an edge.
 */

import type { Noise, Rng, TextureBakery, TextureId } from "../render/types";

/* ------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Perlin's quintic fade — C2 continuous, which is what kills lattice banding. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Unit gaussian: exp(-(x/width)²). */
function bump(x: number, width: number): number {
  const t = x / width;
  return Math.exp(-t * t);
}

/**
 * exp(-(k·u + (1 - k)·u²)) with u = |x| / width.
 *
 * A pow-free stand-in for exp(-(|x|/width)^p): k = 0 is a gaussian (p = 2),
 * k = 1 is a pure exponential (p = 1), and k ≈ 2 - p matches the intermediate
 * shoulders closely (within ~0.01 alpha out to u = 3). Fractional `Math.pow`
 * costs roughly 40× a multiply, and these run tens of millions of times across
 * a full bake — the sprite shaders are entirely falloff maths.
 */
function softBump(x: number, width: number, k: number): number {
  const u = (x < 0 ? -x : x) / width;
  return Math.exp(-u * (k + (1 - k) * u));
}

/** exp(-(u² + k·u⁴)): shoulders sharper than a gaussian, for p > 2. */
function hardBump(x: number, width: number, k: number): number {
  const u = (x < 0 ? -x : x) / width;
  const u2 = u * u;
  return Math.exp(-u2 * (1 + k * u2));
}

/** x⁵ and x²² without `Math.pow`, for the specular lobes in the hot loops. */
function pow5(x: number): number {
  const a2 = x * x;
  return a2 * a2 * x;
}

function pow22(x: number): number {
  const a2 = x * x;
  const a4 = a2 * a2;
  const a8 = a4 * a4;
  return a8 * a8 * a4 * a2;
}

function pow80(x: number): number {
  const a2 = x * x;
  const a4 = a2 * a2;
  const a8 = a4 * a4;
  const a16 = a8 * a8;
  const a32 = a16 * a16;
  return a32 * a32 * a16;
}

/* ------------------------------------------------------------------ *
 * Deterministic randomness (private fallback — never Math.random)
 * ------------------------------------------------------------------ */

function mix32(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x165667b1) | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Integer hash → uint32. Used for lattice gradients and per-feature jitter. */
function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function hash01(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 4294967296;
}

/** mulberry32 — tiny, fast, good enough for texture jitter, fully seeded. */
function makeRng(seed: number): Rng {
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length) % items.length],
    fork: (salt = 0x2545f491) => makeRng(mix32(state, salt)),
  };
}

/* ------------------------------------------------------------------ *
 * Gradient noise
 * ------------------------------------------------------------------ */

const GRAD_COUNT = 256;
const GRAD_X = new Float32Array(GRAD_COUNT);
const GRAD_Y = new Float32Array(GRAD_COUNT);
for (let i = 0; i < GRAD_COUNT; i++) {
  // Golden-ratio stratified angles: even directional coverage, no axis bias.
  const a = ((i * 0.6180339887498949) % 1) * TAU;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/**
 * Accumulates one octave of *periodic* Perlin gradient noise into `dst`.
 *
 * `periodX`/`periodY` are the number of lattice cells across the tile. Because
 * lattice indices are taken modulo those integers, the resulting field is
 * exactly periodic over `size` pixels in both axes — the tile has no seam by
 * construction. Independent periods per axis give free anisotropy, which is how
 * brushed metal and carbon filaments get their stretch.
 *
 * The loop is cell-major: the four corner gradients are hashed once per lattice
 * cell instead of once per pixel, which is a large win for low frequencies.
 */
function addPeriodicPerlin(
  dst: Float32Array,
  size: number,
  periodX: number,
  periodY: number,
  seed: number,
  amp: number,
): void {
  const px = Math.max(2, Math.min(size, Math.round(periodX)));
  const py = Math.max(2, Math.min(size, Math.round(periodY)));
  const scaleX = px / size;
  const scaleY = py / size;

  for (let cy = 0; cy < py; cy++) {
    const yStart = Math.max(0, Math.ceil((cy * size) / py));
    const yEnd = Math.min(size, Math.ceil(((cy + 1) * size) / py));
    if (yStart >= yEnd) continue;
    const y0 = cy;
    const y1 = (cy + 1) % py;

    for (let cx = 0; cx < px; cx++) {
      const xStart = Math.max(0, Math.ceil((cx * size) / px));
      const xEnd = Math.min(size, Math.ceil(((cx + 1) * size) / px));
      if (xStart >= xEnd) continue;
      const x0 = cx;
      const x1 = (cx + 1) % px;

      const i00 = hash2i(x0, y0, seed) & 0xff;
      const i10 = hash2i(x1, y0, seed) & 0xff;
      const i01 = hash2i(x0, y1, seed) & 0xff;
      const i11 = hash2i(x1, y1, seed) & 0xff;
      const g00x = GRAD_X[i00];
      const g00y = GRAD_Y[i00];
      const g10x = GRAD_X[i10];
      const g10y = GRAD_Y[i10];
      const g01x = GRAD_X[i01];
      const g01y = GRAD_Y[i01];
      const g11x = GRAD_X[i11];
      const g11y = GRAD_Y[i11];

      for (let y = yStart; y < yEnd; y++) {
        const fy = clamp(y * scaleY - cy, 0, 1);
        const v = fade(fy);
        const row = y * size;
        for (let x = xStart; x < xEnd; x++) {
          const fx = clamp(x * scaleX - cx, 0, 1);
          const u = fade(fx);
          const n00 = g00x * fx + g00y * fy;
          const n10 = g10x * (fx - 1) + g10y * fy;
          const n01 = g01x * fx + g01y * (fy - 1);
          const n11 = g11x * (fx - 1) + g11y * (fy - 1);
          const a = n00 + u * (n10 - n00);
          const b = n01 + u * (n11 - n01);
          // 1.4142 renormalises 2D Perlin from ±0.707 back to ±1.
          dst[row + x] += amp * (a + v * (b - a)) * 1.4142135;
        }
      }
    }
  }
}

/** Isotropic periodic fbm over a tile, normalised to roughly [-1, 1]. */
function periodicFbm(
  size: number,
  basePeriod: number,
  octaves: number,
  seed: number,
  gain = 0.5,
  lacunarity = 2,
): Float32Array {
  const dst = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    if (period > size) break; // past Nyquist: further octaves are only aliasing
    addPeriodicPerlin(dst, size, period, period, mix32(seed, o * 7919 + 13), amp);
    norm += amp;
    amp *= gain;
    period *= lacunarity;
  }
  if (norm > 0) {
    const inv = 1 / norm;
    for (let i = 0; i < dst.length; i++) dst[i] *= inv;
  }
  return dst;
}

/** Anisotropic periodic fbm: separate cell counts per axis, doubled per octave. */
function periodicFbmAniso(
  size: number,
  periodX: number,
  periodY: number,
  octaves: number,
  seed: number,
  gain = 0.5,
): Float32Array {
  const dst = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  let px = periodX;
  let py = periodY;
  for (let o = 0; o < octaves; o++) {
    addPeriodicPerlin(dst, size, px, py, mix32(seed, o * 6151 + 29), amp);
    norm += amp;
    amp *= gain;
    px *= 2;
    py *= 2;
    if (px > size && py > size) break;
  }
  if (norm > 0) {
    const inv = 1 / norm;
    for (let i = 0; i < dst.length; i++) dst[i] *= inv;
  }
  return dst;
}

/** Non-periodic scalar Perlin, for sprites where tiling is irrelevant. */
function perlin2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = hash2i(x0, y0, seed) & 0xff;
  const i10 = hash2i(x0 + 1, y0, seed) & 0xff;
  const i01 = hash2i(x0, y0 + 1, seed) & 0xff;
  const i11 = hash2i(x0 + 1, y0 + 1, seed) & 0xff;
  const n00 = GRAD_X[i00] * fx + GRAD_Y[i00] * fy;
  const n10 = GRAD_X[i10] * (fx - 1) + GRAD_Y[i10] * fy;
  const n01 = GRAD_X[i01] * fx + GRAD_Y[i01] * (fy - 1);
  const n11 = GRAD_X[i11] * (fx - 1) + GRAD_Y[i11] * (fy - 1);
  const u = fade(fx);
  const v = fade(fy);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.4142135;
}

/**
 * The slice of `Noise` this module consumes. Sprites want organic, non-tiling
 * turbulence; the injected engine noise is used when present so the whole game
 * shares one noise character, otherwise the private fallback below is used.
 */
interface OrganicNoise {
  fbm2(x: number, y: number, octaves?: number): number;
  ridged2(x: number, y: number, octaves?: number): number;
}

const FALLBACK_NOISE: OrganicNoise = {
  fbm2(x: number, y: number, octaves = 4): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      sum += perlin2(x * freq, y * freq, 0x51ed + o * 977) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return norm > 0 ? sum / norm : 0;
  },
  ridged2(x: number, y: number, octaves = 4): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(perlin2(x * freq, y * freq, 0x2b17 + o * 613));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return norm > 0 ? clamp01(sum / norm) : 0;
  },
};

/**
 * Periodic cellular (Worley F1) field, used for concrete aggregate.
 * Returns the F1 distance in *cell* units plus the id of the owning cell so the
 * caller can give every stone its own tone.
 */
interface CellularField {
  f1: Float32Array;
  owner: Int32Array;
}

/**
 * Stepped `periodicCellular`: identical output, suspended after each row of
 * cells. A 256px field with 34 cells is ~590k distance evaluations, which is
 * five frames' worth of budget in one call — far too coarse an atom for a boot
 * that is supposed to be invisible.
 */
function* periodicCellularStepped(
  size: number,
  cells: number,
  seed: number,
  out: { field: CellularField | null },
): TextureJob {
  const built = periodicCellularInit(size, cells, seed);
  for (const _ of built.rows) {
    void _;
    yield;
  }
  out.field = built.field;
}

function periodicCellular(size: number, cells: number, seed: number): CellularField {
  const built = periodicCellularInit(size, cells, seed);
  for (const _ of built.rows) void _;
  return built.field;
}

/**
 * Shared body. `rows` is a lazy iterable: pulling one entry computes one row of
 * cells, so the same code serves the blocking and the suspendable callers.
 */
function periodicCellularInit(
  size: number,
  cells: number,
  seed: number,
): { field: CellularField; rows: Iterable<void> } {
  const field = periodicCellularAlloc(size);
  return { field, rows: periodicCellularRows(size, cells, seed, field) };
}

function periodicCellularAlloc(size: number): CellularField {
  return { f1: new Float32Array(size * size), owner: new Int32Array(size * size) };
}

function* periodicCellularRows(
  size: number,
  cells: number,
  seed: number,
  field: CellularField,
): Generator<void, void, void> {
  const cellPx = size / cells;
  const count = cells * cells;
  const ptX = new Float32Array(count);
  const ptY = new Float32Array(count);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const k = j * cells + i;
      ptX[k] = (i + 0.16 + 0.68 * hash01(i, j, seed)) * cellPx;
      ptY[k] = (j + 0.16 + 0.68 * hash01(i, j, seed ^ 0x51a3)) * cellPx;
    }
  }

  const f1 = field.f1;
  const owner = field.owner;
  const invCell = 1 / cellPx;
  // Cell-major, exactly like the Perlin fill: the nine wrapped candidate points
  // are gathered once per cell instead of once per pixel, which removes ~20
  // modulo/branch operations from every pixel of a 512² field.
  const candX = new Float64Array(9);
  const candY = new Float64Array(9);
  const candId = new Int32Array(9);

  for (let cj = 0; cj < cells; cj++) {
    const yStart = Math.max(0, Math.ceil((cj * size) / cells));
    const yEnd = Math.min(size, Math.ceil(((cj + 1) * size) / cells));
    if (yStart >= yEnd) continue;

    for (let ci = 0; ci < cells; ci++) {
      const xStart = Math.max(0, Math.ceil((ci * size) / cells));
      const xEnd = Math.min(size, Math.ceil(((ci + 1) * size) / cells));
      if (xStart >= xEnd) continue;

      let c = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const rawJ = cj + dj;
        const nj = (rawJ + cells) % cells;
        const offY = rawJ < 0 ? -size : rawJ >= cells ? size : 0;
        for (let di = -1; di <= 1; di++) {
          const rawI = ci + di;
          const ni = (rawI + cells) % cells;
          const offX = rawI < 0 ? -size : rawI >= cells ? size : 0;
          const k = nj * cells + ni;
          candX[c] = ptX[k] + offX;
          candY[c] = ptY[k] + offY;
          candId[c] = k;
          c++;
        }
      }

      for (let y = yStart; y < yEnd; y++) {
        const row = y * size;
        for (let x = xStart; x < xEnd; x++) {
          let best = Infinity;
          let bestId = 0;
          for (let m = 0; m < 9; m++) {
            const dx = candX[m] - x;
            const dy = candY[m] - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) {
              best = d2;
              bestId = candId[m];
            }
          }
          f1[row + x] = Math.sqrt(best) * invCell;
          owner[row + x] = bestId;
        }
      }
    }
    yield;
  }
}

/* ------------------------------------------------------------------ *
 * Canvas surfaces (lazy — nothing here runs at module scope)
 * ------------------------------------------------------------------ */

interface Surface {
  /** Usable as a drawImage / createPattern source. */
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  /** Device pixels on a side. */
  px: number;
  /** Logical (design) pixels on a side. */
  logical: number;
  /** px / logical. */
  k: number;
}

function createSurface(logical: number, k: number): Surface {
  const px = Math.max(4, Math.round(logical * k));

  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(px, px);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("pop/textures: OffscreenCanvas 2D context unavailable");
    // The two 2D context interfaces are API-identical for everything used here;
    // the cast keeps a single code path instead of a union that TS cannot call.
    return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D, px, logical, k: px / logical };
  }

  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("pop/textures: 2D context unavailable");
    return { canvas, ctx, px, logical, k: px / logical };
  }

  throw new Error("pop/textures: no OffscreenCanvas and no DOM — bake in the browser");
}

/**
 * A bake in progress. Yielding between phases is what lets the boot pump spend
 * a few milliseconds per frame on a texture instead of one long block: a 512px
 * tile is four noise fields, a quarter of a million shader invocations and a few
 * hundred vector strokes, and any one of those phases is already more than a
 * frame's budget on a slow machine.
 */
type TextureJob = Generator<void, void, void>;

/**
 * `paintPixels`, but yielding every `bands` rows so the caller can stop between
 * bands. The ImageData is written once at the end, so a half-finished bake never
 * reaches the canvas — the texture appears complete or not at all.
 */
function* paintPixelsStepped(
  surface: Surface,
  bands: number,
  shade: (x: number, y: number, index: number, out: Float32Array) => void,
): TextureJob {
  const { ctx, px } = surface;
  const image = ctx.createImageData(px, px);
  const data = image.data;
  const out = new Float32Array(4);
  const rows = Math.max(1, Math.ceil(px / Math.max(1, bands)));
  for (let y0 = 0; y0 < px; y0 += rows) {
    const y1 = Math.min(px, y0 + rows);
    let p = y0 * px * 4;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < px; x++) {
        out[0] = 1;
        out[1] = 1;
        out[2] = 1;
        out[3] = 1;
        shade(x, y, y * px + x, out);
        data[p] = out[0] * 255;
        data[p + 1] = out[1] * 255;
        data[p + 2] = out[2] * 255;
        data[p + 3] = out[3] * 255;
        p += 4;
      }
    }
    if (y1 < px) yield;
  }
  ctx.putImageData(image, 0, 0);
}

/** Writes a full-surface RGBA image from a per-pixel shader. `out` is r,g,b,a in 0..1. */
function paintPixels(
  surface: Surface,
  shade: (x: number, y: number, index: number, out: Float32Array) => void,
): void {
  const { ctx, px } = surface;
  const image = ctx.createImageData(px, px);
  const data = image.data;
  const out = new Float32Array(4);
  let p = 0;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      out[0] = 1;
      out[1] = 1;
      out[2] = 1;
      out[3] = 1;
      shade(x, y, y * px + x, out);
      data[p] = out[0] * 255;
      data[p + 1] = out[1] * 255;
      data[p + 2] = out[2] * 255;
      data[p + 3] = out[3] * 255;
      p += 4;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Sprite shader helper. `nx`/`ny` run over (-1, 1) with 0 at the sprite centre,
 * so every sprite is authored in a resolution-independent unit square.
 */
function paintSprite(
  surface: Surface,
  shade: (nx: number, ny: number, out: Float32Array) => void,
): void {
  const inv = 2 / surface.px;
  paintPixels(surface, (x, y, _i, out) => {
    shade((x + 0.5) * inv - 1, (y + 0.5) * inv - 1, out);
  });
}

/**
 * Repeats a drawing callback at wrapped offsets so a feature that overhangs the
 * tile edge reappears on the opposite side. `extent` is the feature's radius in
 * logical units; features wider than half the tile get the full 3×3 sweep.
 */
function wrapDraw(
  size: number,
  x: number,
  y: number,
  extent: number,
  draw: (offsetX: number, offsetY: number) => void,
): void {
  if (extent > size * 0.5) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) draw(dx * size, dy * size);
    return;
  }
  const sx = x - extent < 0 ? 1 : x + extent > size ? -1 : 0;
  const sy = y - extent < 0 ? 1 : y + extent > size ? -1 : 0;
  draw(0, 0);
  if (sx !== 0) draw(sx * size, 0);
  if (sy !== 0) draw(0, sy * size);
  if (sx !== 0 && sy !== 0) draw(sx * size, sy * size);
}

/** Switches the context into logical units so drawn features respect bake scale. */
function applyLogicalUnits(surface: Surface): void {
  surface.ctx.setTransform(surface.k, 0, 0, surface.k, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Shared lighting constants — one motivated key for every material
 * ------------------------------------------------------------------ */

// Key light: high, camera-left, slightly behind — the studio rig.
const LX = -0.3218;
const LY = -0.7728;
const LZ = 0.5477;
// Half vector between the key and a head-on viewer (0,0,1).
const HX = -0.2091;
const HY = -0.5021;
const HZ = 0.8391;

/* ------------------------------------------------------------------ *
 * Tiles
 * ------------------------------------------------------------------ */

/**
 * noise-fine — 256px film grain.
 *
 * Uniform white noise looks like TV static, not film. Real grain is (a) roughly
 * gaussian, because a pixel integrates many silver crystals, and (b) spatially
 * correlated over one or two pixels, because crystals have size. So: four
 * independent uniform hashes are summed (Irwin–Hall → near-gaussian), the field
 * is wrapped-blurred with a binomial kernel to give it a correlation length,
 * a coarse octave adds clumping, and the result is renormalised to a measured
 * standard deviation. Mid-grey 128 is neutral: draw with "overlay"/"soft-light".
 */
function* bakeNoiseFine(surface: Surface, rng: Rng): TextureJob {
  const S = surface.px;
  const seed = rng.int(0, 0x7fffffff);
  const n = S * S;
  const raw = new Float32Array(n);

  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      const a = hash01(x, y, seed);
      const b = hash01(x, y, seed ^ 0x1f83d9ab);
      const c = hash01(x, y, seed ^ 0x5be0cd19);
      const d = hash01(x, y, seed ^ 0x9b05688c);
      raw[row + x] = (a + b + c + d) * 0.25;
    }
  }

  // Wrapped 3×3 binomial blur (separable): gives grain a believable clump size
  // without softening it into mush. 60% blurred / 40% raw keeps the bite.
  const tmp = new Float32Array(n);
  const blurred = new Float32Array(n);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      const l = raw[row + ((x - 1 + S) % S)];
      const r = raw[row + ((x + 1) % S)];
      tmp[row + x] = (l + raw[row + x] * 2 + r) * 0.25;
    }
  }
  for (let y = 0; y < S; y++) {
    const up = ((y - 1 + S) % S) * S;
    const dn = ((y + 1) % S) * S;
    const row = y * S;
    for (let x = 0; x < S; x++) {
      blurred[row + x] = (tmp[up + x] + tmp[row + x] * 2 + tmp[dn + x]) * 0.25;
    }
  }

  // Coarse clumping octave — grain density is not uniform across a frame.
  const clump = periodicFbm(S, 24, 3, mix32(seed, 0x71), 0.55);
  yield;

  let mean = 0;
  for (let i = 0; i < n; i++) {
    raw[i] = lerp(raw[i], blurred[i], 0.6) + clump[i] * 0.045;
    mean += raw[i];
  }
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = raw[i] - mean;
    variance += d * d;
  }
  const sd = Math.sqrt(variance / n) || 1e-6;
  // Target σ ≈ 0.082 → roughly ±21 levels at 1σ, which reads as 400-800 ISO.
  const gain = 0.082 / sd;

  yield* paintPixelsStepped(surface, 4, (_x, _y, i, out) => {
    const v = clamp01(0.5 + (raw[i] - mean) * gain);
    out[0] = v;
    out[1] = v;
    out[2] = v;
    out[3] = 1;
  });
}

/**
 * noise-coarse — 512px fbm cloud field with soft contrast.
 * Six octaves of periodic gradient noise, then a gentle S-curve blended back
 * against the linear field so mid-tones stay usable as a mask.
 */
function bakeNoiseCoarse(surface: Surface, rng: Rng): void {
  const S = surface.px;
  const seed = rng.int(0, 0x7fffffff);
  const field = periodicFbm(S, 4, 6, seed, 0.52);

  paintPixels(surface, (_x, _y, i, out) => {
    const linear = clamp01(0.5 + field[i] * 0.62);
    const shaped = smoothstep(0.14, 0.86, linear);
    const v = lerp(linear, shaped, 0.62);
    out[0] = v;
    out[1] = v;
    out[2] = v;
    out[3] = 1;
  });
}

/**
 * grunge — 512px layered scuff, dust and smudge, alpha-carrying.
 *
 * Four signal layers (broad grime, mid dust, grit speckle, an occlusion mask)
 * then hand-placed wipe streaks and smears. Colour ramps from deep grime to
 * pale dust so the tile works both as a source-over dirt pass and as a multiply.
 */
function* bakeGrunge(surface: Surface, rng: Rng): TextureJob {
  const S = surface.px;
  const seed = rng.int(0, 0x7fffffff);

  // Base periods are deliberately not tiny: a 512 tile whose dominant feature
  // is 200 px across announces its own repeat the moment it covers a wall.
  const broad = periodicFbm(S, 6, 4, mix32(seed, 1), 0.55);
  const mid = periodicFbm(S, 17, 4, mix32(seed, 2), 0.5);
  yield;
  const grit = periodicFbm(S, 150, 2, mix32(seed, 3), 0.6);
  const mask = periodicFbm(S, 4, 3, mix32(seed, 4), 0.5);
  yield;
  const speckSeed = mix32(seed, 5);

  yield* paintPixelsStepped(surface, 6, (x, y, i, out) => {
    // fbm lands near ±0.35 rms, so these gains put every layer across a full
    // 0..1 span before the smoothsteps select from it — thresholds tuned to
    // the actual distribution rather than an assumed one.
    const b = clamp01(0.5 + broad[i] * 0.95);
    const m = clamp01(0.5 + mid[i] * 1.05);
    const g = clamp01(0.5 + grit[i] * 1.25);
    const coverage = clamp01(0.52 + mask[i] * 1.15);

    // Grime pools in the low-frequency valleys; dust settles on the ridges;
    // grit is the sharp high-frequency residue that survives a wipe.
    const grime = smoothstep(0.22, 0.72, b) * smoothstep(0.10, 0.62, m);
    const dust = smoothstep(0.40, 0.88, m * 0.55 + g * 0.60);
    const speck = smoothstep(0.58, 0.90, g);
    const pepper = smoothstep(0.965, 1.0, hash01(x, y, speckSeed)) * 0.8;

    const alpha = clamp01((grime * 0.62 + dust * 0.44 + speck * 0.24 + pepper) * coverage);
    const dustness = clamp01(dust * 0.85 + speck * 0.65 + pepper - grime * 0.35);

    out[0] = lerp(0.070, 0.470, dustness);
    out[1] = lerp(0.058, 0.428, dustness);
    out[2] = lerp(0.048, 0.384, dustness);
    out[3] = alpha;
  });

  // --- drawn layer: wipe streaks and smears -------------------------------
  const ctx = surface.ctx;
  const L = surface.logical;
  applyLogicalUnits(surface);
  ctx.globalCompositeOperation = "source-over";

  // Long directional scuffs — someone dragged a case across this surface.
  for (let s = 0; s < 46; s++) {
    const x = rng.range(0, L);
    const y = rng.range(0, L);
    const angle = rng.range(-0.42, 0.42) + (rng.next() < 0.3 ? Math.PI * 0.5 : 0);
    const len = rng.range(L * 0.18, L * 0.72);
    const thick = rng.range(0.7, 3.4);
    const dark = rng.next() < 0.62;
    const alpha = rng.range(0.05, dark ? 0.26 : 0.15);
    const grad = ctx.createLinearGradient(0, 0, len, 0);
    const body = dark ? "40,34,29" : "150,140,130";
    grad.addColorStop(0, `rgba(${body},0)`);
    grad.addColorStop(rng.range(0.16, 0.34), `rgba(${body},${alpha.toFixed(3)})`);
    grad.addColorStop(rng.range(0.6, 0.82), `rgba(${body},${(alpha * 0.72).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${body},0)`);

    wrapDraw(L, x, y, len, (ox, oy) => {
      ctx.save();
      ctx.translate(x + ox, y + oy);
      ctx.rotate(angle);
      ctx.fillStyle = grad;
      // Slight bow: three overlapping tapered bands instead of one flat rect.
      for (let k = -1; k <= 1; k++) {
        ctx.globalAlpha = k === 0 ? 1 : 0.45;
        ctx.fillRect(0, k * thick * 0.55 - thick * 0.5, len, thick);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    });
  }

  // Soft smears — a cloth wiped across, leaving a halo of redistributed dust.
  for (let s = 0; s < 14; s++) {
    const x = rng.range(0, L);
    const y = rng.range(0, L);
    const rx = rng.range(L * 0.09, L * 0.26);
    const ry = rx * rng.range(0.14, 0.42);
    const angle = rng.range(0, Math.PI);
    const alpha = rng.range(0.035, 0.11);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, `rgba(126,116,106,${alpha.toFixed(3)})`);
    grad.addColorStop(0.55, `rgba(110,101,92,${(alpha * 0.5).toFixed(3)})`);
    grad.addColorStop(1, "rgba(96,88,80,0)");

    wrapDraw(L, x, y, rx, (ox, oy) => {
      ctx.save();
      ctx.translate(x + ox, y + oy);
      ctx.rotate(angle);
      ctx.scale(rx, ry);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, TAU);
      ctx.fill();
      ctx.restore();
    });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * brushed-metal — 512px anisotropic brushed aluminium.
 *
 * The material is modelled, not painted. A height field made of three heavily
 * X-stretched noise octaves stands in for the brush grooves; the surface normal
 * is taken from its Y derivative (grooves only tilt across the brush direction)
 * and shaded with a Blinn-Phong lobe. That produces the real cue: each groove
 * has a lit lip and a dark bed, and the highlight smears along X. Broad sheen
 * banding comes from integer-wavenumber cosines so it still tiles.
 */
function* bakeBrushedMetal(surface: Surface, rng: Rng): TextureJob {
  const S = surface.px;
  const seed = rng.int(0, 0x7fffffff);
  const n = S * S;

  // Height: strongly anisotropic. periodX small (long features), periodY large.
  // The finest octave stays at ~3 px per lattice cell; pushing it to Nyquist
  // turns the derivative shading into salt-and-pepper rather than brushing.
  // Aspect ratios of 30:1 to 50:1 between the axes. A belt sands in almost
  // perfectly straight lines; at 15:1 the grooves visibly undulate and the
  // panel reads as wood grain instead of metal.
  const height = new Float32Array(n);
  addPeriodicPerlin(height, S, 2, 88, mix32(seed, 11), 0.34);
  addPeriodicPerlin(height, S, 3, 150, mix32(seed, 12), 0.22);
  addPeriodicPerlin(height, S, 5, 212, mix32(seed, 13), 0.11);
  addPeriodicPerlin(height, S, 2, 40, mix32(seed, 14), 0.22);

  // Where the brush bit harder. Slow, mostly-horizontal variation.
  const bite = periodicFbmAniso(S, 2, 9, 3, mix32(seed, 15), 0.55);
  // Large tonal drift from the rolling process.
  const drift = periodicFbm(S, 3, 3, mix32(seed, 16), 0.5);
  yield;

  yield* paintPixelsStepped(surface, 6, (x, y, i, out) => {
    const up = ((y - 1 + S) % S) * S + x;
    const dn = ((y + 1) % S) * S + x;
    const lf = y * S + ((x - 1 + S) % S);
    const rt = y * S + ((x + 1) % S);

    const biteAmt = 0.55 + 0.55 * clamp01(0.5 + bite[i] * 0.8);
    // Central differences → surface slope. Y slope dominates by ~6:1 because
    // the grooves run along X. The gains are deliberately modest: aluminium is
    // a shallow satin finish, not a file-scored surface.
    // The gains stay low on purpose: 150 discrete hairline grooves are stroked
    // over this base afterwards, and a loud base plus loud grooves reads as
    // hair, not satin.
    const dy = (height[dn] - height[up]) * 3.1 * biteAmt;
    const dx = (height[rt] - height[lf]) * 0.68 * biteAmt;

    const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
    const nx = -dx * inv;
    const ny = -dy * inv;
    const nz = inv;

    const diffuse = Math.max(0, nx * LX + ny * LY + nz * LZ);
    const ndoth = Math.max(0, nx * HX + ny * HY + nz * HZ);
    const spec = pow22(ndoth);
    // Second, much wider lobe: aluminium is not a mirror, it is a smear.
    const sheenLobe = pow5(ndoth);

    const v = (y + 0.5) / S;
    // Integer wavenumbers keep the banding seamless across the tile.
    const band =
      0.5 + 0.30 * Math.cos(TAU * v + 0.7) + 0.14 * Math.cos(TAU * 3 * v - 1.9) + 0.07 * Math.cos(TAU * 5 * v + 0.3);

    // Aluminium sits around 55% reflectance; the ambient term carries most of
    // it so the brushing modulates a bright panel rather than lifting a dark one.
    let lum = 0.235 + 0.300 * diffuse + 0.430 * sheenLobe + 0.34 * spec;
    lum *= 0.90 + 0.19 * band;
    lum += drift[i] * 0.036;
    lum = clamp01(lum);

    // Aluminium under tungsten: neutral with the faintest warm bias.
    out[0] = clamp01(lum * 1.02 + 0.004);
    out[1] = clamp01(lum * 0.988);
    out[2] = clamp01(lum * 0.952);
    out[3] = 1;
  });

  // --- discrete micro-scratches ------------------------------------------
  const ctx = surface.ctx;
  const L = surface.logical;
  applyLogicalUnits(surface);
  ctx.lineCap = "butt";

  // Each scratch is a groove: a dark bed with a lit lip one pixel above, which
  // is what actually sells "machined" at 100% zoom.
  for (let s = 0; s < 150; s++) {
    const y = rng.range(0, L);
    const amp = rng.range(0.4, 3.2);
    const waves = rng.int(1, 3); // integer wavenumber ⇒ wraps in X
    const phase = rng.range(0, TAU);
    const width = rng.range(0.35, 1.5);
    const strength = rng.range(0.05, 0.34);
    const segments = 46;

    for (let pass = 0; pass < 2; pass++) {
      const lip = pass === 0 ? 0 : -Math.max(0.5, width * 0.8);
      ctx.strokeStyle =
        pass === 0
          ? `rgba(24,20,17,${(strength * 0.9).toFixed(3)})`
          : `rgba(255,247,238,${(strength * 0.75).toFixed(3)})`;
      ctx.lineWidth = pass === 0 ? width : width * 0.65;
      for (let dy = -1; dy <= 1; dy++) {
        ctx.beginPath();
        for (let k = 0; k <= segments; k++) {
          const t = k / segments;
          const px = t * L;
          const py = y + dy * L + lip + Math.sin(TAU * waves * t + phase) * amp;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  }

  // A handful of deeper gouges with visible entry and exit taper.
  for (let s = 0; s < 9; s++) {
    const y = rng.range(0, L);
    const x0 = rng.range(0, L);
    const len = rng.range(L * 0.2, L * 0.55);
    const slope = rng.range(-0.05, 0.05);
    const grad = ctx.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, "rgba(18,15,13,0)");
    grad.addColorStop(0.4, "rgba(18,15,13,0.42)");
    grad.addColorStop(1, "rgba(18,15,13,0)");
    wrapDraw(L, x0, y, len, (ox, oy) => {
      ctx.save();
      ctx.translate(x0 + ox, y + oy);
      ctx.rotate(slope);
      ctx.fillStyle = grad;
      ctx.fillRect(0, -0.9, len, 1.8);
      ctx.fillStyle = "rgba(255,246,236,0.22)";
      ctx.fillRect(len * 0.1, -1.7, len * 0.8, 0.7);
      ctx.restore();
    });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * concrete — 512px polished studio floor.
 *
 * Aggregate is a periodic Worley field: each cell owns one stone with its own
 * radius and tone, which is what makes polished concrete read as *ground* stone
 * rather than noise. On top: faint pour/trowel drift (very stretched noise),
 * broad polish sheen, fine cement speckle, then drawn micro-pits — each pit a
 * dark disc with a lit crescent on the key-light side.
 */
function* bakeConcrete(surface: Surface, rng: Rng): TextureJob {
  const S = surface.px;
  const seed = rng.int(0, 0x7fffffff);
  const cells = 34;
  const held: { field: CellularField | null } = { field: null };
  yield* periodicCellularStepped(S, cells, mix32(seed, 21), held);
  const { f1, owner } = held.field ?? periodicCellularAlloc(S);

  const pour = periodicFbmAniso(S, 2, 7, 3, mix32(seed, 22), 0.5);
  yield;
  const trowel = periodicFbmAniso(S, 3, 40, 2, mix32(seed, 23), 0.5);
  yield;
  const mottle = periodicFbm(S, 20, 4, mix32(seed, 24), 0.5);
  yield;
  const cement = periodicFbm(S, 170, 2, mix32(seed, 25), 0.6);
  yield;

  yield* paintPixelsStepped(surface, 6, (x, y, i, out) => {
    const id = owner[i];
    // Wide radius spread: polished concrete shows everything from sand to
    // 8 mm aggregate in the same cut plane.
    const radius = 0.13 + 0.36 * hash01(id, 7, seed);
    const tone = (hash01(id, 11, seed) - 0.45) * 0.34;
    // Perturbing the cell distance breaks the perfect circles into crushed,
    // angular stone outlines. Free — it reuses a field already computed. Only
    // the fine octave is used: a coarse one would switch whole regions of
    // aggregate on and off instead of crinkling each outline.
    const d = f1[i] + cement[i] * 0.095;

    // Stone body with a soft edge; the dome term gives each aggregate grain a
    // lit top so the floor reads as ground-and-polished, not printed.
    const inside = 1 - smoothstep(radius * 0.70, radius, d);
    const dome = Math.sqrt(Math.max(0, 1 - (d / Math.max(radius, 1e-4)) ** 2));
    const domeLight = inside * (0.35 + 0.65 * dome) * 0.11;
    // Ground stones sit slightly proud, so each keeps a thin dark contact line.
    const seat = smoothstep(radius, radius * 1.16, d) * (1 - smoothstep(radius * 1.16, radius * 1.4, d));

    let lum = 0.40;
    lum += inside * tone;
    lum += domeLight;
    lum -= seat * 0.045;
    lum += pour[i] * 0.055;
    lum += trowel[i] * 0.022;
    lum += mottle[i] * 0.030;
    lum += cement[i] * 0.026;
    // Fine cement dust between the aggregate.
    lum += (hash01(x, y, seed) - 0.5) * 0.030;

    // Broad polish sheen: integer wavenumbers, so it tiles. Kept faint — a
    // strong diagonal here reads as a lighting mistake once the tile repeats.
    const u = (x + 0.5) / S;
    const v = (y + 0.5) / S;
    const sheen = 0.5 + 0.5 * Math.cos(TAU * (u - v) + 1.1);
    lum += sheen * 0.013;

    lum = clamp01(lum);
    // Warm neutral: sealed concrete under tungsten pulls slightly amber.
    out[0] = clamp01(lum * 1.035);
    out[1] = clamp01(lum * 0.985);
    out[2] = clamp01(lum * 0.928);
    out[3] = 1;
  });

  // --- micro-pitting ------------------------------------------------------
  const ctx = surface.ctx;
  const L = surface.logical;
  applyLogicalUnits(surface);

  for (let p = 0; p < 460; p++) {
    const x = rng.range(0, L);
    const y = rng.range(0, L);
    const r = rng.range(0.35, 1.7);
    const deep = rng.next() < 0.35;
    wrapDraw(L, x, y, r + 1.5, (ox, oy) => {
      ctx.fillStyle = deep ? "rgba(12,10,9,0.55)" : "rgba(22,19,16,0.30)";
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, TAU);
      ctx.fill();
      if (deep) {
        // Lit crescent on the key side (upper-left).
        ctx.strokeStyle = "rgba(236,228,219,0.30)";
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r * 0.92, Math.PI * 0.75, Math.PI * 1.75);
        ctx.stroke();
      }
    });
  }

  // Rare hairline crazing. The wandering path is generated once, then stamped
  // at every wrap offset, so the crack survives the tile edge intact.
  for (let c = 0; c < 7; c++) {
    const path: number[] = [];
    let cx = rng.range(0, L);
    let cy = rng.range(0, L);
    let ca = rng.range(0, TAU);
    path.push(cx, cy);
    const steps = rng.int(14, 30);
    for (let k = 0; k < steps; k++) {
      ca += rng.range(-0.38, 0.38);
      cx += Math.cos(ca) * rng.range(3, 7);
      cy += Math.sin(ca) * rng.range(3, 7);
      path.push(cx, cy);
    }
    ctx.strokeStyle = `rgba(16,13,11,${rng.range(0.12, 0.28).toFixed(3)})`;
    ctx.lineWidth = rng.range(0.3, 0.7);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        ctx.beginPath();
        ctx.moveTo(path[0] + dx * L, path[1] + dy * L);
        for (let k = 2; k < path.length; k += 2) {
          ctx.lineTo(path[k] + dx * L, path[k + 1] + dy * L);
        }
        ctx.stroke();
      }
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * acoustic-fabric — 256px woven acoustic panel.
 *
 * Real plain weave: warp (vertical) and weft (horizontal) threads alternate
 * over and under on a checkerboard, `((i + j) & 1)`. Each visible thread is
 * shaded as a half-cylinder — normal (a, 0, sqrt(1-a²)) across its width — so
 * it catches a specular line down its spine. Where the top thread's width runs
 * out we see the thread below, darkened by contact occlusion, which produces
 * the characteristic dark lattice of gaps. Thread indices are hashed modulo the
 * thread count, so per-thread width/tone jitter tiles perfectly.
 */
function* bakeAcousticFabric(surface: Surface, rng: Rng): TextureJob {
  const S = surface.px;
  const seed = rng.int(0, 0x7fffffff);
  const threads = 32;
  const T = S / threads;

  // Periodic domain warp — hand-stretched fabric is never perfectly square.
  const warpX = periodicFbm(S, 6, 2, mix32(seed, 31), 0.5);
  const warpY = periodicFbm(S, 6, 2, mix32(seed, 32), 0.5);
  const fuzz = periodicFbm(S, 128, 2, mix32(seed, 33), 0.6);
  const shadeField = periodicFbm(S, 3, 3, mix32(seed, 34), 0.5);

  // Shades one half-cylinder thread; `a` is the across-width coordinate in
  // [-1, 1], `along` is 0..1 down the thread's visible span.
  const cylinder = (a: number, along: number, out: Float32Array): void => {
    const h = Math.sqrt(Math.max(0, 1 - a * a));
    const nx = a;
    const nz = h;
    const diffuse = Math.max(0, nx * LX + nz * LZ + 0.22 * LY);
    const spec = pow22(Math.max(0, nx * HX + nz * HZ));
    // Threads dip where they pass under their neighbour at each end.
    const dip = 0.70 + 0.30 * Math.sin(Math.PI * clamp01(along));
    out[0] = diffuse * dip;
    out[1] = spec * dip;
  };

  const shade = new Float32Array(2);

  yield* paintPixelsStepped(surface, 5, (x, y, i, out) => {
    const wx = x + warpX[i] * 1.6;
    const wy = y + warpY[i] * 1.6;
    const u = wx / T;
    const v = wy / T;
    const ti = Math.floor(u);
    const tj = Math.floor(v);
    const fu = u - ti;
    const fv = v - tj;

    const iw = ((ti % threads) + threads) % threads;
    const jw = ((tj % threads) + threads) % threads;

    // Per-thread character: width, lateral offset, tone.
    const warpHalf = 0.40 + 0.09 * hash01(iw, 0, seed);
    const weftHalf = 0.40 + 0.09 * hash01(jw, 1, seed);
    const warpOff = (hash01(iw, 2, seed) - 0.5) * 0.14;
    const weftOff = (hash01(jw, 3, seed) - 0.5) * 0.14;
    const warpTone = 0.86 + 0.28 * hash01(iw, 4, seed);
    const weftTone = 0.86 + 0.28 * hash01(jw, 5, seed);

    const aWarp = (fu - 0.5 - warpOff) / warpHalf;
    const aWeft = (fv - 0.5 - weftOff) / weftHalf;

    const warpOnTop = ((iw + jw) & 1) === 0;
    let diffuse = 0;
    let spec = 0;
    let tone = 1;
    let occlusion = 1;

    if (warpOnTop && Math.abs(aWarp) <= 1) {
      cylinder(aWarp, fv, shade);
      diffuse = shade[0];
      spec = shade[1];
      tone = warpTone;
    } else if (!warpOnTop && Math.abs(aWeft) <= 1) {
      cylinder(aWeft, fu, shade);
      diffuse = shade[0];
      spec = shade[1];
      tone = weftTone;
    } else {
      // Gap: the sunken thread shows through, in contact shadow.
      const under = warpOnTop ? aWeft : aWarp;
      const alongUnder = warpOnTop ? fu : fv;
      if (Math.abs(under) <= 1) {
        cylinder(under, alongUnder, shade);
        diffuse = shade[0] * 0.42;
        spec = shade[1] * 0.18;
        tone = warpOnTop ? weftTone : warpTone;
      } else {
        diffuse = 0.04;
        spec = 0;
        tone = 0.8;
      }
      // Deeper shadow the further into the gap we are.
      const gapDepth = Math.min(Math.abs(aWarp), Math.abs(aWeft));
      occlusion = 0.34 + 0.5 / (1 + gapDepth * gapDepth * 2.4);
    }

    const fz = fuzz[i] * 0.06;
    const macro = 1 + shadeField[i] * 0.10;

    // Charcoal acoustic fabric: it must stay dark or the set loses its blacks,
    // but the weave has to survive being seen at a distance under a hard key.
    const base = 0.058;
    out[0] = clamp01((base + diffuse * 0.300 + spec * 0.430) * tone * occlusion * macro + fz);
    out[1] = clamp01((base + diffuse * 0.282 + spec * 0.412) * tone * occlusion * macro + fz);
    out[2] = clamp01((base + diffuse * 0.258 + spec * 0.384) * tone * occlusion * macro + fz);
    out[3] = 1;
  });

  // Loose fibres standing off the weave — foam is fuzzy under a hard key.
  const ctx = surface.ctx;
  const L = surface.logical;
  applyLogicalUnits(surface);
  ctx.lineCap = "round";
  for (let f = 0; f < 190; f++) {
    const x = rng.range(0, L);
    const y = rng.range(0, L);
    const len = rng.range(1.6, 7);
    const a = rng.range(0, TAU);
    const bendA = a + rng.range(-1.1, 1.1);
    ctx.strokeStyle = `rgba(214,203,192,${rng.range(0.04, 0.15).toFixed(3)})`;
    ctx.lineWidth = rng.range(0.3, 0.7);
    wrapDraw(L, x, y, len + 2, (ox, oy) => {
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.quadraticCurveTo(
        x + ox + Math.cos(a) * len * 0.6,
        y + oy + Math.sin(a) * len * 0.6,
        x + ox + Math.cos(bendA) * len,
        y + oy + Math.sin(bendA) * len,
      );
      ctx.stroke();
    });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * carbon-weave — 512px 2×2 twill carbon fibre.
 *
 * Geometry first. In a 2/2 twill each warp tow floats over two wefts, under
 * two, and the pattern shifts by one pick per row — `((i + j) & 3) < 2`. That
 * single expression is what produces the 45° rib everyone recognises; a
 * checkerboard here would read as cheap plastic.
 *
 * Shading second. A tow is a flattened ribbon of thousands of parallel
 * filaments, so its highlight is *anisotropic*: near-mirror across the fibres,
 * rough along them, which puts one bright line down the length of every tow.
 * That is a Ward lobe evaluated in the tow's own tangent frame — an isotropic
 * Blinn lobe here collapses into disconnected blobs and the twill stops
 * reading. Because the light is closer to perpendicular to the weft tows than
 * to the warp tows, the two orientations land at different brightness, which is
 * exactly the light/dark rib alternation real carbon shows.
 */
function* bakeCarbonWeave(surface: Surface, rng: Rng): TextureJob {
  const S = surface.px;
  const seed = rng.int(0, 0x7fffffff);
  const cells = 32; // 32 % 4 === 0, so the twill repeat divides the tile
  const C = S / cells;

  // Filament striations: high frequency across the tow, low along it.
  const filV = periodicFbmAniso(S, 160, 7, 2, mix32(seed, 41), 0.55); // warp tows (run vertically)
  const filH = periodicFbmAniso(S, 7, 160, 2, mix32(seed, 42), 0.55); // weft tows (run horizontally)
  const envelope = periodicFbm(S, 3, 3, mix32(seed, 43), 0.5);
  const resin = periodicFbm(S, 64, 2, mix32(seed, 44), 0.6);

  yield* paintPixelsStepped(surface, 6, (x, y, i, out) => {
    const u = x / C;
    const v = y / C;
    const ci = Math.floor(u);
    const cj = Math.floor(v);
    const fu = u - ci;
    const fv = v - cj;
    const phase = (ci + cj) & 3;
    const warpOnTop = phase < 2;

    // Across-tow coordinate w ∈ [-1,1]; along-float coordinate s ∈ [0,1).
    let w: number;
    let s: number;
    let fil: number;
    if (warpOnTop) {
      w = (fu - 0.5) / 0.5;
      s = (phase + fv) * 0.5;
      fil = filV[i];
    } else {
      w = (fv - 0.5) / 0.5;
      s = (phase - 2 + fu) * 0.5;
      fil = filH[i];
    }

    // Ribbon cross-section: flat-topped, edges rolling away sharply.
    // (1 - w²)^0.25 via two square roots: a flat-topped ribbon profile, and
    // indistinguishable from the 0.30 exponent it replaces.
    const cross = Math.sqrt(Math.sqrt(Math.max(0, 1 - w * w)));

    // Slopes. Across: steep only near the tow edges. Along: the arc over the
    // crossing, so cos(pi*s) flips sign at the float's midpoint.
    const aw = w < 0 ? -w : w;
    const slopeAcross = -Math.sign(w) * aw * Math.sqrt(aw) * 1.15;
    const slopeAlong = -Math.cos(Math.PI * clamp01(s)) * 0.34 * cross;

    // Raw slopes in world axes plus the tow's axis direction.
    let sx: number;
    let sy: number;
    let ax: number;
    let ay: number;
    if (warpOnTop) {
      sx = slopeAcross;
      sy = slopeAlong;
      ax = 0;
      ay = 1;
    } else {
      sx = slopeAlong;
      sy = slopeAcross;
      ax = 1;
      ay = 0;
    }

    const nInv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
    const nx = -sx * nInv;
    const ny = -sy * nInv;
    const nz = nInv;

    // Tangent frame: the tow axis projected onto the surface, then B = N × T.
    const ndott = nx * ax + ny * ay;
    let tx = ax - nx * ndott;
    let ty = ay - ny * ndott;
    let tz = -nz * ndott;
    const tInv = 1 / (Math.sqrt(tx * tx + ty * ty + tz * tz) || 1);
    tx *= tInv;
    ty *= tInv;
    tz *= tInv;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    // Ward: roughness 0.62 along the filaments, 0.15 across them. The locus
    // where the half-vector has no across-component is a line running the
    // length of the tow — the highlight every carbon panel shows.
    const hn = nx * HX + ny * HY + nz * HZ;
    let ward = 0;
    if (hn > 0.05) {
      const ht = (tx * HX + ty * HY + tz * HZ) / 0.62;
      const hb = (bx * HX + by * HY + bz * HZ) / 0.15;
      ward = Math.exp(-(ht * ht + hb * hb) / (hn * hn));
    }
    // A broad lobe stops the off-highlight regions going pitch black.
    const broad = pow5(Math.max(0, hn));
    const diffuse = Math.max(0, nx * LX + ny * LY + nz * LZ);

    // Deep groove between parallel tows; only a mild dip where a float dives.
    const ao =
      (0.22 + 0.78 * smoothstep(0, 0.15, 1 - Math.abs(w))) *
      (0.64 + 0.36 * smoothstep(0, 0.36, Math.min(s, 1 - s) * 2));

    // Panel-scale variation: real laid-up carbon is never uniformly lit, and a
    // perfectly even weave is the fastest way to look like a repeating tile.
    const striation = 0.58 + 0.80 * clamp01(0.5 + fil * 0.9);
    const env = 0.58 + 0.88 * clamp01(0.5 + envelope[i] * 1.15);

    const specular = (ward * 0.80 * striation + broad * 0.085) * ao * env;
    let lum = 0.026 + diffuse * 0.050 * ao + specular;
    // Resin-rich pockets sit between tows and stay glossy but dark.
    lum += (1 - ao) * 0.010 + resin[i] * 0.009;
    lum = clamp01(lum);

    // Carbon is near-neutral; the highlight carries the tungsten warmth.
    const hot = clamp01(specular * 1.6);
    out[0] = clamp01(lum * (0.98 + hot * 0.06));
    out[1] = clamp01(lum * 0.965);
    out[2] = clamp01(lum * (0.945 - hot * 0.05));
    out[3] = 1;
  });

  // Clear-coat sparkle: a few dust-in-lacquer specks catching the key.
  const ctx = surface.ctx;
  const L = surface.logical;
  applyLogicalUnits(surface);
  ctx.globalCompositeOperation = "lighter";
  for (let d = 0; d < 90; d++) {
    const x = rng.range(0, L);
    const y = rng.range(0, L);
    const r = rng.range(0.4, 1.5);
    ctx.fillStyle = `rgba(255,246,236,${rng.range(0.05, 0.22).toFixed(3)})`;
    wrapDraw(L, x, y, r + 1, (ox, oy) => {
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, TAU);
      ctx.fill();
    });
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * dust-motes — 512px sparse soft points for parallax drift.
 * Motes are placed on a jittered (stratified) grid so the field has no clumps
 * or holes when it scrolls, with a second population of large, very dim,
 * out-of-focus motes for the near plane.
 */
function bakeDustMotes(surface: Surface, rng: Rng): void {
  const ctx = surface.ctx;
  const L = surface.logical;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, surface.px, surface.px);
  applyLogicalUnits(surface);
  ctx.globalCompositeOperation = "lighter";

  // One soft dot, baked once and stamped — no gradient per mote.
  const dot = createSurface(64, 1);
  const dctx = dot.ctx;
  const grad = dctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.22, "rgba(255,255,255,0.72)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.24)");
  grad.addColorStop(0.78, "rgba(255,255,255,0.05)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  dctx.fillStyle = grad;
  dctx.fillRect(0, 0, 64, 64);

  const stamp = (x: number, y: number, size: number, alpha: number): void => {
    ctx.globalAlpha = alpha;
    wrapDraw(L, x, y, size * 0.5 + 1, (ox, oy) => {
      ctx.drawImage(dot.canvas, x + ox - size * 0.5, y + oy - size * 0.5, size, size);
    });
  };

  const grid = 15;
  const cell = L / grid;
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      if (rng.next() > 0.62) continue;
      const x = (i + rng.next()) * cell;
      const y = (j + rng.next()) * cell;
      // Size distribution is heavily skewed small: cubed uniform.
      const t = rng.next() ** 3;
      stamp(x, y, lerp(1.3, 7.5, t), lerp(0.85, 0.35, t));
    }
  }

  // Extra fine specks between the grid cells — the far plane.
  for (let k = 0; k < 90; k++) {
    stamp(rng.range(0, L), rng.range(0, L), rng.range(0.8, 1.9), rng.range(0.18, 0.55));
  }

  // Defocused near-plane motes: big, faint, and they will bloom.
  for (let k = 0; k < 22; k++) {
    stamp(rng.range(0, L), rng.range(0, L), rng.range(11, 28), rng.range(0.035, 0.1));
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Sprites — white on transparent, tinted by the caller
 * ------------------------------------------------------------------ */

/** Fades an alpha to exactly zero at the sprite border so no square edge shows. */
function spriteEdge(d: number): number {
  return 1 - smoothstep(0.93, 1.0, d);
}

/**
 * spark — sharp hot core, soft falloff, slight anisotropy plus a horizontal
 * sensor-bleed cross. Anisotropy matters: perfectly round sparks read as UI.
 */
function bakeSpark(surface: Surface): void {
  paintSprite(surface, (nx, ny, out) => {
    const ex = nx / 1.0;
    const ey = ny / 0.78; // slightly wider than tall
    const r = Math.sqrt(ex * ex + ey * ey);
    const core = bump(r, 0.105);
    const halo = softBump(r, 0.40, 0.5) * 0.5;
    // Charge bleed along the sensor rows — a real highlight artefact.
    const bleed = bump(ny, 0.030) * softBump(nx, 0.34, 0.8) * 0.34;
    const a = clamp01(core * 1.25 + halo + bleed) * spriteEdge(Math.sqrt(nx * nx + ny * ny));
    const warmth = clamp01(1 - r * 0.28);
    out[0] = 1;
    out[1] = 0.94 + 0.06 * warmth;
    out[2] = 0.86 + 0.14 * warmth;
    out[3] = a;
  });
}

/**
 * bokeh — a real defocused highlight, not a blurred circle.
 *
 * Four physical cues, all present in an actual fast prime:
 *  1. a nearly flat interior that brightens toward the edge (spherical
 *     aberration pushes energy outward),
 *  2. a bright, thin rim,
 *  3. onion rings from the aspherical element's turning marks,
 *  4. a partially-stopped-down iris, so the disc is between round and hexagonal.
 */
function bakeBokeh(surface: Surface): void {
  const R = 0.80;
  const sector = Math.PI / 3;
  const apothem = Math.cos(sector * 0.5);
  paintSprite(surface, (nx, ny, out) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    if (d > 0.999) {
      out[3] = 0;
      return;
    }
    let t = (Math.atan2(ny, nx) + 0.42) % sector;
    if (t < 0) t += sector;
    const hexRadius = apothem / Math.cos(t - sector * 0.5);
    // 0 = circular iris, 1 = fully hexagonal. Barely stopped down, so the disc
    // only hints at the blades — a hard hexagon reads as a UI badge.
    const shapeRadius = R * lerp(1, hexRadius, 0.28);
    const q = d / shapeRadius;

    const body = (1 - smoothstep(0.88, 1.0, q)) * (0.60 + 0.32 * q * q);
    const rim = bump(q - 0.94, 0.055) * 0.85;
    // Turning marks on the aspherical element. Kept near the threshold of
    // visibility: strong onion rings look like a tree stump, not a lens.
    const onion = 1 + 0.017 * Math.cos(q * 21) + 0.010 * Math.cos(q * 44 + 1.2);
    // Faint iris scatter toward the flat side of each blade.
    const blade = 1 + 0.035 * Math.cos((t - sector * 0.5) * 6) * smoothstep(0.4, 1, q);
    const a = clamp01((body * onion * blade + rim) * 0.92) * spriteEdge(d);
    out[0] = 1;
    out[1] = 0.985;
    out[2] = 0.962;
    out[3] = a;
  });
}

/**
 * smoke — soft turbulent puff. Domain-warped fbm gives billows rather than
 * blobs; the alpha is eroded with a smoothstep so the edges tatter instead of
 * ending in a clean circle. RGB carries a shading term derived from the density
 * gradient (self-shadowing toward the key), which is what gives a tinted puff
 * actual volume.
 */
function bakeSmoke(surface: Surface, rng: Rng, nz: OrganicNoise): void {
  const S = surface.px;
  const density = new Float32Array(S * S);
  const ox = rng.range(-90, 90);
  const oy = rng.range(-90, 90);
  const inv = 2 / S;

  for (let y = 0; y < S; y++) {
    const ny = (y + 0.5) * inv - 1;
    for (let x = 0; x < S; x++) {
      const nx = (x + 0.5) * inv - 1;
      const d = Math.sqrt(nx * nx + ny * ny);
      const mask = 1 - smoothstep(0.10, 1.0, d);
      if (mask <= 0) continue;
      // Low base frequency: a puff is a few large billows, not a hundred
      // filaments. High frequencies here turn the sprite into a cotton ball.
      const fx = nx * 1.15 + ox;
      const fy = ny * 1.15 + oy;
      // Warp the sample point by a lower-frequency field: classic billowing.
      const warp = nz.fbm2(fx * 0.6 + 4.3, fy * 0.6 - 2.1, 2);
      const f = nz.fbm2(fx + warp * 1.15, fy + warp * 1.15, 4);
      // Light erosion only. A heavy subtraction here crosses zero steeply and
      // gives the puff a cut edge instead of a dissolving one.
      const raw = mask * (0.62 + 0.82 * (0.5 + 0.5 * f)) - 0.09;
      density[y * S + x] = clamp01(raw);
    }
  }

  paintPixels(surface, (x, y, i, out) => {
    // A gentle ramp keeps the boundary soft; a steep one carves tendrils.
    const a = smoothstep(0.0, 0.80, density[i]) * 0.92;
    if (a <= 0) {
      out[3] = 0;
      return;
    }
    // Cheap single-scatter: sample the density a good way toward the key and
    // darken by how much smoke is in the way.
    const sx = clamp(Math.round(x + LX * 14), 0, S - 1);
    const sy = clamp(Math.round(y + LY * 14), 0, S - 1);
    const occl = density[sy * S + sx];
    const lit = clamp01(0.5 + (density[i] - occl) * 1.4);
    // A narrow value range: smoke is a light-scattering medium, and pushing the
    // shading hard turns the puff into a marble.
    const l = lerp(0.66, 1.0, lit);
    const ex = (x + 0.5) * inv - 1;
    const ey = (y + 0.5) * inv - 1;
    out[0] = l;
    out[1] = l * 0.985;
    out[2] = l * 0.962;
    out[3] = a * spriteEdge(Math.sqrt(ex * ex + ey * ey));
  });
}

/**
 * streak — anamorphic light streak. Long, thin, with a super-elliptical falloff
 * (exponent > 2 across, < 2 along) that keeps the ends soft while the middle
 * stays hot. The waist bulges slightly at the centre, as a real anamorphic
 * flare does, and fine longitudinal striations break up the flatness.
 */
function bakeStreak(surface: Surface, rng: Rng): void {
  const phase = rng.range(0, TAU);
  const phase2 = rng.range(0, TAU);
  paintSprite(surface, (nx, ny, out) => {
    const waist = 0.030 * (1 + 1.7 * bump(nx, 0.30));
    const across = softBump(ny, waist, 0.3);
    const along = hardBump(nx, 0.90, 0.08);
    const core = bump(ny, waist * 0.32) * bump(nx, 0.58) * 0.85;
    // Low-order striations only: high wavenumbers here bead the core into dots.
    const striation = 1 + 0.075 * Math.sin(nx * 17 + phase) + 0.045 * Math.sin(nx * 41 + phase2);
    const halo = bump(ny, 0.115) * bump(nx, 0.70) * 0.14;
    const a = clamp01((across * along * striation) * 0.88 + core + halo);
    out[0] = 1;
    out[1] = 0.978;
    out[2] = 0.948;
    out[3] = a * spriteEdge(Math.max(Math.abs(nx), Math.abs(ny)));
  });
}

/**
 * ring — expanding shock ring. A hard leading edge, a soft trailing wash inside
 * it, and an outer glow bleeding ahead of the front. The radius and intensity
 * are modulated by a sum of integer angular harmonics so the ring is never a
 * perfect circle (which always reads as a UI element) yet stays continuous at
 * θ = 0.
 */
function bakeRing(surface: Surface, rng: Rng): void {
  const p1 = rng.range(0, TAU);
  const p2 = rng.range(0, TAU);
  const p3 = rng.range(0, TAU);
  const p4 = rng.range(0, TAU);
  paintSprite(surface, (nx, ny, out) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    if (d > 0.999) {
      out[3] = 0;
      return;
    }
    const th = Math.atan2(ny, nx);
    const wobble =
      1 + 0.045 * Math.cos(3 * th + p1) + 0.030 * Math.cos(5 * th + p2) + 0.018 * Math.cos(8 * th + p3);
    const gain = 1 + 0.26 * Math.cos(4 * th + p4) + 0.16 * Math.cos(9 * th - p2);
    const R = 0.855 * wobble;

    const front = bump(d - R, 0.017) * 1.0;
    const outer = d > R ? bump(d - R, 0.062) * 0.28 : 0;
    // The wash behind the front is the body of the shock; a cubic ramp leaves
    // the ring hollow and it stops reading as a pressure wave.
    const tq = clamp01(d / R);
    const tq2 = tq * tq;
    const trail = d < R ? tq2 * tq2 * 0.46 : 0;
    const inner = d < R ? (1 - smoothstep(0, R * 0.92, d)) * 0.06 : 0;
    // Radial filaments in the trailing wash — plasma, not neon. Two coprime
    // harmonics so the scalloping does not read as a machined gear.
    const filament =
      1 + (0.11 * Math.cos(th * 17 + p1) + 0.07 * Math.cos(th * 29 - p3)) * smoothstep(0.45, R, d);

    const a = clamp01((front * gain + outer + trail * filament + inner) * 0.95) * spriteEdge(d);
    out[0] = 1;
    out[1] = 0.972;
    out[2] = 0.935;
    out[3] = a;
  });
}

/**
 * flare — a single lens-flare ghost. Iris ghosts inherit the aperture shape, so
 * this one is explicitly hexagonal: the polygon radius `apothem / cos(θ')` gives
 * a hexagon whose vertices sit at radius 1. Body is flat and translucent, the
 * rim is bright, and six faint spokes point at the blade joints.
 */
function bakeFlare(surface: Surface): void {
  const sector = Math.PI / 3;
  const apothem = Math.cos(sector * 0.5);
  const R = 0.78;
  paintSprite(surface, (nx, ny, out) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    if (d > 0.999) {
      out[3] = 0;
      return;
    }
    const ang = Math.atan2(ny, nx);
    let t = (ang + Math.PI * 0.5) % sector;
    if (t < 0) t += sector;
    const hex = apothem / Math.cos(t - sector * 0.5);
    const q = d / (R * hex);

    const body = (1 - smoothstep(0.82, 1.0, q)) * 0.26 * (0.7 + 0.5 * q);
    const rim = bump(q - 0.94, 0.055) * 0.5;
    const core = bump(d, 0.14) * 0.55;
    // Blade spokes: brightest where two blades meet. Narrow, or they read as
    // nubs bolted to the ghost instead of light scattering off a blade joint.
    // Confined to the outer third: a spoke that reaches the centre draws three
    // straight lines across the ghost and the whole thing looks like wireframe.
    const spoke =
      pow80(Math.abs(Math.cos(3 * (ang + Math.PI * 0.5)))) *
      0.22 *
      smoothstep(0.62, 0.95, q) *
      (1 - smoothstep(0.98, 1.18, q));
    const rings = 1 + 0.035 * Math.cos(q * 14);

    const a = clamp01((body * rings + rim + core + spoke)) * spriteEdge(d);
    out[0] = 1;
    out[1] = 0.972;
    out[2] = 0.94;
    out[3] = a;
  });
}

/**
 * star-flare — anamorphic cross with subtle fringing.
 *
 * A long horizontal bar (the anamorphic axis), a shorter vertical bar, two
 * minor diagonal spikes and a hot core. The fringing is deliberately kept to
 * ≤10% channel deviation: this is lateral chromatic aberration, not a rainbow —
 * the art direction forbids a second saturated hue, and a real cine lens only
 * splits by a hair anyway.
 */
function bakeStarFlare(surface: Surface): void {
  const d1 = 0.38;
  const d2 = -0.38;
  paintSprite(surface, (nx, ny, out) => {
    const r = Math.sqrt(nx * nx + ny * ny);

    const horiz = softBump(ny, 0.016, 0.4) * softBump(nx, 0.90, 0.3);
    const vert = softBump(nx, 0.018, 0.4) * softBump(ny, 0.34, 0.1) * 0.4;

    const c1 = Math.cos(d1);
    const s1 = Math.sin(d1);
    const rx1 = nx * c1 + ny * s1;
    const ry1 = -nx * s1 + ny * c1;
    const spike1 =
      softBump(ry1, 0.012, 0.5) * softBump(rx1, 0.50, 0.3) * 0.20;

    const c2 = Math.cos(d2);
    const s2 = Math.sin(d2);
    const rx2 = nx * c2 + ny * s2;
    const ry2 = -nx * s2 + ny * c2;
    const spike2 =
      softBump(ry2, 0.012, 0.5) * softBump(rx2, 0.50, 0.3) * 0.20;

    const core = bump(r, 0.045) * 1.1;
    const halo = bump(r, 0.22) * 0.10;
    // Diffraction ripples down the long axis.
    const ripple = 1 + 0.09 * Math.cos(nx * 61) * smoothstep(0.08, 0.6, Math.abs(nx));

    const a = clamp01((horiz * ripple + vert + spike1 + spike2 + core + halo)) * spriteEdge(Math.max(Math.abs(nx), Math.abs(ny)));

    // Lateral fringing grows with distance from the optical centre and flips
    // sign across it: cool on one wing, warm on the other.
    const f = clamp01((Math.abs(nx) - 0.16) / 0.8) * 0.10 * Math.sign(nx);
    out[0] = clamp01(1 + f * 0.9);
    out[1] = clamp01(1 - Math.abs(f) * 0.22);
    out[2] = clamp01(1 - f * 0.9);
    out[3] = a;
  });
}

/**
 * shard — angular glass fragment.
 *
 * A concave-safe irregular polygon with a translucent body, one internal
 * fracture plane catching a specular line, bright edges on the two facets
 * facing the key and dim edges elsewhere, plus a vertex glint. Drawn rather
 * than shaded per-pixel because the crisp straight edges are the whole point.
 */
function bakeShard(surface: Surface, rng: Rng): void {
  const ctx = surface.ctx;
  const L = surface.logical;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, surface.px, surface.px);
  applyLogicalUnits(surface);

  const cx = L * 0.5;
  const cy = L * 0.5;
  const verts = 6;
  const pts: { x: number; y: number }[] = [];
  let angle = rng.range(0, TAU);
  for (let i = 0; i < verts; i++) {
    // Uneven angular steps and a wide radius spread make the fragment look
    // fractured; a tight spread produces a regular polygon, which reads as a
    // gemstone icon rather than something that was just shattered.
    angle += (TAU / verts) * rng.range(0.34, 1.72);
    const rad = L * 0.5 * rng.range(0.28, 0.98);
    pts.push({ x: cx + Math.cos(angle) * rad, y: cy + Math.sin(angle) * rad });
  }

  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  };

  // Body: thin glass, thicker toward the key side.
  const body = ctx.createLinearGradient(cx - L * 0.4, cy - L * 0.4, cx + L * 0.4, cy + L * 0.4);
  body.addColorStop(0, "rgba(255,255,255,0.30)");
  body.addColorStop(0.45, "rgba(255,255,255,0.13)");
  body.addColorStop(1, "rgba(255,255,255,0.05)");
  trace();
  ctx.fillStyle = body;
  ctx.fill();

  ctx.save();
  trace();
  ctx.clip();

  // Internal fracture plane: a bright chord with a hot leading line.
  const a0 = pts[0];
  const a1 = pts[Math.floor(verts / 2)];
  const facet = ctx.createLinearGradient(a0.x, a0.y, a1.x, a1.y);
  facet.addColorStop(0, "rgba(255,255,255,0)");
  facet.addColorStop(0.42, "rgba(255,255,255,0.42)");
  facet.addColorStop(0.55, "rgba(255,255,255,0.10)");
  facet.addColorStop(1, "rgba(255,255,255,0)");
  ctx.strokeStyle = facet;
  ctx.lineWidth = L * 0.10;
  ctx.beginPath();
  ctx.moveTo(a0.x, a0.y);
  ctx.lineTo(a1.x, a1.y);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.62)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(a0.x, a0.y);
  ctx.lineTo(a1.x, a1.y);
  ctx.stroke();

  // A secondary internal caustic, offset and softer.
  const b0 = pts[1];
  const b1 = pts[Math.min(verts - 1, 4)];
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = L * 0.05;
  ctx.beginPath();
  ctx.moveTo(b0.x, b0.y);
  ctx.lineTo(b1.x, b1.y);
  ctx.stroke();
  ctx.restore();

  // Edges: the two most key-facing facets catch a hard specular.
  for (let i = 0; i < verts; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % verts];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const len = Math.hypot(ex, ey) || 1;
    // Outward edge normal, then its alignment with the key.
    const nxE = ey / len;
    const nyE = -ex / len;
    const facing = clamp01(nxE * LX + nyE * LY);
    const alpha = 0.12 + 0.78 * Math.pow(facing, 1.6);
    ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    ctx.lineWidth = 0.8 + 1.0 * facing;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }

  // Vertex glint on the sharpest corner facing the key.
  let glint = pts[0];
  let bestDot = -Infinity;
  for (const p of pts) {
    const dot = (p.x - cx) * LX + (p.y - cy) * LY;
    if (dot > bestDot) {
      bestDot = dot;
      glint = p;
    }
  }
  const gr = ctx.createRadialGradient(glint.x, glint.y, 0, glint.x, glint.y, L * 0.16);
  gr.addColorStop(0, "rgba(255,255,255,0.95)");
  gr.addColorStop(0.3, "rgba(255,255,255,0.35)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(glint.x, glint.y, L * 0.16, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * ember — hot core cooling to a dim rim.
 *
 * The temperature ramp lives in RGB (bright white nucleus → dark, dim rim) and
 * the intensity ramp lives in alpha, so a caller tinting additively with hemi
 * orange gets a genuinely hot centre and a cooling shell rather than a flat
 * orange dot. The perimeter is broken by angular harmonics — embers are chunks
 * of burning matter, not discs.
 */
function bakeEmber(surface: Surface, rng: Rng): void {
  const p1 = rng.range(0, TAU);
  const p2 = rng.range(0, TAU);
  const p3 = rng.range(0, TAU);
  paintSprite(surface, (nx, ny, out) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    const th = Math.atan2(ny, nx);
    // Higher harmonics dominate: a strong 3θ term alone makes every ember a
    // rounded triangle, which is unmistakable once a hundred are on screen.
    const shape = 1 + 0.07 * Math.cos(3 * th + p1) + 0.11 * Math.cos(5 * th + p2) + 0.085 * Math.cos(8 * th + p3);
    // Fade the angular shaping in with radius. Applied at d ≈ 0 the polar
    // singularity would stamp a hard polygon straight through the nucleus.
    const radius = 0.60 * lerp(1, shape, smoothstep(0.08, 0.44, d));
    const q = d / radius;

    const core = bump(q, 0.26) * 1.25;
    const shell = softBump(q, 0.70, 0.1) * 0.60;
    const a = clamp01(core + shell) * spriteEdge(d);

    // Temperature: 1.0 at the nucleus falling to ~0.45 at the rim.
    const heat = clamp01(1.05 - q * 0.72);
    out[0] = clamp01(0.55 + 0.45 * heat);
    out[1] = clamp01(0.34 + 0.66 * heat * heat);
    // Blue falls fastest — that cubic *is* the black-body cool-down.
    out[2] = clamp01(0.20 + 0.80 * heat * heat * heat);
    out[3] = a;
  });
}

/**
 * glow — pure radial falloff for cheap lights. The gaussian is offset and
 * renormalised so it reaches exactly zero at the sprite edge (a truncated
 * gaussian leaves a visible square boundary once it is stacked additively),
 * with a wide low skirt so large glows do not look like discs.
 */
function bakeGlow(surface: Surface): void {
  const k = 4.6;
  const floorValue = Math.exp(-k);
  const norm = 1 / (1 - floorValue);
  paintSprite(surface, (nx, ny, out) => {
    const d = Math.min(1, Math.sqrt(nx * nx + ny * ny));
    const core = (Math.exp(-k * d * d) - floorValue) * norm;
    const s1 = 1 - d;
    const skirt = s1 * s1 * s1 * 0.13;
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = clamp01(core + skirt);
  });
}

/* ------------------------------------------------------------------ *
 * Full-frame overlays
 * ------------------------------------------------------------------ */

/**
 * vignette — natural cos⁴ illumination falloff.
 *
 * The cos⁴ law says off-axis illumination falls as cos⁴ of the field angle θ.
 * With tanθ = r·K this becomes 1/(1 + (rK)²)² — no trigonometry required. K is
 * the tangent of the half-diagonal field angle; 0.66 puts the corner about a
 * stop down, which is a fast prime wide open. A small mechanical term darkens
 * the extreme corner (lens barrel cut-off), the centre is nudged up by 1.5%
 * because the key rig is above the lens, and an ordered-ish hash dither keeps
 * the ramp from banding on 8-bit.
 *
 * The tile is square and expected to be stretched over the frame; that turns
 * the circular falloff into an ellipse matched to the aspect, which is exactly
 * what a rectangular sensor crop of a circular image circle looks like.
 */
function bakeVignette(surface: Surface, rng: Rng): void {
  const S = surface.px;
  const K = 0.66;
  const seed = rng.int(0, 0x7fffffff);
  const invHalf = 2 / S;
  // Normalising both axes by 1/√2 puts r = 1 exactly at the square's corners,
  // so K is the tangent of the half-*diagonal* field angle.
  const cornerScale = 1 / Math.SQRT2;

  paintPixels(surface, (x, y, _i, out) => {
    const nx = ((x + 0.5) * invHalf - 1) * cornerScale;
    const ny = ((y + 0.5) * invHalf - 1 + 0.030) * cornerScale;
    const r = Math.sqrt(nx * nx + ny * ny);
    const rk = r * K;
    const denom = 1 + rk * rk;
    const illumination = 1 / (denom * denom); // cos⁴θ
    let a = (1 - illumination) * 1.06;
    a += 0.20 * smoothstep(0.80, 1.35, r);
    // ±0.6/255 dither: invisible, but it destroys the concentric banding.
    a += (hash01(x, y, seed) - 0.5) * 0.0047;
    out[0] = 0.039;
    out[1] = 0.031;
    out[2] = 0.024;
    out[3] = clamp01(a);
  });
}

/**
 * lens-scratches — cleaning marks on the front element.
 *
 * Real scratches come from circular wiping, so most of these are arcs of large
 * radius. They are drawn as chains of short segments with per-segment alpha and
 * width jitter, because a scratch does not glint evenly along its length — it
 * sparkles in patches, and that intermittency is the tell. Density is weighted
 * away from the frame centre (that is the part people actually clean) and the
 * whole layer is faint enough that it only appears once bloom lifts it.
 */
function bakeLensScratches(surface: Surface, rng: Rng): void {
  const ctx = surface.ctx;
  const L = surface.logical;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, surface.px, surface.px);
  applyLogicalUnits(surface);
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";

  const half = L * 0.5;

  // Rejection-samples a point biased toward the frame edges.
  const offCentrePoint = (): { x: number; y: number } => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = rng.range(0, L);
      const y = rng.range(0, L);
      const r = Math.hypot(x - half, y - half) / half;
      if (rng.next() < smoothstep(0.10, 0.85, r)) return { x, y };
    }
    return { x: rng.range(0, L), y: rng.range(0, L) };
  };

  const drawScratch = (
    centreX: number,
    centreY: number,
    radius: number,
    start: number,
    sweep: number,
    width: number,
    alpha: number,
    seed: number,
  ): void => {
    // Segment count follows arc length, capped so the bake stays cheap.
    const segments = clamp(Math.round(Math.abs(sweep) * radius * 0.14), 10, 56);
    for (let s = 0; s < segments; s++) {
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      // Intermittent glint: a low-frequency noise gate along the scratch.
      const glint = clamp01(0.42 + perlin2(t0 * 9 + seed * 0.7, seed * 3.1, seed | 1) * 1.5);
      const taper = Math.sin(Math.PI * t0) ** 0.6;
      const a = alpha * glint * taper;
      if (a < 0.004) continue;
      ctx.strokeStyle = `rgba(255,250,244,${a.toFixed(4)})`;
      ctx.lineWidth = width * (0.6 + 0.8 * glint);
      ctx.beginPath();
      ctx.arc(centreX, centreY, radius, start + sweep * t0, start + sweep * t1);
      ctx.stroke();
    }
  };

  // Wipe arcs — the dominant population. Radii are kept nearer the frame size
  // so the curvature of the wiping motion is actually visible; past ~1.5×L an
  // arc is indistinguishable from a straight line over its sweep.
  for (let i = 0; i < 130; i++) {
    const p = offCentrePoint();
    const radius = rng.range(L * 0.12, L * 0.95);
    const dir = rng.range(0, TAU);
    // Place the arc so it passes through the chosen off-centre point.
    const cxA = p.x - Math.cos(dir) * radius;
    const cyA = p.y - Math.sin(dir) * radius;
    const sweep = rng.range(0.06, 0.55) * rng.sign();
    drawScratch(cxA, cyA, radius, dir - sweep * 0.5, sweep, rng.range(0.4, 1.5), rng.range(0.03, 0.17), i + 1);
  }

  // A few long "hero" scratches that will catch the bloom hard.
  for (let i = 0; i < 7; i++) {
    const p = offCentrePoint();
    const radius = rng.range(L * 0.9, L * 3.2);
    const dir = rng.range(0, TAU);
    const cxA = p.x - Math.cos(dir) * radius;
    const cyA = p.y - Math.sin(dir) * radius;
    const sweep = rng.range(0.10, 0.28) * rng.sign();
    drawScratch(cxA, cyA, radius, dir - sweep * 0.5, sweep, rng.range(0.9, 2.1), rng.range(0.16, 0.30), 400 + i);
  }

  // Straight hairlines from grit dragged in a single stroke.
  for (let i = 0; i < 26; i++) {
    const p = offCentrePoint();
    const a = rng.range(0, TAU);
    const len = rng.range(L * 0.04, L * 0.30);
    const alpha = rng.range(0.02, 0.12);
    const grad = ctx.createLinearGradient(p.x, p.y, p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
    grad.addColorStop(0, "rgba(255,250,244,0)");
    grad.addColorStop(0.5, `rgba(255,250,244,${alpha.toFixed(3)})`);
    grad.addColorStop(1, "rgba(255,250,244,0)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = rng.range(0.35, 0.9);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * lens-dirt — dust and smudge that only shows under bloom.
 *
 * Three populations, in the order a real front element accumulates them:
 * smudges (fingertip oil, wiped into ridged smears — stamped from three baked
 * fbm/ridged variants so no two repeat), dust specks (a heavy small-size skew,
 * a fraction with a diffraction halo) and fibres (short curved hairs, the
 * single most recognisable "dirty lens" cue).
 */
function* bakeLensDirt(surface: Surface, rng: Rng, nz: OrganicNoise): TextureJob {
  const ctx = surface.ctx;
  const L = surface.logical;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, surface.px, surface.px);
  applyLogicalUnits(surface);
  ctx.globalCompositeOperation = "lighter";

  // --- three smudge stamps, baked once ------------------------------------
  const stamps: Surface[] = [];
  for (let v = 0; v < 3; v++) {
    const stamp = createSurface(128, 1);
    const ox = rng.range(-60, 60);
    const oy = rng.range(-60, 60);
    paintSprite(stamp, (nx, ny, out) => {
      const d = Math.sqrt(nx * nx + ny * ny);
      const mask = 1 - smoothstep(0.15, 1.0, d);
      if (mask <= 0) {
        out[3] = 0;
        return;
      }
      // Ridged noise gives the streaky, wiped character of oil on glass.
      const ridge = nz.ridged2(nx * 2.6 + ox, ny * 2.6 + oy, 4);
      const soft = nz.fbm2(nx * 1.3 + oy, ny * 1.3 - ox, 3);
      const a = mask * clamp01(ridge * 0.85 + 0.35 + soft * 0.3) * 0.9;
      out[0] = 1;
      out[1] = 0.99;
      out[2] = 0.972;
      out[3] = clamp01(a);
    });
    stamps.push(stamp);
    yield;
  }

  for (let i = 0; i < 26; i++) {
    const stamp = stamps[rng.int(0, stamps.length - 1)];
    const size = rng.range(L * 0.10, L * 0.42);
    // Every third smudge is pulled well inside the frame; sampling the full
    // range alone leaves most of them clipped at the edges.
    const inset = i % 3 === 0 ? size * 0.55 : -size * 0.3;
    const x = rng.range(inset, L - inset);
    const y = rng.range(inset, L - inset);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng.range(0, TAU));
    ctx.scale(1, rng.range(0.45, 1.0));
    ctx.globalAlpha = rng.range(0.018, 0.085);
    ctx.drawImage(stamp.canvas, -size * 0.5, -size * 0.5, size, size);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  yield;

  // --- dust specks --------------------------------------------------------
  const halo = createSurface(64, 1);
  const hg = halo.ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  hg.addColorStop(0, "rgba(255,255,255,0.9)");
  hg.addColorStop(0.25, "rgba(255,255,255,0.28)");
  hg.addColorStop(0.62, "rgba(255,255,255,0.06)");
  hg.addColorStop(1, "rgba(255,255,255,0)");
  halo.ctx.fillStyle = hg;
  halo.ctx.fillRect(0, 0, 64, 64);

  for (let i = 0; i < 620; i++) {
    const x = rng.range(0, L);
    const y = rng.range(0, L);
    const t = rng.next() ** 2.6;
    const r = lerp(0.35, 2.4, t);
    const alpha = lerp(0.42, 0.10, t);
    ctx.fillStyle = `rgba(255,252,247,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    if (rng.next() < 0.14) {
      const hs = r * rng.range(7, 16);
      ctx.globalAlpha = rng.range(0.03, 0.10);
      ctx.drawImage(halo.canvas, x - hs * 0.5, y - hs * 0.5, hs, hs);
      ctx.globalAlpha = 1;
    }
  }

  yield;

  // --- fibres -------------------------------------------------------------
  ctx.lineCap = "round";
  for (let i = 0; i < 24; i++) {
    const x = rng.range(0, L);
    const y = rng.range(0, L);
    const len = rng.range(L * 0.02, L * 0.09);
    const a0 = rng.range(0, TAU);
    const a1 = a0 + rng.range(-1.5, 1.5);
    const a2 = a1 + rng.range(-1.5, 1.5);
    // Kept below the dust in weight: fibres are the loudest cue on the layer
    // and a forest of them reads as scratches on the sensor, not lens dirt.
    ctx.strokeStyle = `rgba(255,251,245,${rng.range(0.035, 0.15).toFixed(3)})`;
    ctx.lineWidth = rng.range(0.45, 1.0);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(
      x + Math.cos(a0) * len * 0.5,
      y + Math.sin(a0) * len * 0.5,
      x + Math.cos(a1) * len * 0.8,
      y + Math.sin(a1) * len * 0.8,
      x + Math.cos(a2) * len,
      y + Math.sin(a2) * len,
    );
    ctx.stroke();
  }

  // --- faint wipe ridges in one corner (a thumb print, essentially) --------
  const px0 = rng.range(L * 0.55, L * 0.95);
  const py0 = rng.range(L * 0.05, L * 0.4);
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = `rgba(255,250,243,${(0.020 - i * 0.0011).toFixed(4)})`;
    ctx.lineWidth = rng.range(1.2, 2.8);
    ctx.beginPath();
    ctx.arc(px0, py0, L * 0.02 + i * L * 0.011, rng.range(0, TAU), rng.range(1.4, 4.2), false);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

type Baker = (surface: Surface, rng: Rng, nz: OrganicNoise) => void;
/** A baker that can be suspended between phases. Used for the expensive tiles. */
type SteppedBaker = (surface: Surface, rng: Rng, nz: OrganicNoise) => TextureJob;

interface TextureSpec {
  /** Logical size on a side, in design pixels. */
  size: number;
  /** Per-texture salt: makes bake order irrelevant to the output. */
  salt: number;
  /**
   * Bake resolution relative to the logical size, before the bakery scale.
   *
   * Every per-pixel bake costs O(px²), so a texture that is only ever sampled
   * far below 1:1 has no business being rasterised at 1:1. The bakers are all
   * written in resolution-independent terms (feature *counts*, normalised
   * coordinates, `applyLogicalUnits` for vector detail), so lowering this only
   * lowers the carrier frequency — it never changes the design. `pattern()`
   * already divides by the realised scale, so tiles still repeat at their
   * logical period and `size()` still reports design pixels; callers cannot
   * tell the difference except by looking for detail that was never visible.
   *
   * Chosen per texture from how it is actually consumed:
   *  - full-frame overlays (vignette, lens dirt/scratches) carry almost no
   *    frequency and are stretched over the frame — 1/3 to 1/2,
   *  - deck/trim tiles land squashed under a grade at a few percent alpha — 1/2,
   *  - film grain must stay pixel-crisp at 1:1 — 1,
   *  - small sprites are already cheap and get magnified — 1 (or 3/4 for the
   *    big soft ones, where the only content is a smooth falloff).
   */
  res?: number;
  bake?: Baker;
  /**
   * Preferred over `bake` when present: the same work, suspendable between
   * phases. Every tile that measured over ~25 ms has one.
   */
  job?: SteppedBaker;
}

const SPECS: Record<TextureId, TextureSpec> = {
  // Grain is sampled 1:1 over the frame: any downscale turns it into mush.
  "noise-fine": { size: 256, salt: 0x1001, job: (s, r) => bakeNoiseFine(s, r) },
  "noise-coarse": { size: 512, salt: 0x1002, res: 0.5, bake: (s, r) => bakeNoiseCoarse(s, r) },
  grunge: { size: 512, salt: 0x1003, res: 0.5, job: (s, r) => bakeGrunge(s, r) },
  "brushed-metal": { size: 512, salt: 0x1004, res: 0.5, job: (s, r) => bakeBrushedMetal(s, r) },
  // The deck tile is drawn vertically squashed to 0.2–0.85 and buried under a
  // grade; half resolution is still finer than the pixels it lands on.
  concrete: { size: 512, salt: 0x1005, res: 0.5, job: (s, r) => bakeConcrete(s, r) },
  "acoustic-fabric": { size: 256, salt: 0x1006, res: 0.7, job: (s, r) => bakeAcousticFabric(s, r) },
  "carbon-weave": { size: 512, salt: 0x1007, res: 0.5, job: (s, r) => bakeCarbonWeave(s, r) },
  "dust-motes": { size: 512, salt: 0x1008, res: 0.5, bake: (s, r) => bakeDustMotes(s, r) },

  spark: { size: 64, salt: 0x2001, bake: (s) => bakeSpark(s) },
  bokeh: { size: 128, salt: 0x2002, bake: (s) => bakeBokeh(s) },
  smoke: { size: 128, salt: 0x2003, bake: (s, r, n) => bakeSmoke(s, r, n) },
  streak: { size: 256, salt: 0x2004, res: 0.7, bake: (s, r) => bakeStreak(s, r) },
  ring: { size: 192, salt: 0x2005, res: 0.75, bake: (s, r) => bakeRing(s, r) },
  flare: { size: 128, salt: 0x2006, bake: (s) => bakeFlare(s) },
  "star-flare": { size: 256, salt: 0x2007, res: 0.6, bake: (s) => bakeStarFlare(s) },
  shard: { size: 128, salt: 0x2008, bake: (s, r) => bakeShard(s, r) },
  ember: { size: 96, salt: 0x2009, bake: (s, r) => bakeEmber(s, r) },
  glow: { size: 128, salt: 0x200a, bake: (s) => bakeGlow(s) },

  // Stretched across the whole frame: a 1024px bake was four times the pixels
  // of anything that could ever be resolved through it.
  vignette: { size: 1024, salt: 0x3001, res: 0.375, bake: (s, r) => bakeVignette(s, r) },
  "lens-scratches": { size: 1024, salt: 0x3002, res: 0.5, bake: (s, r) => bakeLensScratches(s, r) },
  "lens-dirt": { size: 1024, salt: 0x3003, res: 0.5, job: (s, r, n) => bakeLensDirt(s, r, n) },
};

/**
 * Warm order: roughly the order the game first *asks* for each texture, so an
 * incremental warm has the set dressing ready before the studio bakes want it,
 * the lens overlays ready before the first foreground pass, and the particle
 * sheets ready before the first shot is fired.
 */
const ALL_IDS: readonly TextureId[] = [
  "acoustic-fabric",
  "brushed-metal",
  "concrete",
  "glow",
  "bokeh",
  "lens-dirt",
  "carbon-weave",
  "grunge",
  "noise-fine",
  "vignette",
  "spark",
  "smoke",
  "ring",
  "streak",
  "ember",
  "shard",
  "flare",
  "star-flare",
  "noise-coarse",
  "dust-motes",
  "lens-scratches",
];

/* ------------------------------------------------------------------ *
 * Public factory
 * ------------------------------------------------------------------ */

interface TextureBakeryOptions {
  /**
   * DPR-aware bake multiplier. Backing canvases are `size(id) * scale` pixels;
   * `pattern()` compensates so tiles still repeat at their logical period.
   * Drive this from `scene.quality` / `devicePixelRatio` at boot.
   */
  scale?: number;
  /** Deterministic source. One value is drawn at construction to seed the bakery. */
  rng?: Rng;
  /** Shared noise, used for the organic (non-tiling) sprite fields. */
  noise?: Noise;
}

/**
 * `TextureBakery` plus the incremental warm the boot sequence drives.
 *
 * `warm()` bakes twenty-one procedural textures; on a weak machine that is the
 * best part of a second of straight-line work, and doing it in one call is a
 * stall no title sequence can hide. `warmStep` does the same work in bounded
 * slices so the composition root can spend a few milliseconds per frame on it
 * instead. The extra members are additive — the object still satisfies the
 * frozen `TextureBakery` contract, and consumers that only know that interface
 * are unaffected.
 */
export interface IncrementalTextureBakery extends TextureBakery {
  /**
   * Bakes not-yet-baked textures in warm order, stopping as soon as `budgetMs`
   * of wall time has been spent or `maxItems` have been baked (whichever comes
   * first). At least one texture is always attempted, so progress is guaranteed
   * even when the caller passes a budget of zero. Returns the number still
   * pending.
   */
  warmStep(budgetMs: number, maxItems?: number): number;
  /** Textures still unbaked. 0 once the bakery is fully warm. */
  readonly pending: number;
  /** Total textures the bakery knows how to bake. */
  readonly total: number;
}

/**
 * Builds the texture bakery. Nothing is baked here — construction is free and
 * safe during server rendering; the first `get()` (or `warm()`) does the work.
 */
export function createTextureBakery(options?: TextureBakeryOptions): IncrementalTextureBakery {
  // Bake scale is clamped: below 0.5 the tiles alias, above 3 the memory cost
  // of the 1024px overlays stops being worth it.
  const scale = clamp(options?.scale ?? 1, 0.5, 3);
  const organic: OrganicNoise = options?.noise ?? FALLBACK_NOISE;

  // One draw from the injected stream at construction time. Every texture then
  // derives its own stream from (rootSeed, salt), so lazy bake order can never
  // change what a texture looks like.
  const rootSeed = options?.rng ? options.rng.fork(0x504f5021).int(0, 0x7ffffffe) >>> 0 : 0x504f5021;

  const cache = new Map<TextureId, CanvasImageSource>();
  // The realised scale after rounding to whole pixels, which is what `pattern()`
  // must invert — using the requested `scale` would drift the tile period by up
  // to half a pixel per repeat on odd logical sizes.
  const bakedScale = new Map<TextureId, number>();
  const patterns = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern>>();
  /** How far the incremental warm has walked `ALL_IDS`. */
  let warmCursor = 0;

  /** A bake that has been started and suspended, waiting for its next slice. */
  let active: { id: TextureId; surface: Surface; iter: TextureJob } | null = null;

  const beginBake = (id: TextureId): { surface: Surface; iter: TextureJob } | null => {
    const spec = SPECS[id];
    const surface = createSurface(spec.size, scale * (spec.res ?? 1));
    const rng = makeRng(mix32(rootSeed, spec.salt));
    if (spec.job) return { surface, iter: spec.job(surface, rng, organic) };
    if (spec.bake) spec.bake(surface, rng, organic);
    publish(id, surface);
    return null;
  };

  const publish = (id: TextureId, surface: Surface): void => {
    // Bakers may leave a transform behind; normalise before publishing.
    surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
    surface.ctx.globalAlpha = 1;
    surface.ctx.globalCompositeOperation = "source-over";
    cache.set(id, surface.canvas);
    bakedScale.set(id, surface.k);
  };

  const get = (id: TextureId): CanvasImageSource => {
    const cached = cache.get(id);
    if (cached) return cached;
    // An id asked for out of warm order is finished on the spot: a caller that
    // wants pixels now cannot be given a half-baked tile.
    if (active && active.id === id) {
      while (!active.iter.next().done) {
        /* drain */
      }
      publish(id, active.surface);
      active = null;
    } else {
      const started = beginBake(id);
      if (started) {
        while (!started.iter.next().done) {
          /* drain */
        }
        publish(id, started.surface);
      }
    }
    return cache.get(id) as CanvasImageSource;
  };

  return {
    get,

    pattern(context: CanvasRenderingContext2D, id: TextureId, repeat = "repeat"): CanvasPattern {
      let byKey = patterns.get(context);
      if (!byKey) {
        byKey = new Map<string, CanvasPattern>();
        patterns.set(context, byKey);
      }
      const key = `${id}|${repeat}`;
      const hit = byKey.get(key);
      if (hit) return hit;

      const created = context.createPattern(get(id), repeat);
      if (!created) {
        throw new Error(`pop/textures: could not create a "${repeat}" pattern for "${id}"`);
      }
      const k = bakedScale.get(id) ?? 1;
      if (k !== 1) {
        // Undo the bake scale so the tile repeats at its logical period, and
        // callers never have to know what resolution it was baked at.
        const inv = 1 / k;
        created.setTransform({ a: inv, b: 0, c: 0, d: inv, e: 0, f: 0 });
      }
      byKey.set(key, created);
      return created;
    },

    size(id: TextureId): number {
      return SPECS[id].size;
    },

    warm(): void {
      for (let i = 0; i < ALL_IDS.length; i++) get(ALL_IDS[i]);
    },

    warmStep(budgetMs: number, maxItems = 64): number {
      const started = nowMs();
      let slices = 0;
      // `maxItems` counts *slices*, not textures: the heavy tiles are suspendable
      // between phases precisely so a 100 ms bake cannot land whole on a frame.
      const cap = Math.max(1, maxItems) * 4;
      while (warmCursor < ALL_IDS.length) {
        if (slices > 0 && (slices >= cap || nowMs() - started >= budgetMs)) break;
        const id = ALL_IDS[warmCursor];
        if (cache.has(id)) {
          warmCursor += 1;
          continue;
        }
        if (!active) {
          const begun = beginBake(id);
          if (!begun) {
            // A one-shot baker: it has already published.
            warmCursor += 1;
            slices += 1;
            continue;
          }
          active = { id, surface: begun.surface, iter: begun.iter };
        }
        if (active.iter.next().done) {
          publish(active.id, active.surface);
          active = null;
          warmCursor += 1;
        }
        slices += 1;
      }
      let pending = 0;
      for (let i = 0; i < ALL_IDS.length; i++) if (!cache.has(ALL_IDS[i])) pending += 1;
      return pending;
    },

    get pending(): number {
      let n = 0;
      for (let i = 0; i < ALL_IDS.length; i++) if (!cache.has(ALL_IDS[i])) n += 1;
      return n;
    },

    get total(): number {
      return ALL_IDS.length;
    },
  };
}

/** Monotonic milliseconds, or 0 where `performance` does not exist. */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
}
