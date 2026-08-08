/**
 * POP — the television studio.
 *
 * Everything behind the play field: the room, the LED video wall, the overhead
 * rig, the audience, the set dressing and the polished floor, plus the light
 * and atmosphere that ties them together.
 *
 * The set is built as eight parallax depths, back to front (the number is the
 * plane's depth, 0 = far wall, 1 = the lens):
 *
 *   0.12  room shell, LED video wall, acoustic foam, aluminium trim, signage
 *   0.20  audience row 4 — the farthest, smallest, most defocused
 *   0.25  audience row 3
 *   0.31  audience row 2
 *   0.36  audience row 1 — the closest, sharpest, largest
 *   0.52  stage apron and the polished concrete deck below `scene.stageY`
 *   0.80  overhead truss, fixtures, catenary cables
 *   1.00  defocused foreground furniture at the frame edges
 *
 * Everything static is baked once into offscreen layers (`ensureLayers`) and
 * composited with one `drawImage` per plane. Only light, haze, crowd motion,
 * the wall feed and the floor reflection are recomputed per frame.
 *
 * Lighting is genuinely volumetric: five key lights each own a baked cone
 * sprite whose alpha encodes the angular profile and the inverse-square
 * falloff, they are accumulated additively into a half-resolution haze buffer,
 * and that buffer is then multiplied by two independently drifting seamless
 * noise masks. The result is turbulence in the shafts that moves through the
 * beam rather than with it — the cue that reads as air.
 *
 * The floor reflection is screen space: `drawForeground` runs after the cards,
 * the desk and the effects, so it samples the frame above the stage line,
 * mirrors it, smears it vertically (polished concrete is anisotropic) and adds
 * it back below the line. Nothing about the play field has to be known here.
 *
 * Hard rules honoured: no `Math.random` (every stochastic decision comes from
 * the injected `Rng`), no DOM at module scope (surfaces are created lazily on
 * the first draw), nothing heavy allocates per frame, `scene.quality` selects a
 * tier table and `scene.reducedMotion` removes shake, glitch, strobing and ~70 %
 * of the particles while leaving the composition identical.
 */

import { clamp, clamp01, createSpring, damp, ease, lerp, mixColor, shade, smoothstep, smootherstep, withAlpha } from "../engine/core";
import type {
  Noise,
  QualityTier,
  RenderDeps,
  Rng,
  SceneContext,
  Spring,
  StudioRenderer,
  TextureId,
} from "./types";

/* ------------------------------------------------------------------ *
 * Palette — hemi orange is the only saturated hue in the room
 * ------------------------------------------------------------------ */

const CHARCOAL = "#080604";
const ALUMINIUM = "#8d8781";
const ALUMINIUM_DARK = "#4b4642";
const BONE = "#efe7e0";
const HEMI = "#ff4600";
const HEMI_HOT = "#ff2a00";

// Pre-built translucent bone tints: the wall feed repaints every frame and
// must not build a CSS string while doing it.
const BONE_40 = withAlpha(BONE, 0.4);
const BONE_18 = withAlpha(BONE, 0.18);

/**
 * Key-light colour temperature ramp: cool practical → bone → warm tungsten.
 *
 * The hot stop is deliberately *not* hemi orange. Light in this room is
 * tungsten: warm white, never gelled. A saturated orange emitter turns every
 * surface it touches orange, which is how the set once ended up with 98 % of
 * its pixels above HSV saturation 0.12 and no neutral left anywhere. Hemi
 * orange stays where it is *motivated* — the LED wall, the tape at the apron
 * base, the trim accent, the tally, the cards — and reads precisely because the
 * light around it does not compete.
 *
 * The correction to that failure then over-shot: pulling the emitters to a
 * near-neutral daylight left the room reading as cool grey, which is not a
 * tungsten studio either. These three stops are a real lamp's locus — roughly
 * 3000 K, 3400 K and 2700 K — so the *white balance* is warm while the chroma
 * on any surface the light lands on stays low. Warmth is hue, not saturation.
 */
const LIGHT_COOL = "#d6d2ca";
const LIGHT_BONE = "#f8efe2";
const LIGHT_HOT = "#ffcfb2";

/**
 * The three stops every tinted sprite set is baked at: tungsten practical,
 * bone key, warm tungsten. Any light colour in the room is a blend of two
 * adjacent stops, which is what keeps the palette closed.
 */
const TINT_CSS = ["rgb(214,210,202)", "rgb(248,239,226)", "rgb(255,218,197)"] as const;

const TAU = Math.PI * 2;
const FONT_STACK = '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif';

/** Two-digit zero pad, for the standby slate's hardware timecode. */
function pad2(v: number): string {
  const n = v < 0 ? 0 : v | 0;
  return n < 10 ? `0${n}` : String(n);
}

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT_STACK}`;
}

/* ------------------------------------------------------------------ *
 * Quality tiers
 * ------------------------------------------------------------------ */

interface TierSettings {
  /** Bake multiplier applied on top of the detected device scale. */
  bake: number;
  /** Haze accumulation buffer downscale relative to the logical frame. */
  hazeDiv: number;
  /** Number of drifting noise masks multiplied into the haze buffer. */
  hazeMasks: number;
  /** Active key lights (they are ordered most- to least-important). */
  lights: number;
  /** Audience tiers drawn, from the front. */
  crowdTiers: number;
  crowdDensity: number;
  /** Screen-space floor reflection. */
  reflection: boolean;
  reflectDiv: number;
  /** Defocused foreground bokeh count. */
  bokeh: number;
  phones: boolean;
  /** Anamorphic star flare on the fixtures pointing at camera. */
  lampFlare: boolean;
  /** Bake scale for the analytic light-shaft sprite. */
  shaftBake: number;
  /** Bake scale for the tiling haze noise mask. */
  maskBake: number;
}

const QUALITY: Record<QualityTier, TierSettings> = {
  low: {
    bake: 0.8,
    hazeDiv: 3.2,
    hazeMasks: 1,
    lights: 3,
    crowdTiers: 3,
    crowdDensity: 0.8,
    reflection: false,
    reflectDiv: 8,
    bokeh: 0,
    phones: false,
    lampFlare: false,
    shaftBake: 0.3,
    maskBake: 0.375,
  },
  medium: {
    bake: 1,
    hazeDiv: 2.4,
    hazeMasks: 2,
    lights: 4,
    crowdTiers: 4,
    crowdDensity: 0.92,
    reflection: true,
    reflectDiv: 6,
    bokeh: 3,
    phones: true,
    lampFlare: false,
    shaftBake: 0.4,
    maskBake: 0.5,
  },
  high: {
    bake: 1,
    hazeDiv: 2,
    hazeMasks: 2,
    lights: 5,
    crowdTiers: 4,
    crowdDensity: 1,
    reflection: true,
    reflectDiv: 5,
    bokeh: 5,
    phones: true,
    lampFlare: true,
    shaftBake: 0.5,
    maskBake: 0.5,
  },
  ultra: {
    bake: 1.25,
    hazeDiv: 1.6,
    hazeMasks: 2,
    lights: 5,
    crowdTiers: 4,
    crowdDensity: 1.15,
    reflection: true,
    reflectDiv: 4,
    bokeh: 7,
    phones: true,
    lampFlare: true,
    shaftBake: 0.6,
    maskBake: 0.625,
  },
};

/* ------------------------------------------------------------------ *
 * Offscreen surfaces (lazy — nothing here runs at module scope)
 * ------------------------------------------------------------------ */

interface Surface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  /** Backing store size, device pixels. */
  w: number;
  h: number;
  /** Authoring size, logical pixels. */
  lw: number;
  lh: number;
  /** w / lw. */
  k: number;
}

/**
 * Creates a surface authored in `lw × lh` logical pixels but backed by `k×` that
 * many device pixels. The returned context is pre-transformed into logical
 * units, so every bake routine draws in design coordinates and never has to
 * think about the device pixel ratio. Returns `null` rather than throwing when
 * no canvas implementation exists, which keeps the module import-safe on the
 * server; the caller simply skips drawing.
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

  const realK = w / lw;
  ctx.setTransform(realK, 0, 0, h / lh, 0, 0);
  return { canvas, ctx, w, h, lw, lh, k: realK };
}

/** Wipes a surface and restores its logical transform. */
function resetSurface(s: Surface): void {
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = "source-over";
  s.ctx.clearRect(0, 0, s.w, s.h);
  s.ctx.setTransform(s.w / s.lw, 0, 0, s.h / s.lh, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Depth of field — deterministic wide blur by resolution pyramid
 * ------------------------------------------------------------------ */

/** Hard ceiling on pyramid depth: beyond this the top level is a few pixels. */
const BLUR_MAX_LEVELS = 6;

/** Monotonic milliseconds, or 0 where `performance` does not exist. */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
}

/** A bare device-pixel scratch surface, logical units equal to real ones. */
function scratchSurface(w: number, h: number): Surface | null {
  const s = createSurface(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), 1);
  if (s) {
    s.ctx.imageSmoothingEnabled = true;
    // "low" is plain bilinear on every engine. "high" would pick a different
    // (browser-specific) kernel and cost more for a result nobody can see once
    // it has been through five more levels of the pyramid.
    s.ctx.imageSmoothingQuality = "low";
  }
  return s;
}

/** Halves a surface. At exactly 0.5 a bilinear tap set *is* a 2x2 box average. */
function halveSurface(src: Surface): Surface | null {
  const out = scratchSurface(Math.max(1, Math.floor(src.w / 2)), Math.max(1, Math.floor(src.h / 2)));
  if (!out) return null;
  out.ctx.drawImage(src.canvas, 0, 0, out.w, out.h);
  return out;
}

/** Doubles back up to (w, h), one power of two at a time. */
function expandSurface(src: Surface, w: number, h: number): Surface {
  let cur = src;
  // Guarded rather than `while (true)`: a failed allocation returns whatever
  // resolution we reached, which still composites correctly, just softer.
  for (let guard = 0; guard < BLUR_MAX_LEVELS + 2 && (cur.w < w || cur.h < h); guard++) {
    const nw = Math.min(w, cur.w * 2);
    const nh = Math.min(h, cur.h * 2);
    const next = scratchSurface(nw, nh);
    if (!next) return cur;
    next.ctx.drawImage(cur.canvas, 0, 0, nw, nh);
    cur = next;
  }
  return cur;
}

/**
 * Blurs a surface in place by `logicalRadius` design pixels.
 *
 * The obvious implementation — read the pixels back, run a separable box kernel
 * over them in JS, write them again — is the one thing a canvas cannot afford.
 * `getImageData` forces a full pipeline flush and a readback of the backing
 * store; profiled on a software rasteriser it cost **1.5 seconds per call**,
 * and the five calls a set bake makes were 23 of the 25 seconds it took. The
 * arithmetic was never the problem: the three box passes themselves measured
 * under 100 ms for the whole set.
 *
 * So no pixel ever leaves the GPU. The surface is halved repeatedly with the
 * built-in bilinear filter — at a scale factor of exactly 0.5 that is a 2x2 box
 * average, i.e. a clean low-pass of the level above — and then reconstructed by
 * successive doublings, whose bilinear interpolation is a tent filter. L levels
 * give a gaussian-equivalent sigma of about 0.6 * 2^L.
 *
 * Powers of two alone would quantise the radius, which would flatten the
 * audience's per-row defocus into three identical rows, so the two straddling
 * levels are both reconstructed and cross-faded by the fractional part. The
 * cross-fade is done as `(1-f)*lo` then `+f*hi` under "lighter", which is a true
 * lerp of premultiplied pixels — plain source-over would not be, wherever alpha
 * is partial.
 *
 * Everything is a whole-surface `drawImage`, so edges clamp for free (there are
 * no offset taps to shift transparency inward) and alpha stays premultiplied
 * throughout, which is what keeps a dark silhouette on a transparent field from
 * defocusing into a grey halo.
 */
function blurSurface(s: Surface, logicalRadius: number): void {
  const sigma = logicalRadius * s.k;
  if (!(sigma > 0.5) || s.w < 8 || s.h < 8) return;

  // sigma = 0.6 * 2^level  =>  level = log2(sigma / 0.6).
  const exact = Math.log2(sigma / 0.6);
  const hi = clamp(Math.ceil(exact), 1, BLUR_MAX_LEVELS);
  // Weight of the *upper* level. At hi === 1 and a small radius this fades the
  // blur in against the untouched image, which is exactly what a sub-pixel
  // defocus looks like.
  const mix = clamp01(1 - (hi - exact));

  // Level 0 is a copy, because the composite at the end overwrites `s` and the
  // lower of the two straddling levels may be the original resolution.
  const base = scratchSurface(s.w, s.h);
  if (!base) return;
  base.ctx.drawImage(s.canvas, 0, 0, s.w, s.h);

  let top = base;
  let below = base;
  for (let i = 1; i <= hi; i++) {
    const next = halveSurface(top);
    if (!next) break;
    below = top;
    top = next;
    if (top.w < 2 || top.h < 2) break;
  }

  const upper = expandSurface(top, s.w, s.h);
  const lower = below === top ? base : expandSurface(below, s.w, s.h);

  const ctx = s.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, s.w, s.h);
  if (mix < 0.999) {
    ctx.globalAlpha = 1 - mix;
    ctx.drawImage(lower.canvas, 0, 0, s.w, s.h);
  }
  if (mix > 0.001) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = mix;
    ctx.drawImage(upper.canvas, 0, 0, s.w, s.h);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(s.w / s.lw, 0, 0, s.h / s.lh, 0, 0);
}

/**
 * Rebalances a baked layer to the room's white point, in place, keeping its
 * luminance and its alpha exactly. Two controls, applied in this order:
 *
 * 1. **Chroma scale** (`desat`). The set is authored in warm neutrals, but
 *    "warm neutral" written as CSS literals drifts: a charcoal of
 *    `rgb(18,16,14)` measures HSV saturation 0.22, and once forty such literals
 *    are stacked under an additive key nothing in the frame is neutral any
 *    more. One pass through the `saturation` blend mode against neutral grey is
 *    a true luminance-preserving chroma scale, and it takes the accumulated
 *    hue drift out without hand-tuning every literal.
 *
 * 2. **White balance** (`warm`). Step 1 on its own is what turned the room cool
 *    grey: it removes the drift *and* the tungsten the set is supposed to be lit
 *    by, leaving a daylight-balanced charcoal. So the neutralised layer is put
 *    back on a lamp locus by a sepia matrix, which is a channel rebalance — a
 *    single warm axis at low amplitude, i.e. exactly a white-balance move, not
 *    a hue rotation that invents orange where there was none. A neutral input
 *    at `warm = w` comes out at a red/blue ratio of
 *    `(1 + 0.351w) / (1 - 0.063w)`: 1.11 at 0.3, 1.17 at 0.4. That is a warm
 *    grey, not an orange one, and it holds under the chroma-selective grade the
 *    post chain runs afterwards.
 *
 * Two surfaces are needed because the blend has to happen on an opaque copy:
 * `saturation` composites source-over, so filling a layer that has transparent
 * regions would turn them opaque grey. Both steps are done on the copy and put
 * back through `source-atop`, which is masked by the layer's own alpha.
 *
 * Bake time only — nothing here runs per frame.
 */
function balanceSurface(s: Surface, desat: number, warm: number): void {
  const k = clamp01(desat);
  const t = clamp01(warm);
  if ((!(k > 0.002) && !(t > 0.002)) || s.w < 2 || s.h < 2) return;
  const tmp = scratchSurface(s.w, s.h);
  if (!tmp) return;
  tmp.ctx.drawImage(s.canvas, 0, 0, s.w, s.h);
  if (k > 0.002) {
    tmp.ctx.globalCompositeOperation = "saturation";
    tmp.ctx.globalAlpha = k;
    tmp.ctx.fillStyle = "#808080";
    tmp.ctx.fillRect(0, 0, tmp.w, tmp.h);
    tmp.ctx.globalAlpha = 1;
    tmp.ctx.globalCompositeOperation = "source-over";
  }
  if (t > 0.002) {
    // A second scratch: `drawImage` from a canvas onto itself under a filter is
    // legal but forces an implicit snapshot, and the cost of that snapshot is
    // the whole reason the blur path avoids readbacks.
    const gel = scratchSurface(s.w, s.h);
    if (gel) {
      gel.ctx.filter = `sepia(${t.toFixed(3)})`;
      gel.ctx.drawImage(tmp.canvas, 0, 0, s.w, s.h);
      gel.ctx.filter = "none";
      tmp.ctx.globalCompositeOperation = "copy";
      tmp.ctx.drawImage(gel.canvas, 0, 0, s.w, s.h);
      tmp.ctx.globalCompositeOperation = "source-over";
    }
  }

  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalAlpha = 1;
  // source-atop keeps the destination's alpha, so a silhouette on a
  // transparent field never grows a grey halo.
  s.ctx.globalCompositeOperation = "source-atop";
  s.ctx.drawImage(tmp.canvas, 0, 0, s.w, s.h);
  s.ctx.globalCompositeOperation = "source-over";
  s.ctx.setTransform(s.w / s.lw, 0, 0, s.h / s.lh, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Small drawing utilities
 * ------------------------------------------------------------------ */

/**
 * Exact catenary sag, normalised to 1 at mid-span and 0 at both ends.
 *
 * A hanging cable is `y = a·cosh(x/a)`; solving for `a` from a required sag
 * needs iteration, so instead the shape is parameterised by the dimensionless
 * half-span ratio `k = L / (2a)`. `k → 0` degenerates to a parabola and `k ≈ 2`
 * is the taut-but-loaded droop of a studio drop cable.
 */
/**
 * Vertical camber of the main truss chord at `x`.
 *
 * A straight run photographed on a wide lens never stays straight, and the
 * fixtures are clamped to the chord — so the bow has to be shared between the
 * baked rig and the live fixture positions or the lamps float off the truss.
 */
function trussBow(x: number, width: number, sy: number): number {
  const n = (x / width) * 2 - 1;
  return -n * n * 5 * sy;
}

function catenary(t: number, k: number): number {
  const ch = Math.cosh(k);
  return (Math.cosh(k * (2 * t - 1)) - ch) / (1 - ch);
}

/** Draws a metal tube as a stroked line shaded across its width. */
function strokeTube(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  base: string,
  lit: string,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  // Shade across the tube: the gradient runs along the surface normal so the
  // specular line sits at a constant fraction of the diameter for any angle.
  const nx = (-dy / l) * r;
  const ny = (dx / l) * r;
  const g = ctx.createLinearGradient(x0 - nx, y0 - ny, x0 + nx, y0 + ny);
  g.addColorStop(0, shade(base, -0.62));
  g.addColorStop(0.26, lit);
  g.addColorStop(0.42, base);
  g.addColorStop(0.78, shade(base, -0.5));
  g.addColorStop(1, shade(base, -0.82));
  ctx.strokeStyle = g;
  ctx.lineWidth = r * 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Rounded rectangle path (no `roundRect` dependency — Safari 16 lacks it). */
function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, Math.abs(w) * 0.5, Math.abs(h) * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

interface TextLayout {
  advances: number[];
  total: number;
}

/**
 * Broadcast typography wants tight, explicit tracking, and `ctx.letterSpacing`
 * is not universally available — so characters are placed by hand. Layouts are
 * memoised per (font, tracking, string) because the LED wall re-renders its
 * ident every frame.
 */
function measureTracked(
  ctx: CanvasRenderingContext2D,
  cache: Map<string, TextLayout>,
  text: string,
  tracking: number,
): TextLayout {
  const key = `${ctx.font}|${tracking}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const advances: number[] = [];
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const w = ctx.measureText(text.charAt(i)).width;
    advances.push(w);
    total += w + (i < text.length - 1 ? tracking : 0);
  }
  const layout: TextLayout = { advances, total };
  if (cache.size > 256) cache.clear();
  cache.set(key, layout);
  return layout;
}

function fillTracked(
  ctx: CanvasRenderingContext2D,
  cache: Map<string, TextLayout>,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: "left" | "center" | "right",
): number {
  const layout = measureTracked(ctx, cache, text, tracking);
  let cx = align === "center" ? x - layout.total * 0.5 : align === "right" ? x - layout.total : x;
  const prev = ctx.textAlign;
  ctx.textAlign = "left";
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text.charAt(i), cx, y);
    cx += layout.advances[i] + tracking;
  }
  ctx.textAlign = prev;
  return layout.total;
}

/**
 * Replaces a surface's RGB while keeping its alpha. Canvas has no tint for
 * `drawImage`, and `fillStyle` is ignored by it — so a white sprite that needs
 * to be coloured must be re-baked, once, per colour it will ever be.
 */
function tintSurface(s: Surface, css: string): void {
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalCompositeOperation = "source-in";
  s.ctx.fillStyle = css;
  s.ctx.fillRect(0, 0, s.w, s.h);
  s.ctx.globalCompositeOperation = "source-over";
  s.ctx.setTransform(s.w / s.lw, 0, 0, s.h / s.lh, 0, 0);
}

/**
 * Draws a three-tint sprite set at an arbitrary colour temperature by
 * cross-fading the two adjacent copies additively. The blend happens in the
 * compositor, so a light can slide from aluminium through bone to hemi orange
 * without a single per-frame allocation.
 */
function drawTinted(
  ctx: CanvasRenderingContext2D,
  set: readonly Surface[],
  warmth: number,
  alpha: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const t = clamp01(warmth);
  const lo = t < 0.5 ? 0 : 1;
  const f = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  // Skip a copy whose weight would round away: when the colour sits on a stop
  // this halves the fill cost, and it is the common case.
  const a0 = clamp01(alpha * (1 - f));
  const a1 = clamp01(alpha * f);
  if (a0 > 0.002) {
    ctx.globalAlpha = a0;
    ctx.drawImage(set[lo].canvas, x, y, w, h);
  }
  if (a1 > 0.002) {
    ctx.globalAlpha = a1;
    ctx.drawImage(set[lo + 1].canvas, x, y, w, h);
  }
  ctx.globalAlpha = 1;
}

/** 24-step colour ramp so per-frame tints never build a CSS string. */
const RAMP_STEPS = 24;

function buildRamp(a: string, b: string, c: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < RAMP_STEPS; i++) {
    const t = i / (RAMP_STEPS - 1);
    out.push(t < 0.5 ? mixColor(a, b, t * 2, "oklab") : mixColor(b, c, (t - 0.5) * 2, "oklab"));
  }
  return out;
}

function rampAt(ramp: readonly string[], t: number): string {
  return ramp[clamp(Math.round(clamp01(t) * (RAMP_STEPS - 1)), 0, RAMP_STEPS - 1)];
}

/* ------------------------------------------------------------------ *
 * Set geometry
 * ------------------------------------------------------------------ */

/**
 * Every measurement is authored against the 1000 × 620 design frame with the
 * stage line at y = 548, then scaled. Horizontal scale follows the width;
 * vertical scale follows the stage line so the set always meets the floor
 * exactly where the game says it does.
 */
interface Geometry {
  w: number;
  h: number;
  stageY: number;
  sx: number;
  sy: number;
  rigH: number;
  wallTopY: number;
  ledX: number;
  ledY: number;
  ledW: number;
  ledH: number;
  trimY: number;
  trimH: number;
  crowdTop: number;
  apronY: number;
  stageTop: number;
  floorH: number;
  foamRight: number;
  foamLeft: number;
}

function buildGeometry(w: number, h: number, stageY: number): Geometry {
  const sx = w / 1000;
  const sy = stageY / 548;
  const ledX = 132 * sx;
  const ledW = 736 * sx;
  return {
    w,
    h,
    stageY,
    sx,
    sy,
    rigH: 128 * sy,
    wallTopY: 96 * sy,
    ledX,
    ledY: 112 * sy,
    ledW,
    ledH: 206 * sy,
    trimY: 318 * sy,
    trimH: 34 * sy,
    crowdTop: 352 * sy,
    apronY: 472 * sy,
    stageTop: 388 * sy,
    floorH: Math.max(8, h - stageY),
    foamLeft: ledX - 10 * sx,
    foamRight: ledX + ledW + 10 * sx,
  };
}

/* ------------------------------------------------------------------ *
 * Crowd
 * ------------------------------------------------------------------ */

/** Authoring cell for one audience member, in logical pixels at tier scale 1. */
const CELL_W = 76;
const CELL_H = 104;
const CROWD_VARIANTS = 18;

interface PersonSpec {
  headY: number;
  headR: number;
  headSquash: number;
  neckLen: number;
  neckHalf: number;
  shoulderHalf: number;
  shoulderDrop: number;
  shoulderRound: number;
  hipHalf: number;
  lean: number;
  hair: number;
  arm: number;
  /** Per-body rim-light offset jitter, in cell pixels. */
  rimJitterX: number;
  rimJitterY: number;
  /** Normalised phone position inside the cell, when the person has one. */
  phoneX: number;
  phoneY: number;
}

interface CrowdTier {
  /** 0 = furthest. */
  index: number;
  /** Half-open range into `people`, which is built tier-major. */
  from: number;
  to: number;
  baseline: number;
  scale: number;
  blur: number;
  tint: string;
  rim: number;
  depth: number;
  count: number;
}

interface Person {
  tier: number;
  variant: number;
  x: number;
  baseY: number;
  scale: number;
  flip: boolean;
  phase: number;
  freq: number;
  ampX: number;
  ampY: number;
  phone: boolean;
  /** Seconds of the phone's on/off cycle offset, so screens are uncorrelated. */
  phoneOffset: number;
  phonePeriod: number;
}

/**
 * Builds one audience member's proportions. Every axis is jittered
 * independently — height, head size, head roundness, shoulder width, shoulder
 * slope, neck, posture lean, hairline — which is what stops a crowd reading as
 * a stamped repeat. Eighteen of these, mirrored, at four depths, with per-body
 * scale jitter gives roughly 1400 distinguishable silhouettes.
 */
function makePerson(rng: Rng): PersonSpec {
  const headR = rng.range(0.062, 0.098);
  const shoulderHalf = headR * rng.range(1.7, 2.95);
  return {
    headY: rng.range(0.12, 0.235),
    headR,
    headSquash: rng.range(0.78, 1.02),
    neckLen: rng.range(0.012, 0.036),
    neckHalf: headR * rng.range(0.36, 0.52),
    shoulderHalf,
    shoulderDrop: headR * rng.range(0.22, 0.62),
    shoulderRound: headR * rng.range(0.3, 0.95),
    hipHalf: shoulderHalf * rng.range(0.82, 1.1),
    lean: rng.range(-0.085, 0.085),
    hair: rng.int(0, 7),
    // Raised arms are rare: a couple per row reads as a live audience, a dozen
    // reads as a stadium wave.
    arm: rng.next() < 0.16 ? rng.int(1, 2) : 0,
    rimJitterX: rng.range(-0.45, 0.45),
    rimJitterY: rng.range(-0.35, 0.3),
    phoneX: 0,
    phoneY: 0,
  };
}

/** Fills one silhouette. Called three times per person to build the rim light. */
function paintSilhouette(
  ctx: CanvasRenderingContext2D,
  p: PersonSpec,
  cw: number,
  ch: number,
  ox: number,
  oy: number,
  colour: string,
): void {
  const cx = cw * 0.5 + ox;
  const bottom = ch + oy;
  const hy = ch * p.headY + oy;
  const hr = ch * p.headR;
  const neckY = hy + hr * 0.88;
  const shoulderY = neckY + ch * p.neckLen;
  const drop = ch * 0.012 + p.shoulderDrop * ch * 0.4;
  const sh = p.shoulderHalf * ch;
  const hip = p.hipHalf * ch;
  const neck = p.neckHalf * ch;
  const round = p.shoulderRound * ch * 0.5;
  // Posture lean: shift x proportionally to the height above the seat, so the
  // body pivots at the hips instead of sliding sideways.
  const shX = (y: number): number => cx + p.lean * (bottom - y);

  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;

  ctx.beginPath();
  ctx.moveTo(shX(bottom) - hip, bottom);
  ctx.lineTo(shX(shoulderY + drop) - sh, shoulderY + drop);
  ctx.quadraticCurveTo(shX(shoulderY) - sh * 0.93, shoulderY - round, shX(neckY) - neck, neckY);
  ctx.lineTo(shX(neckY) + neck, neckY);
  ctx.quadraticCurveTo(shX(shoulderY) + sh * 0.93, shoulderY - round, shX(shoulderY + drop) + sh, shoulderY + drop);
  ctx.lineTo(shX(bottom) + hip, bottom);
  ctx.closePath();
  ctx.fill();

  // Head.
  ctx.beginPath();
  ctx.ellipse(shX(hy), hy, hr * p.headSquash, hr, 0, 0, TAU);
  ctx.fill();

  // Hair / headgear. Each style is a small stack of primitives in the same
  // colour, so they merge into a single opaque silhouette.
  const hx = shX(hy);
  switch (p.hair) {
    case 1: {
      // Short crop, slightly proud of the skull.
      ctx.beginPath();
      ctx.ellipse(hx, hy - hr * 0.14, hr * p.headSquash * 1.06, hr * 1.02, 0, Math.PI, TAU);
      ctx.fill();
      break;
    }
    case 2: {
      // Bun.
      ctx.beginPath();
      ctx.ellipse(hx, hy - hr * 0.1, hr * p.headSquash * 1.04, hr, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx - hr * 0.72, hy - hr * 0.86, hr * 0.44, 0, TAU);
      ctx.fill();
      break;
    }
    case 3: {
      // Full volume.
      ctx.beginPath();
      ctx.ellipse(hx, hy - hr * 0.16, hr * 1.4, hr * 1.3, 0, 0, TAU);
      ctx.fill();
      break;
    }
    case 4: {
      // Cap with a brim.
      ctx.beginPath();
      ctx.ellipse(hx, hy - hr * 0.12, hr * p.headSquash * 1.09, hr * 0.95, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(hx - hr * 0.2, hy - hr * 0.26);
      ctx.lineTo(hx - hr * 1.75, hy - hr * 0.06);
      ctx.lineTo(hx - hr * 1.72, hy + hr * 0.16);
      ctx.lineTo(hx - hr * 0.2, hy + hr * 0.04);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 5: {
      // Long, falling to the shoulders.
      ctx.beginPath();
      ctx.ellipse(hx, hy - hr * 0.12, hr * p.headSquash * 1.1, hr * 1.05, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(hx - hr * 1.05, hy - hr * 0.2);
      ctx.quadraticCurveTo(hx - hr * 1.5, shoulderY, hx - hr * 0.85, shoulderY + drop * 0.7);
      ctx.lineTo(hx - hr * 0.2, shoulderY);
      ctx.lineTo(hx - hr * 0.2, hy);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(hx + hr * 1.05, hy - hr * 0.2);
      ctx.quadraticCurveTo(hx + hr * 1.5, shoulderY, hx + hr * 0.85, shoulderY + drop * 0.7);
      ctx.lineTo(hx + hr * 0.2, shoulderY);
      ctx.lineTo(hx + hr * 0.2, hy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 6: {
      // Beanie with a rolled brim.
      ctx.beginPath();
      ctx.ellipse(hx, hy - hr * 0.26, hr * p.headSquash * 1.05, hr * 1.06, 0, Math.PI, TAU);
      ctx.fill();
      ctx.fillRect(hx - hr * 1.02, hy - hr * 0.42, hr * 2.04, hr * 0.34);
      break;
    }
    case 7: {
      // Headphones: band plus two cups.
      ctx.beginPath();
      ctx.ellipse(hx, hy - hr * 0.12, hr * p.headSquash * 1.04, hr, 0, Math.PI, TAU);
      ctx.fill();
      ctx.lineWidth = hr * 0.2;
      ctx.beginPath();
      ctx.arc(hx, hy - hr * 0.05, hr * 1.2, Math.PI * 1.12, TAU - Math.PI * 0.12);
      ctx.stroke();
      roundedPath(ctx, hx - hr * 1.34, hy - hr * 0.2, hr * 0.42, hr * 0.78, hr * 0.16);
      ctx.fill();
      roundedPath(ctx, hx + hr * 0.92, hy - hr * 0.2, hr * 0.42, hr * 0.78, hr * 0.16);
      ctx.fill();
      break;
    }
    default:
      break;
  }

  // Raised arm — a two-segment round-capped limb, which is enough of a cue at
  // this size and avoids the noodle look of a single straight stroke.
  if (p.arm > 0) {
    const side = p.arm === 1 ? 1 : -1;
    const sx0 = shX(shoulderY + drop) + side * sh * 0.86;
    const sy0 = shoulderY + drop * 0.9;
    const ex = sx0 + side * hr * 0.9;
    const eyy = sy0 - hr * 1.1;
    const handX = sx0 + side * hr * 0.35;
    const handY = hy - hr * 0.5;
    ctx.lineWidth = hr * 0.56;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(ex, eyy);
    ctx.lineTo(handX, handY);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ *
 * Rig
 * ------------------------------------------------------------------ */

interface Lamp {
  /** Yoke pivot, logical coordinates. */
  x: number;
  y: number;
  variant: number;
  /** Fixture scale. */
  scale: number;
  /** Rest aim, radians clockwise from straight down. */
  rest: number;
  swing: Spring;
  /** Independent noise offset for the idle air drift. */
  drift: number;
  /** Lamp length from pivot to lens, logical. */
  reach: number;
  /** Which key light, if any, this fixture emits. */
  light: number;
}

interface KeyLight {
  lamp: number;
  /** Authored half-angle of the cone, radians. Never mutated. */
  baseCone: number;
  /** Authored colour temperature, 0 = practical/cool, 1 = hot hemi. */
  baseWarmth: number;
  length: number;
  power: number;
  /** Drawn again in front of the play field. */
  front: boolean;
  seed: number;
  /** Live values, recomputed from the authored ones every update. */
  cone: number;
  warmth: number;
  x: number;
  y: number;
  angle: number;
  gain: number;
}

/* ------------------------------------------------------------------ *
 * Baked layer set
 * ------------------------------------------------------------------ */

/**
 * Reveal groups. A layer joins one; the group fades up over a few frames once
 * every layer in it has been baked, so a set that arrives over ten frames still
 * arrives as five deliberate cues rather than twenty pops.
 */
type RevealKey = "room" | "stage" | "crowd" | "rig" | "air" | "fore";

/** One unit of set construction. */
interface BakeStep {
  group: RevealKey;
  run(): void;
}

interface Layers {
  bake: number;
  quality: QualityTier;
  backdrop: Surface;
  ledOverlay: Surface;
  ledBars: Surface;
  ledContent: Surface;
  stage: Surface;
  rig: Surface;
  fore: Surface;
  lamps: Surface;
  lampRings: Surface[];
  crowd: Surface[];
  shafts: Surface[];
  hazeMask: Surface;
  hazeBand: Surface[];
  haze: Surface;
  hazeFront: Surface;
  hazePattern: CanvasPattern | null;
  hazeFrontPattern: CanvasPattern | null;
  reflect: Surface | null;
  reflectOut: Surface | null;
  reflectMask: Surface | null;
  gradeTop: Surface;
  floorSheen: Surface[];
  glowSet: Surface[];
  bokehSet: Surface[];
  /** Per-group fade-in, 0 = not yet built or just landed, 1 = fully live. */
  reveal: Record<RevealKey, number>;
}

const IMPACT_SLOTS = 8;

interface ImpactMark {
  x: number;
  y: number;
  force: number;
  age: number;
  live: boolean;
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

/**
 * `StudioRenderer` plus the boot hooks the composition root drives.
 *
 * The set is built over several frames under a budget the root owns, because
 * the root is the only thing that knows how much of the frame is already spent.
 * These members are additive: the object still satisfies the frozen
 * `StudioRenderer` contract, and any consumer holding that interface is
 * unaffected.
 */
export interface BootableStudio extends StudioRenderer {
  /**
   * Runs queued set construction for at most `budgetMs` (or `maxUnits` layers,
   * whichever comes first). Returns true once the set is complete. Safe to call
   * every frame forever; it is a no-op once the queue is empty.
   */
  bootStep(budgetMs: number, maxUnits?: number): boolean;
  /**
   * Draws the broadcast standby card, if it is still up. Call it *last*, after
   * the broadcast overlay: a switcher that has not taken the studio to air is
   * not showing the studio's graphics either. Outside any camera transform —
   * the truck's output does not shake with the set.
   */
  drawStandby(context: CanvasRenderingContext2D, scene: SceneContext): void;
  /** 0–1 construction progress. */
  readonly bootProgress: number;
  /** False while the standby card is still covering the frame. */
  readonly onAir: boolean;
}

export function createStudio(deps: RenderDeps): BootableStudio {
  const { bakery, noise, particles, camera } = deps;

  // Independent, salted streams: baking the crowd must never shift the lamp
  // layout, and neither may move the ambient dust emission sequence.
  const rngSet = deps.rng.fork(0x5354_4147);
  const rngCrowd = deps.rng.fork(0x4352_4f57);
  const rngRig = deps.rng.fork(0x5249_4747);
  const rngWall = deps.rng.fork(0x4c45_4457);
  const rngAir = deps.rng.fork(0x4149_5221);

  /* ---- colour ramps, built once, never per frame ------------------ */
  const keyRamp = buildRamp(LIGHT_COOL, LIGHT_BONE, LIGHT_HOT);
  const hazeRamp = buildRamp("#6a635c", "#b6ada2", "#efd3bf");
  // The floor ramp is the one that keeps a genuine hemi stop: its top is the
  // LED tape's own reflection in the deck, which is a motivated source.
  const floorRamp = buildRamp("#5b5751", "#c6bcb0", HEMI);
  const crowdRimRamp = buildRamp("#cfc7bd", "#f2dac6", "#ffceb6");

  /* ---- geometry & state ------------------------------------------ */
  let geo = buildGeometry(1000, 620, 548);
  /** The set being drawn. Half-built during a boot, always complete otherwise. */
  let layers: Layers | null = null;
  /** The set being constructed. Same object as `layers` during a boot. */
  let staging: Layers | null = null;
  /** True when `staging` is a *replacement* held back until it is complete. */
  let staged = false;
  let steps: BakeStep[] = [];
  let stepCursor = 0;
  let stepsTotal = 0;
  let dirty = true;
  let deviceScale = 1;
  let deviceScaleKnown = false;
  let quality: QualityTier = "high";
  let settings = QUALITY.high;
  let reduced = false;

  const textCache = new Map<string, TextLayout>();

  /* ---- animated state -------------------------------------------- */
  const lamps: Lamp[] = [];
  const lights: KeyLight[] = [];
  const people: Person[] = [];
  const tiers: CrowdTier[] = [];

  let time = 0;
  let rawTime = 0;
  let ledGlitch = 0;
  let ledGlitchSeed = 0;
  let dustTimer = 0;
  let flashTimer = 0;
  let floorHeat = 0;
  const phaseEnergy = createSpring({ stiffness: 42, damping: 12, mass: 1, initial: 0.55 });
  const pressure = createSpring({ stiffness: 30, damping: 10, mass: 1, initial: 0 });
  /** Clamped spring readings — springs overshoot, `globalAlpha` above 1 is ignored. */
  let energy = 0.55;
  let press = 0;

  /* ---- per-phase rig look ------------------------------------------
   * Four states that must be unmistakable from each other at a glance, all
   * recomputed every update from authored constants so nothing accumulates:
   *
   *   attract  house up, wide and cool — a lit set, composed as a title card
   *   playing  the show look; everything below is driven by `press`
   *   won      house up hard, wider, cooler, haze pulled, deck bright
   *   lost     the rig collapses: half power, tight, hot, thick smoke
   */
  let warmBias = 0;
  let coneBias = 1;
  let gainBias = 1;
  let hazeBias = 1;
  /** Ambient house-light wash, 0 during the show. */
  let houseLift = 0;
  let phoneSpecs: PersonSpec[] = [];

  const impacts: ImpactMark[] = [];
  for (let i = 0; i < IMPACT_SLOTS; i++) impacts.push({ x: 0, y: 0, force: 0, age: 0, live: false });
  let impactCursor = 0;

  /* ================================================================ *
   * Bakes
   * ================================================================ */

  /**
   * Room shell, LED cabinet recess, acoustic foam banks, aluminium trim and the
   * ident signage. One full-frame layer down to the stage line: everything on
   * it shares a plane to within a pixel of parallax, so splitting it would cost
   * a draw call for nothing.
   */
  function bakeBackdrop(s: Surface): void {
    const ctx = s.ctx;
    const { w, sx, sy, ledX, ledY, ledW, ledH, wallTopY, trimY, trimH } = geo;
    const H = s.lh;
    const rng = rngSet.fork(0x01);

    // --- base wall: a dark cyclorama with the video wall's spill baked in ---
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, "#050403");
    base.addColorStop(0.16, "#0a0807");
    base.addColorStop(0.52, "#12100e");
    base.addColorStop(0.82, "#0c0a09");
    base.addColorStop(1, "#070605");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, H);

    // Centre of illumination sits left of centre — see the side falloff below.
    const spillX = ledX + ledW * 0.42;
    const spillY = ledY + ledH * 0.5;
    const spill = ctx.createRadialGradient(spillX, spillY, ledH * 0.2, spillX, spillY, ledW * 0.86);
    spill.addColorStop(0, "rgba(120,101,88,0.34)");
    spill.addColorStop(0.45, "rgba(74,62,54,0.17)");
    spill.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = spill;
    ctx.fillRect(0, 0, w, H);

    // --- wall flats: the cyc is built from panels, so it has seams ---
    const flat = 86 * sx;
    ctx.lineWidth = Math.max(0.6, 1 * sx);
    for (let x = flat; x < w; x += flat) {
      ctx.strokeStyle = "rgba(0,0,0,0.42)";
      ctx.beginPath();
      ctx.moveTo(x, wallTopY);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.strokeStyle = "rgba(190,178,166,0.05)";
      ctx.beginPath();
      ctx.moveTo(x + 1 * sx, wallTopY);
      ctx.lineTo(x + 1 * sx, H);
      ctx.stroke();
    }

    // --- acoustic foam banks flanking the video wall ---
    const foamPat = bakery.pattern(ctx, "acoustic-fabric");
    const panel = 58 * sx;
    const gap = 5 * sx;
    const bankTop = wallTopY + 10 * sy;
    const bankBottom = trimY - 2 * sy;
    const banks: [number, number][] = [
      [0, geo.foamLeft],
      [geo.foamRight, w],
    ];
    for (let b = 0; b < banks.length; b++) {
      const [x0, x1] = banks[b];
      for (let py = bankTop; py < bankBottom - panel * 0.4; py += panel + gap) {
        for (let px = x0 + gap; px < x1 - panel * 0.4; px += panel + gap) {
          const pw = Math.min(panel, x1 - gap - px);
          const ph = Math.min(panel, bankBottom - py);
          if (pw < 6 || ph < 6) continue;
          // Alternate 90° rotations — the studio-foam checkerboard.
          const rot = ((px / (panel + gap)) | 0) + ((py / (panel + gap)) | 0);
          ctx.save();
          ctx.beginPath();
          ctx.rect(px, py, pw, ph);
          ctx.clip();
          ctx.translate(px + pw * 0.5, py + ph * 0.5);
          if (rot % 2 === 1) ctx.rotate(Math.PI * 0.5);
          ctx.fillStyle = foamPat;
          ctx.fillRect(-panel, -panel, panel * 2, panel * 2);
          ctx.restore();

          // Deepen it: foam is matte and eats light.
          ctx.fillStyle = "rgba(9,7,6,0.66)";
          ctx.fillRect(px, py, pw, ph);
          // Motivated key from the upper left, per panel.
          const lit = ctx.createLinearGradient(px, py, px + pw, py + ph);
          lit.addColorStop(0, "rgba(196,178,160,0.09)");
          lit.addColorStop(0.55, "rgba(120,104,92,0.03)");
          lit.addColorStop(1, "rgba(0,0,0,0.16)");
          ctx.fillStyle = lit;
          ctx.fillRect(px, py, pw, ph);
          // Bevel.
          ctx.fillStyle = "rgba(214,199,182,0.09)";
          ctx.fillRect(px, py, pw, Math.max(0.7, 1 * sy));
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(px, py + ph - Math.max(0.7, 1.4 * sy), pw, Math.max(0.7, 1.4 * sy));
        }
      }
    }

    // --- brushed aluminium trim ---
    const metalPat = bakery.pattern(ctx, "brushed-metal");
    const drawTrim = (y: number, hgt: number, hot: number): void => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, w, hgt);
      ctx.clip();
      ctx.fillStyle = metalPat;
      ctx.fillRect(0, y, w, hgt);
      // Aluminium extrusion: dark at the top, a hot specular band a third down,
      // then a long shaded roll-off. This is where the rig actually shows up.
      const g = ctx.createLinearGradient(0, y, 0, y + hgt);
      g.addColorStop(0, "rgba(10,8,7,0.86)");
      g.addColorStop(0.2, "rgba(30,27,24,0.42)");
      g.addColorStop(0.34, `rgba(236,226,214,${0.16 + hot * 0.22})`);
      g.addColorStop(0.42, "rgba(120,112,104,0.18)");
      g.addColorStop(0.72, "rgba(16,13,11,0.6)");
      g.addColorStop(1, "rgba(4,3,2,0.92)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y, w, hgt);
      ctx.restore();
      // Contact shadow under the extrusion.
      const sh = ctx.createLinearGradient(0, y + hgt, 0, y + hgt + 12 * sy);
      sh.addColorStop(0, "rgba(0,0,0,0.5)");
      sh.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = sh;
      ctx.fillRect(0, y + hgt, w, 12 * sy);
    };
    drawTrim(wallTopY, 14 * sy, 0.5);
    drawTrim(trimY, trimH, 1);
    // Extrusions are delivered in lengths and joined on site: break the run so
    // it stops reading as one continuous strip of tape across the frame.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    for (let jx = 118 * sx; jx < w; jx += 236 * sx) {
      ctx.fillRect(jx, trimY, 1.6 * sx, trimH);
      ctx.fillRect(jx + 1.6 * sx, trimY, 0.8 * sx, trimH * 0.5);
      ctx.fillRect(jx, wallTopY, 1.4 * sx, 14 * sy);
    }

    // --- vertical pilasters bracketing the video wall ---
    const pil = 12 * sx;
    for (const px of [ledX - pil - 4 * sx, ledX + ledW + 4 * sx]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, wallTopY, pil, trimY - wallTopY);
      ctx.clip();
      ctx.fillStyle = metalPat;
      ctx.fillRect(px, wallTopY, pil, trimY - wallTopY);
      const g = ctx.createLinearGradient(px, 0, px + pil, 0);
      g.addColorStop(0, "rgba(6,5,4,0.9)");
      g.addColorStop(0.34, "rgba(228,216,204,0.3)");
      g.addColorStop(0.5, "rgba(90,84,78,0.2)");
      g.addColorStop(1, "rgba(5,4,3,0.92)");
      ctx.fillStyle = g;
      ctx.fillRect(px, wallTopY, pil, trimY - wallTopY);
      ctx.restore();
    }

    // --- LED cabinet recess: the wall is inset into the flat ---
    const inset = 7 * sx;
    ctx.fillStyle = "#020202";
    ctx.fillRect(ledX - inset, ledY - inset, ledW + inset * 2, ledH + inset * 2);
    const bez = ctx.createLinearGradient(0, ledY - inset, 0, ledY + ledH + inset);
    bez.addColorStop(0, "rgba(150,140,130,0.2)");
    bez.addColorStop(0.06, "rgba(20,18,16,0.1)");
    bez.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = bez;
    ctx.fillRect(ledX - inset, ledY - inset, ledW + inset * 2, ledH + inset * 2);
    ctx.fillStyle = "#000000";
    ctx.fillRect(ledX, ledY, ledW, ledH);

    // --- ident signage on the trim band ---
    const signY = trimY + trimH * 0.5;
    ctx.textBaseline = "middle";
    ctx.font = font(800, 17 * sy);
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    fillTracked(ctx, textCache, "MWM", 268 * sx, signY + 1.2 * sy, 5 * sx, "center");
    ctx.fillStyle = withAlpha(BONE, 0.5);
    fillTracked(ctx, textCache, "MWM", 268 * sx, signY, 5 * sx, "center");
    ctx.font = font(600, 8.4 * sy);
    ctx.fillStyle = "rgba(180,168,156,0.4)";
    fillTracked(ctx, textCache, "COMMUNITY TAKEOVER", 268 * sx + 44 * sx, signY + 0.5 * sy, 2.2 * sx, "left");

    // ON AIR tally chassis — the lit face is drawn per frame.
    const tallyW = 96 * sx;
    const tallyH = 21 * sy;
    const tallyX = 660 * sx;
    const tallyY = trimY + (trimH - tallyH) * 0.5;
    ctx.fillStyle = "#0b0908";
    roundedPath(ctx, tallyX, tallyY, tallyW, tallyH, 2.5 * sx);
    ctx.fill();
    ctx.strokeStyle = "rgba(160,150,140,0.28)";
    ctx.lineWidth = Math.max(0.6, 1 * sx);
    ctx.stroke();

    // --- subtle debossed logo repeat on the lower wall, barely there ---
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.font = font(800, 13 * sy);
    for (let i = 0; i < 26; i++) {
      const lx = rng.range(6 * sx, w - 60 * sx);
      const ly = rng.range(wallTopY + 24 * sy, trimY - 12 * sy);
      if (lx > geo.foamLeft - 60 * sx && lx < geo.foamRight) continue;
      ctx.fillStyle = "#000000";
      fillTracked(ctx, textCache, "MWM", lx, ly + 1, 3 * sx, "left");
      ctx.fillStyle = "#8a7f74";
      fillTracked(ctx, textCache, "MWM", lx, ly, 3 * sx, "left");
    }
    ctx.restore();

    // --- final grade on the backdrop: darken the extremes, keep the centre ---
    const vign = ctx.createLinearGradient(0, 0, 0, H);
    vign.addColorStop(0, "rgba(0,0,0,0.55)");
    vign.addColorStop(0.24, "rgba(0,0,0,0.06)");
    vign.addColorStop(0.86, "rgba(0,0,0,0.12)");
    vign.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = vign;
    ctx.fillRect(0, 0, w, H);
    // Side falloff. Deliberately shallow: the post chain already runs a cos⁴
    // natural vignette over the finished frame, and a painted edge shade of the
    // same depth stacked underneath it took the frame's own left and right
    // margins to near black — which is exactly the strip of set the attract
    // screen's scrim leaves visible.
    const side = ctx.createLinearGradient(0, 0, w, 0);
    side.addColorStop(0, "rgba(0,0,0,0.3)");
    side.addColorStop(0.18, "rgba(0,0,0,0.02)");
    side.addColorStop(0.55, "rgba(0,0,0,0.05)");
    side.addColorStop(0.82, "rgba(0,0,0,0.12)");
    side.addColorStop(1, "rgba(0,0,0,0.32)");
    ctx.fillStyle = side;
    ctx.fillRect(0, 0, w, H);

    // --- reclaim the neutrals, then defocus the far wall ----------------
    // The room shell is the largest single area in frame; if it is warm the
    // whole picture is warm. It carries no motivated hemi source of its own —
    // the video wall is a separate live layer composited on top — so the whole
    // plane can go to a near-neutral charcoal.
    balanceSurface(s, 0.84, 0.0);

    // --- the one motivated accent on the room shell ---------------------
    // A cove of hemi LED tape washing the underside of both trim extrusions.
    // Every broadcast set has one, it is the cheapest brand surface a studio
    // owns, and it is the reason the upper half of the frame carries the show's
    // colour at all: the video wall is a separate layer and everything else up
    // here is aluminium. Laid down *after* the chroma scale so it keeps the full
    // stop — the set around it is neutral precisely so this can be seen.
    const cove = (y: number, hgt: number, power: number): void => {
      // The wash is kept short on purpose. A cove throws a bright, tight line
      // and a fast falloff; spreading it over the flat below would put low-grade
      // chroma across a large area of set, which is the wash this whole pass is
      // built to avoid. Brightness, not spread, is what makes it read.
      const wash = ctx.createLinearGradient(0, y + hgt, 0, y + hgt + 15 * sy);
      wash.addColorStop(0, withAlpha(HEMI, 0.26 * power));
      wash.addColorStop(0.4, withAlpha(HEMI, 0.07 * power));
      wash.addColorStop(1, withAlpha(HEMI, 0));
      ctx.fillStyle = wash;
      ctx.fillRect(0, y + hgt, w, 15 * sy);
      // The strip itself, recessed under the extrusion's lower lip.
      ctx.fillStyle = withAlpha(HEMI, 0.92 * power);
      ctx.fillRect(0, y + hgt - 1.6 * sy, w, 1.8 * sy);
      ctx.fillStyle = withAlpha("#ffcaa6", 0.7 * power);
      ctx.fillRect(0, y + hgt - 1.2 * sy, w, 0.7 * sy);
      // Broken by the same extrusion joints as the metal above it.
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      for (let jx = 118 * sx; jx < w; jx += 236 * sx) ctx.fillRect(jx, y + hgt - 2 * sy, 2.2 * sx, 2.6 * sy);
    };
    cove(trimY, trimH, 1);

    // Depth of field: this plane sits at depth 0.12, the furthest thing in the
    // room, and the play field is in focus at ~0.5. A far plane that resolves
    // its own panel seams harder than the cards in front of it is the single
    // most film-breaking thing a set can do.
    blurSurface(s, 1.35);
  }

  /**
   * The static half of the video wall: cabinet seams, the LED pitch grid, dead
   * pixels and the glass sheen. Composited over the live feed so the feed can
   * be a cheap low-resolution buffer and still read as a real panel.
   */
  function bakeLedOverlay(s: Surface): void {
    const ctx = s.ctx;
    const W = s.lw;
    const H = s.lh;
    const rng = rngWall.fork(0x11);

    // LED pitch: a fine dark grid. Anything coarser than ~3 logical px reads as
    // a screen door; anything finer disappears under the post chain's bloom.
    const pitch = 3;
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    for (let x = 0; x < W; x += pitch) ctx.fillRect(x, 0, 1, H);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    for (let y = 0; y < H; y += pitch) ctx.fillRect(0, y, W, 1);

    // Cabinet seams: 5 × 2 panels with a hairline gap and a lit lower lip.
    const cols = 5;
    const rows = 2;
    for (let i = 1; i < cols; i++) {
      const x = (i / cols) * W;
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      ctx.fillRect(x - 0.8, 0, 1.6, H);
      ctx.fillStyle = "rgba(150,140,130,0.07)";
      ctx.fillRect(x + 0.8, 0, 0.7, H);
    }
    for (let j = 1; j < rows; j++) {
      const y = (j / rows) * H;
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      ctx.fillRect(0, y - 0.8, W, 1.6);
      ctx.fillStyle = "rgba(150,140,130,0.07)";
      ctx.fillRect(0, y + 0.8, W, 0.7);
    }

    // Dead and stuck pixels — the detail that says "this panel has done a
    // thousand shows".
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = rng.next() < 0.75 ? "rgba(0,0,0,0.85)" : "rgba(255,70,0,0.5)";
      ctx.fillRect(Math.round(rng.range(0, W)), Math.round(rng.range(0, H)), 2, 2);
    }

    // Inner bezel shadow.
    const frame = ctx.createLinearGradient(0, 0, 0, H);
    frame.addColorStop(0, "rgba(0,0,0,0.5)");
    frame.addColorStop(0.07, "rgba(0,0,0,0)");
    frame.addColorStop(0.93, "rgba(0,0,0,0)");
    frame.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = frame;
    ctx.fillRect(0, 0, W, H);
    const frameX = ctx.createLinearGradient(0, 0, W, 0);
    frameX.addColorStop(0, "rgba(0,0,0,0.45)");
    frameX.addColorStop(0.05, "rgba(0,0,0,0)");
    frameX.addColorStop(0.95, "rgba(0,0,0,0)");
    frameX.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = frameX;
    ctx.fillRect(0, 0, W, H);

    // Front-glass sheen: a very shallow diagonal wipe, the reflection of the
    // room in the diffuser. Deliberately weak — it must never read as a gloss.
    const sheen = ctx.createLinearGradient(0, 0, W * 0.7, H);
    sheen.addColorStop(0, "rgba(232,224,214,0.055)");
    sheen.addColorStop(0.35, "rgba(232,224,214,0.012)");
    sheen.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);

    // The wall shares the far plane with the room shell, so its pitch grid and
    // cabinet seams get the same defocus. Without this the panel structure is
    // the crispest edge set in the picture and the wall reads as a sticker.
    blurSurface(s, 0.62);
  }

  /**
   * The scrolling bar pattern shown on the video wall. Baked as a strip whose
   * period divides its width exactly, so the feed can scroll it forever with
   * two draws and no seam.
   */
  function bakeLedBars(s: Surface): void {
    const ctx = s.ctx;
    const W = s.lw;
    const H = s.lh;
    const rng = rngWall.fork(0x12);
    const slots = 8;
    const slot = W / slots;
    const skew = H * 0.34;

    ctx.fillStyle = "#070504";
    ctx.fillRect(0, 0, W, H);

    // Weighted toward the house colour: this panel is the show's own graphics
    // package, not a test card, and it is the largest motivated hemi source in
    // the room. The greys between the hemi bands are what keep it reading as a
    // *screen* — an all-orange wall is a light box.
    const palette = ["#1a1512", "#2a231e", "#4a4038", HEMI, HEMI_HOT, "#5d5449", "#100d0b"];
    for (let i = 0; i < slots; i++) {
      const cx = (i + 0.5) * slot;
      const bw = rng.range(slot * 0.34, slot * 0.92);
      const colour = rng.pick(palette);
      const hot = colour === HEMI || colour === HEMI_HOT;
      // Draw at the wrapped offsets too, so a bar crossing the strip edge
      // reappears on the other side and the scroll stays seamless.
      for (let rep = -1; rep <= 1; rep++) {
        const x = cx + rep * W;
        const g = ctx.createLinearGradient(x - bw * 0.5, 0, x + bw * 0.5, 0);
        g.addColorStop(0, withAlpha(colour, 0));
        g.addColorStop(0.16, withAlpha(colour, hot ? 0.62 : 0.7));
        g.addColorStop(0.5, withAlpha(colour, hot ? 0.94 : 0.9));
        g.addColorStop(0.84, withAlpha(colour, hot ? 0.62 : 0.7));
        g.addColorStop(1, withAlpha(colour, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - bw * 0.5 + skew, 0);
        ctx.lineTo(x + bw * 0.5 + skew, 0);
        ctx.lineTo(x + bw * 0.5 - skew, H);
        ctx.lineTo(x - bw * 0.5 - skew, H);
        ctx.closePath();
        ctx.fill();
        // A hot leading edge on some bars: broadcast test patterns always have
        // one hard edge per band, and it is what makes the bloom pop.
        if (rng.next() < 0.45) {
          ctx.fillStyle = withAlpha(hot ? "#ffd0b0" : BONE, 0.3);
          ctx.beginPath();
          ctx.moveTo(x + bw * 0.5 + skew - 2, 0);
          ctx.lineTo(x + bw * 0.5 + skew, 0);
          ctx.lineTo(x + bw * 0.5 - skew, H);
          ctx.lineTo(x + bw * 0.5 - skew - 2, H);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Vertical falloff: real wall content is graded darker at the extremes.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0.42)");
    g.addColorStop(0.45, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * Stage apron, barrier rail, foldback monitors, cable runs, LED tape, the
   * stage nosing at `scene.stageY` and the polished concrete deck below it.
   * Drawn after the crowd, so it also occludes the front row's legs.
   */
  function bakeStage(s: Surface): void {
    const ctx = s.ctx;
    const { w, sx, sy, stageY, stageTop, apronY } = geo;
    const H = s.lh;
    const top = stageTop;
    const rng = rngSet.fork(0x02);
    // Local coordinates: the layer starts at `stageTop`, so subtract it.
    const y0 = (v: number): number => v - top;

    // --- apron face: the front of the audience riser block ---
    const apron = ctx.createLinearGradient(0, y0(apronY), 0, y0(stageY));
    apron.addColorStop(0, "#0b0908");
    apron.addColorStop(0.35, "#070605");
    apron.addColorStop(0.86, "#050404");
    apron.addColorStop(1, "#030202");
    ctx.fillStyle = apron;
    ctx.fillRect(0, y0(apronY), w, stageY - apronY);

    // Grazing light across the apron from the rig — a wide, weak wipe.
    const graze = ctx.createLinearGradient(0, y0(apronY), w * 0.8, y0(stageY));
    graze.addColorStop(0, "rgba(150,132,116,0.055)");
    graze.addColorStop(0.5, "rgba(90,78,68,0.018)");
    graze.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = graze;
    ctx.fillRect(0, y0(apronY), w, stageY - apronY);

    // --- riser nosing at the top of the apron ---
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(0, y0(apronY) - 3 * sy, w, 3 * sy);
    ctx.fillStyle = withAlpha(ALUMINIUM, 0.5);
    ctx.fillRect(0, y0(apronY), w, 2.2 * sy);
    ctx.fillStyle = withAlpha(BONE, 0.42);
    ctx.fillRect(0, y0(apronY), w, 0.9 * sy);

    // --- audience barrier rail ---
    const railY = y0(apronY) + 8 * sy;
    for (let x = 46 * sx; x < w; x += 176 * sx) {
      strokeTube(ctx, x, railY, x, railY + 26 * sy, 2.1 * sx, ALUMINIUM_DARK, "#b3aaa0");
    }
    strokeTube(ctx, -6 * sx, railY, w + 6 * sx, railY, 3.4 * sy, "#332f2c", "#8d857b");
    // One hairline specular along the top of the tube — enough for the bloom
    // pass to find, not enough to become a stripe across the frame.
    ctx.fillStyle = withAlpha(BONE, 0.22);
    ctx.fillRect(0, railY - 2.6 * sy, w, 0.7 * sy);

    // --- cable snakes along the apron base ---
    for (let c = 0; c < 4; c++) {
      const yBase = y0(stageY) - rng.range(6, 22) * sy;
      const sag = rng.range(4, 11) * sy;
      const x0c = rng.range(-40, 260) * sx;
      const x1c = x0c + rng.range(340, 720) * sx;
      ctx.strokeStyle = "rgba(4,3,3,0.92)";
      ctx.lineWidth = rng.range(2.2, 3.6) * sy;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const px = lerp(x0c, x1c, t);
        const py = yBase + sag * catenary(t, 2.1);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // Top highlight on the cable — a thin lighter line offset upward.
      ctx.strokeStyle = "rgba(150,140,130,0.16)";
      ctx.lineWidth = Math.max(0.5, 0.8 * sy);
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const px = lerp(x0c, x1c, t);
        const py = yBase + sag * catenary(t, 2.1) - 1.1 * sy;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // --- riser panel joints: the apron is a run of 8' flats, not one wall ---
    for (let jx = 96 * sx; jx < w; jx += 192 * sx) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(jx, y0(apronY) + 2 * sy, 1.4 * sx, stageY - apronY - 4 * sy);
      ctx.fillStyle = "rgba(150,138,126,0.07)";
      ctx.fillRect(jx + 1.4 * sx, y0(apronY) + 2 * sy, 0.8 * sx, stageY - apronY - 4 * sy);
    }
    // Gaffer tape over the joints at deck level — the detail every set has.
    for (let jx = 96 * sx; jx < w; jx += 384 * sx) {
      ctx.fillStyle = "rgba(24,20,18,0.9)";
      ctx.fillRect(jx - 7 * sx, y0(stageY) - 20 * sy, 15 * sx, 13 * sy);
      ctx.fillStyle = "rgba(120,110,100,0.1)";
      ctx.fillRect(jx - 7 * sx, y0(stageY) - 20 * sy, 15 * sx, 1 * sy);
    }

    // --- foldback wedges at the far edges ---
    const wedge = (cx: number): void => {
      const bw = 62 * sx;
      const bh = 30 * sy;
      const by = y0(stageY) - 4 * sy;
      ctx.fillStyle = "#0b0908";
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.5, by);
      ctx.lineTo(cx + bw * 0.5, by);
      ctx.lineTo(cx + bw * 0.36, by - bh);
      ctx.lineTo(cx - bw * 0.42, by - bh * 0.82);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(150,140,130,0.2)";
      ctx.lineWidth = Math.max(0.6, 0.9 * sx);
      ctx.stroke();
      // Grille: a dot field, not a hatch — a hatch reads as a UI element.
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      for (let gy = by - bh * 0.75; gy < by - 5 * sy; gy += 3.2 * sy) {
        for (let gx = cx - bw * 0.32; gx < cx + bw * 0.3; gx += 3.2 * sx) {
          ctx.fillRect(gx, gy, 1.3 * sx, 1.3 * sy);
        }
      }
      ctx.fillStyle = withAlpha(HEMI, 0.75);
      ctx.fillRect(cx + bw * 0.24, by - bh * 0.9, 2.4 * sx, 2.4 * sy);
    };
    wedge(70 * sx);
    wedge(w - 70 * sx);

    // --- LED tape at the base of the apron: the floor's motivated warm bounce ---
    const tapeY = y0(stageY) - 9 * sy;
    ctx.fillStyle = withAlpha(HEMI, 0.16);
    ctx.fillRect(0, tapeY - 3 * sy, w, 9 * sy);
    ctx.fillStyle = withAlpha(HEMI, 0.9);
    ctx.fillRect(0, tapeY, w, 2.6 * sy);
    ctx.fillStyle = withAlpha("#ffd2b4", 0.85);
    ctx.fillRect(0, tapeY + 0.4 * sy, w, 0.9 * sy);

    // --- polished concrete deck, in perspective ---
    const deckTop = y0(stageY) + 5 * sy;
    const deckH = H - deckTop;
    const conc = bakery.pattern(ctx, "concrete");
    const bands = 7;
    for (let i = 0; i < bands; i++) {
      const t0 = i / bands;
      const t1 = (i + 1) / bands;
      const by0 = deckTop + deckH * t0;
      const by1 = deckTop + deckH * t1;
      // Grain compresses toward the horizon: a receding plane's texture scale
      // falls off as 1/(1 + depth). 0.2 at the stage line to 0.85 at the frame
      // bottom matches a camera about a metre above the deck.
      const k = lerp(0.2, 0.85, t0 * t0 * 0.6 + t0 * 0.4);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, by0, w, by1 - by0 + 1);
      ctx.clip();
      // Squash the tile vertically about the band's top edge; the clip was
      // taken before the transform, so it still masks the correct strip.
      ctx.translate(0, by0);
      ctx.scale(1, k);
      ctx.fillStyle = conc;
      ctx.fillRect(0, 0, w, (by1 - by0) / k + 2);
      ctx.restore();
    }

    // Deck grade: the apron shadows the near band, the key lights land mid, and
    // the LED tape puts a warm line right under the nosing.
    const deck = ctx.createLinearGradient(0, deckTop, 0, H);
    deck.addColorStop(0, "rgba(6,5,4,0.9)");
    deck.addColorStop(0.1, "rgba(10,8,7,0.66)");
    deck.addColorStop(0.42, "rgba(14,12,10,0.42)");
    deck.addColorStop(1, "rgba(5,4,3,0.72)");
    ctx.fillStyle = deck;
    ctx.fillRect(0, deckTop, w, deckH);

    const bounce = ctx.createLinearGradient(0, deckTop, 0, deckTop + 26 * sy);
    bounce.addColorStop(0, "rgba(255,166,120,0.12)");
    bounce.addColorStop(0.4, "rgba(186,146,120,0.045)");
    bounce.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bounce;
    ctx.fillRect(0, deckTop, w, 26 * sy);

    // Broad polish sheen across the middle of the deck.
    const polish = ctx.createRadialGradient(w * 0.5, H, 0, w * 0.5, H, w * 0.62);
    polish.addColorStop(0, "rgba(190,176,162,0.09)");
    polish.addColorStop(0.55, "rgba(120,110,100,0.03)");
    polish.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = polish;
    ctx.fillRect(0, deckTop, w, deckH);

    // --- the stage line itself: an occlusion gap, an aluminium nosing with a
    //     genuine specular, and a contact shadow bleeding into the deck ---
    const line = y0(stageY);
    const gapG = ctx.createLinearGradient(0, line - 7 * sy, 0, line);
    gapG.addColorStop(0, "rgba(0,0,0,0)");
    gapG.addColorStop(1, "rgba(0,0,0,0.9)");
    ctx.fillStyle = gapG;
    ctx.fillRect(0, line - 7 * sy, w, 7 * sy);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, line, w, 5.4 * sy);
    ctx.clip();
    ctx.fillStyle = bakery.pattern(ctx, "brushed-metal");
    ctx.fillRect(0, line, w, 5.4 * sy);
    const nos = ctx.createLinearGradient(0, line, 0, line + 5.4 * sy);
    nos.addColorStop(0, "rgba(28,24,21,0.7)");
    nos.addColorStop(0.28, "rgba(250,244,236,0.72)");
    nos.addColorStop(0.44, "rgba(150,141,132,0.3)");
    nos.addColorStop(1, "rgba(6,5,4,0.86)");
    ctx.fillStyle = nos;
    ctx.fillRect(0, line, w, 5.4 * sy);
    ctx.restore();

    const contact = ctx.createLinearGradient(0, line + 5.4 * sy, 0, line + 20 * sy);
    contact.addColorStop(0, "rgba(0,0,0,0.62)");
    contact.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = contact;
    ctx.fillRect(0, line + 5.4 * sy, w, 15 * sy);

    // --- foldback monitors on poles, standing in front of the audience ---
    const monitor = (cx: number): void => {
      const mw = 78 * sx;
      const mh = 46 * sy;
      const my = y0(408 * sy);
      // Pole down into the apron.
      strokeTube(ctx, cx, my + mh, cx, y0(apronY) + 6 * sy, 2.6 * sx, "#3a3633", "#9e968d");
      // Chassis.
      ctx.fillStyle = "#0d0b0a";
      roundedPath(ctx, cx - mw * 0.5, my, mw, mh, 3 * sx);
      ctx.fill();
      const body = ctx.createLinearGradient(0, my, 0, my + mh);
      body.addColorStop(0, "rgba(178,166,154,0.24)");
      body.addColorStop(0.12, "rgba(40,36,33,0.2)");
      body.addColorStop(1, "rgba(0,0,0,0.55)");
      ctx.fillStyle = body;
      roundedPath(ctx, cx - mw * 0.5, my, mw, mh, 3 * sx);
      ctx.fill();
      // Screen recess — the live picture is painted per frame.
      ctx.fillStyle = "#000000";
      ctx.fillRect(cx - mw * 0.5 + 4 * sx, my + 4 * sy, mw - 8 * sx, mh - 11 * sy);
      ctx.fillStyle = withAlpha(HEMI, 0.65);
      ctx.fillRect(cx - mw * 0.5 + 5 * sx, my + mh - 4.6 * sy, 4 * sx, 1.6 * sy);
    };
    monitor(118 * sx);
    monitor(w - 118 * sx);

    // --- contact shadows: nothing in a real room floats -----------------
    // Every piece standing on the apron drops an occlusion pool where it meets
    // the deck. Baked as squashed radial gradients rather than drawn per frame:
    // the set pieces never move, so a per-frame pass would be pure cost.
    const contactPool = (cx: number, cy: number, rx: number, ry: number, a: number): void => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1);
      g.addColorStop(0, `rgba(0,0,0,${a.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(0,0,0,${(a * 0.42).toFixed(3)})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = g;
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
      ctx.restore();
    };
    // Under the two foldback monitor poles.
    contactPool(118 * sx, y0(apronY) + 7 * sy, 40 * sx, 7 * sy, 0.62);
    contactPool(w - 118 * sx, y0(apronY) + 7 * sy, 40 * sx, 7 * sy, 0.62);
    // Under the wedges standing at the deck edge.
    contactPool(70 * sx, y0(stageY) - 3 * sy, 46 * sx, 8 * sy, 0.55);
    contactPool(w - 70 * sx, y0(stageY) - 3 * sy, 46 * sx, 8 * sy, 0.55);
    // Under each barrier post where it meets the apron.
    for (let x = 46 * sx; x < w; x += 176 * sx) {
      contactPool(x, y0(apronY) + 33 * sy, 13 * sx, 3.6 * sy, 0.5);
    }

    // --- reclaim the neutrals, then put the room back on a lamp --------
    // Everything above is set dressing that must read as concrete, aluminium
    // and matte black. The chroma scale takes the accumulated hue drift out of
    // it and the white balance puts the tungsten back, so the deck is a warm
    // grey rather than either an orange wash or a cool one.
    balanceSurface(s, 0.82, 0.0);
    // The *motivated* hemi source on this layer — the LED tape at the apron
    // base — is then put back at full strength on top of the balanced plate, so
    // the accent survives at a chroma nothing else in the room reaches. This is
    // the contrast the look is built on: neutral set, saturated source.
    const tape = y0(stageY) - 9 * sy;
    // Diffuse throw into the apron above the strip, and onto the deck below it.
    const throwUp = ctx.createLinearGradient(0, tape - 16 * sy, 0, tape + 2 * sy);
    throwUp.addColorStop(0, withAlpha(HEMI, 0));
    throwUp.addColorStop(1, withAlpha(HEMI, 0.13));
    ctx.fillStyle = throwUp;
    ctx.fillRect(0, tape - 16 * sy, w, 18 * sy);
    ctx.fillStyle = withAlpha(HEMI, 0.12);
    ctx.fillRect(0, tape - 3 * sy, w, 10 * sy);
    ctx.fillStyle = withAlpha(HEMI, 1);
    ctx.fillRect(0, tape, w, 2.8 * sy);
    // The emitter's own core: hot enough that the bloom pass treats the strip as
    // a light rather than as a painted line.
    ctx.fillStyle = withAlpha("#ffd9bd", 0.92);
    ctx.fillRect(0, tape + 0.4 * sy, w, 1 * sy);
  }

  /** Overhead truss, hanging cables and the ceiling void. */
  function bakeRig(s: Surface): void {
    const ctx = s.ctx;
    const { w, sx, sy } = geo;
    const H = s.lh;
    const rng = rngRig.fork(0x21);

    // Ceiling void.
    const void_ = ctx.createLinearGradient(0, 0, 0, H);
    void_.addColorStop(0, "rgba(3,2,2,0.98)");
    void_.addColorStop(0.55, "rgba(5,4,3,0.72)");
    void_.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = void_;
    ctx.fillRect(0, 0, w, H);

    // Upstage truss — smaller, dimmer, sells the depth of the grid.
    ctx.save();
    ctx.globalAlpha = 0.5;
    const upTop = 6 * sy;
    const upBot = 20 * sy;
    strokeTube(ctx, -10 * sx, upTop, w + 10 * sx, upTop, 1.6 * sy, "#2b2724", "#6f6960");
    strokeTube(ctx, -10 * sx, upBot, w + 10 * sx, upBot, 1.6 * sy, "#2b2724", "#6f6960");
    for (let x = -20 * sx; x < w + 30 * sx; x += 34 * sx) {
      strokeTube(ctx, x, upBot, x + 17 * sx, upTop, 1.1 * sy, "#262220", "#5c574f");
      strokeTube(ctx, x + 17 * sx, upTop, x + 34 * sx, upBot, 1.1 * sy, "#262220", "#5c574f");
    }
    ctx.restore();

    // Main truss: two chords plus a zig-zag web, the standard box-truss read.
    // The chords bow a couple of pixels toward the camera at the frame edges —
    // a straight run photographed on a wide lens never stays straight, and the
    // bow is what keeps the rig from reading as a graphic border.
    const topY = 30 * sy;
    const botY = 58 * sy;
    const bay = 46 * sx;
    const bow = (x: number): number => trussBow(x, w, sy);
    for (let x = -bay; x < w + bay; x += bay) {
      strokeTube(ctx, x, botY + bow(x), x + bay * 0.5, topY + bow(x + bay * 0.5), 1.9 * sy, "#332e2a", "#8e867c");
      strokeTube(ctx, x + bay * 0.5, topY + bow(x + bay * 0.5), x + bay, botY + bow(x + bay), 1.9 * sy, "#332e2a", "#8e867c");
      // Vertical stub at each bay: real truss has them, and they break the
      // regularity of a pure zig-zag.
      strokeTube(ctx, x, topY + bow(x), x, botY + bow(x), 1.4 * sy, "#2b2723", "#7a736a");
    }
    for (const [cy, lit, r] of [
      [topY, "#cfc5b9", 3.1],
      [botY, "#b8ada1", 3.1],
    ] as const) {
      // The chords are drawn as a polyline so they can follow the bow.
      let px = -12 * sx;
      for (let x = 0; x <= 16; x++) {
        const nx = lerp(-12 * sx, w + 12 * sx, x / 16);
        if (x > 0) strokeTube(ctx, px, cy + bow(px), nx, cy + bow(nx), r * sy, "#39332e", lit);
        px = nx;
      }
    }

    // Node plates and bolts.
    for (let x = 0; x < w + bay; x += bay) {
      for (const ny of [topY + bow(x), botY + bow(x)]) {
        ctx.fillStyle = "rgba(24,21,19,0.9)";
        roundedPath(ctx, x - 5 * sx, ny - 4.4 * sy, 10 * sx, 8.8 * sy, 1.6 * sx);
        ctx.fill();
        ctx.fillStyle = "rgba(196,184,170,0.34)";
        ctx.fillRect(x - 5 * sx, ny - 4.4 * sy, 10 * sx, 0.9 * sy);
        ctx.fillStyle = "rgba(214,202,188,0.5)";
        ctx.beginPath();
        ctx.arc(x, ny, 1.2 * sx, 0, TAU);
        ctx.fill();
      }
    }

    // Cable bundle running along the bottom chord, with drape between ties.
    for (let c = 0; c < 3; c++) {
      const yBase = botY + (5 + c * 2.6) * sy;
      const width = (2.6 - c * 0.5) * sy;
      ctx.strokeStyle = c === 0 ? "rgba(6,5,4,0.95)" : "rgba(9,7,6,0.8)";
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.beginPath();
      const span = bay * 2;
      for (let x = -span; x < w + span; x += span) {
        const sag = rng.range(5, 13) * sy;
        for (let i = 0; i <= 10; i++) {
          const t = i / 10;
          const px = x + span * t;
          const py = yBase + sag * catenary(t, 1.9);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    }

    // Long drape cables falling out of the grid — depth cue at the frame edges.
    for (let c = 0; c < 5; c++) {
      const x0c = rng.range(-30, w + 30);
      const x1c = x0c + rng.range(90, 260) * sx * rngRig.sign();
      const sag = rng.range(28, 74) * sy;
      ctx.strokeStyle = "rgba(5,4,4,0.85)";
      ctx.lineWidth = rng.range(1.4, 2.4) * sy;
      ctx.beginPath();
      for (let i = 0; i <= 18; i++) {
        const t = i / 18;
        const px = lerp(x0c, x1c, t);
        const py = botY + 4 * sy + sag * catenary(t, 2.4);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Safety chains dangling from a few nodes.
    for (let c = 0; c < 6; c++) {
      const x = rng.range(0, w);
      const len = rng.range(10, 26) * sy;
      ctx.strokeStyle = "rgba(120,112,104,0.3)";
      ctx.lineWidth = 1.1 * sy;
      ctx.setLineDash([1.6 * sy, 1.4 * sy]);
      ctx.beginPath();
      ctx.moveTo(x, botY + 2 * sy);
      ctx.lineTo(x + rng.range(-3, 3) * sx, botY + len);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- material and focus --------------------------------------------
    // Truss is raw aluminium and black steel: it has no colour of its own, and
    // any it picks up from a stacked gradient is a mistake.
    balanceSurface(s, 0.86, 0.08);
    // The grid hangs a couple of metres in front of the focal plane, well
    // outside the depth of field of a fast prime wide open. Measured on the
    // pre-fix frame the truss band was the highest-Laplacian region in the
    // whole picture — the rig was resolving individual bolts while the cards
    // it hangs over were softer. Baked once, not filtered per frame.
    blurSurface(s, 2.6);
  }

  /** Fixture atlas: three body types, drawn once, transformed per frame. */
  const LAMP_CELL_W = 92;
  const LAMP_CELL_H = 118;
  const LAMP_VARIANTS = 3;

  function bakeLamps(body: Surface, rings: Surface): void {
    const ctx = body.ctx;
    const rctx = rings.ctx;

    for (let v = 0; v < LAMP_VARIANTS; v++) {
      const ox = v * LAMP_CELL_W;
      const cx = ox + LAMP_CELL_W * 0.5;
      ctx.save();
      ctx.translate(cx, 0);

      // C-clamp onto the truss chord.
      ctx.fillStyle = "#2a2522";
      roundedPath(ctx, -9, 0, 18, 9, 2);
      ctx.fill();
      ctx.fillStyle = "rgba(206,194,180,0.26)";
      ctx.fillRect(-9, 0, 18, 1.4);
      ctx.strokeStyle = "#1a1614";
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(0, 8);
      ctx.lineTo(0, 16);
      ctx.stroke();

      // Yoke: a U-bracket whose arms straddle the body.
      const yokeTop = 16;
      const bodyTop = 30;
      strokeTube(ctx, -13, yokeTop, -13, bodyTop + 14, 1.8, "#282420", "#786f65");
      strokeTube(ctx, 13, yokeTop, 13, bodyTop + 14, 1.8, "#282420", "#786f65");
      strokeTube(ctx, -13, yokeTop, 13, yokeTop, 1.8, "#282420", "#786f65");
      // Tilt knobs.
      for (const kx of [-13, 13]) {
        ctx.fillStyle = "#514a44";
        ctx.beginPath();
        ctx.arc(kx, bodyTop + 12, 3.2, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "rgba(224,212,198,0.45)";
        ctx.beginPath();
        ctx.arc(kx - 1, bodyTop + 11, 1.3, 0, TAU);
        ctx.fill();
      }

      if (v === 0) {
        // --- fresnel: short barrel, four barn doors ---
        const bw = 34;
        const bh = 36;
        const by = bodyTop;
        const shell = ctx.createLinearGradient(-bw * 0.5, 0, bw * 0.5, 0);
        shell.addColorStop(0, "#0a0908");
        shell.addColorStop(0.22, "#26221f");
        shell.addColorStop(0.38, "#5f594f");
        shell.addColorStop(0.52, "#2e2a26");
        shell.addColorStop(0.86, "#141110");
        shell.addColorStop(1, "#070606");
        ctx.fillStyle = shell;
        roundedPath(ctx, -bw * 0.5, by, bw, bh, 3);
        ctx.fill();
        // Cooling fins.
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        for (let i = 0; i < 5; i++) ctx.fillRect(-bw * 0.5 + 2, by + 5 + i * 5, bw - 4, 1.4);
        // Barn doors: two side flaps splayed outward, two shallow top/bottom.
        const dy = by + bh;
        const doors: [number, number, number, number][] = [
          [-bw * 0.5, dy - 2, -bw * 0.5 - 15, dy + 20],
          [bw * 0.5, dy - 2, bw * 0.5 + 15, dy + 20],
        ];
        for (const [x0, y0d, x1, y1d] of doors) {
          ctx.beginPath();
          ctx.moveTo(x0, y0d);
          ctx.lineTo(x1, y1d);
          ctx.lineTo(x1 + (x1 > 0 ? -3 : 3), y1d + 9);
          ctx.lineTo(x0 + (x1 > 0 ? -2 : 2), y0d + 10);
          ctx.closePath();
          ctx.fillStyle = "#100e0d";
          ctx.fill();
          ctx.strokeStyle = "rgba(200,188,174,0.22)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        // Front ring around the lens.
        ctx.strokeStyle = "#6c645b";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, dy + 6, 15, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = "#050404";
        ctx.beginPath();
        ctx.arc(0, dy + 6, 13.4, 0, TAU);
        ctx.fill();
      } else if (v === 1) {
        // --- par can: plain cylinder plus a snoot ---
        const bw = 30;
        const bh = 46;
        const by = bodyTop;
        const shell = ctx.createLinearGradient(-bw * 0.5, 0, bw * 0.5, 0);
        shell.addColorStop(0, "#080706");
        shell.addColorStop(0.26, "#211e1b");
        shell.addColorStop(0.4, "#57514a");
        shell.addColorStop(0.58, "#26221f");
        shell.addColorStop(1, "#060505");
        ctx.fillStyle = shell;
        ctx.beginPath();
        ctx.moveTo(-bw * 0.5, by);
        ctx.lineTo(bw * 0.5, by);
        ctx.lineTo(bw * 0.5 + 5, by + bh);
        ctx.lineTo(-bw * 0.5 - 5, by + bh);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(190,178,164,0.28)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(0, by + bh, bw * 0.5 + 5, 4.4, 0, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = "#050404";
        ctx.beginPath();
        ctx.ellipse(0, by + bh, bw * 0.5 + 3.4, 3.4, 0, 0, TAU);
        ctx.fill();
      } else {
        // --- profile spot: long barrel with shutter handles ---
        const bw = 24;
        const bh = 54;
        const by = bodyTop - 4;
        const shell = ctx.createLinearGradient(-bw * 0.5, 0, bw * 0.5, 0);
        shell.addColorStop(0, "#080706");
        shell.addColorStop(0.28, "#1f1c1a");
        shell.addColorStop(0.42, "#5c554d");
        shell.addColorStop(0.6, "#242120");
        shell.addColorStop(1, "#060505");
        ctx.fillStyle = shell;
        roundedPath(ctx, -bw * 0.5, by, bw, bh, 2.4);
        ctx.fill();
        // Lens tube, slightly wider than the body.
        ctx.fillStyle = "#241f1c";
        roundedPath(ctx, -bw * 0.5 - 3, by + bh - 14, bw + 6, 16, 2);
        ctx.fill();
        ctx.fillStyle = "rgba(214,202,188,0.24)";
        ctx.fillRect(-bw * 0.5 - 3, by + bh - 14, bw + 6, 1);
        // Shutter handles.
        ctx.strokeStyle = "rgba(150,140,130,0.5)";
        ctx.lineWidth = 1.4;
        for (let i = 0; i < 3; i++) {
          const hy = by + 12 + i * 8;
          ctx.beginPath();
          ctx.moveTo(bw * 0.5, hy);
          ctx.lineTo(bw * 0.5 + 7, hy - 3);
          ctx.stroke();
        }
        ctx.fillStyle = "#050404";
        ctx.beginPath();
        ctx.ellipse(0, by + bh + 1, bw * 0.5 + 2.4, 3, 0, 0, TAU);
        ctx.fill();
      }

      // Power tail coiled off the back of every fixture.
      ctx.strokeStyle = "rgba(6,5,4,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-10, bodyTop + 4);
      ctx.quadraticCurveTo(-24, bodyTop + 16, -18, bodyTop + 34);
      ctx.stroke();

      ctx.restore();

      // --- emissive ring atlas: white-on-transparent fresnel rings, drawn
      //     additively at the lamp's live colour so the lens actually lights up
      const lensY = v === 0 ? 82 : v === 1 ? 76 : 80;
      const lensR = v === 0 ? 13 : v === 1 ? 16 : 13;
      rctx.save();
      rctx.translate(ox + LAMP_CELL_W * 0.5, 0);
      const glass = rctx.createRadialGradient(0, lensY, 0, 0, lensY, lensR);
      glass.addColorStop(0, "rgba(255,255,255,0.95)");
      glass.addColorStop(0.35, "rgba(255,255,255,0.5)");
      glass.addColorStop(0.72, "rgba(255,255,255,0.2)");
      glass.addColorStop(1, "rgba(255,255,255,0)");
      rctx.fillStyle = glass;
      rctx.beginPath();
      rctx.arc(0, lensY, lensR, 0, TAU);
      rctx.fill();
      // Concentric fresnel steps: the stepped moulding of a real lens.
      rctx.globalCompositeOperation = "source-atop";
      for (let r = lensR * 0.24; r < lensR; r += lensR * 0.19) {
        rctx.strokeStyle = "rgba(255,255,255,0.55)";
        rctx.lineWidth = 1.1;
        rctx.beginPath();
        rctx.arc(0, lensY, r, 0, TAU);
        rctx.stroke();
        rctx.strokeStyle = "rgba(0,0,0,0.35)";
        rctx.beginPath();
        rctx.arc(0, lensY, r + 1.3, 0, TAU);
        rctx.stroke();
      }
      rctx.globalCompositeOperation = "source-over";
      rctx.restore();
    }
  }

  /**
   * One shaft sprite: apex at the top centre, cone opening downward, alpha
   * carrying the whole light model. Three tinted copies are baked from a single
   * evaluation of the field so a light can be coloured by cross-fading two of
   * them additively — cheaper and sharper than tinting a buffer per light.
   */
  const SHAFT_W = 256;
  const SHAFT_H = 448;
  /** Fraction of the sprite half-width the nominal cone edge sits at. */
  const SHAFT_CONE_FRAC = 0.6;

  function bakeShafts(out: Surface[]): void {
    const first = out[0];
    const px = first.w;
    const py = first.h;
    const alpha = new Float32Array(px * py);
    const invW = 2 / px;

    for (let y = 0; y < py; y++) {
      const v = (y + 0.5) / py;
      // Inverse-square falloff along the beam, offset so the apex is finite.
      // K sets how quickly the shaft dies: 2.6 puts roughly a stop between the
      // fixture and the floor, which is what a real haze-filled room looks like.
      const fall = 1 / (1 + Math.pow(v * 2.6, 2));
      // The cone half-width grows linearly with depth. `SHAFT_CONE_FRAC` leaves
      // the outer 40 % of the sprite for the skirt, so the wide soft volume can
      // live in the same sprite instead of costing a second, larger draw.
      const halfSpan = Math.max(0.045, v) * SHAFT_CONE_FRAC;
      // Energy conservation: the same flux spread over a wider slice.
      const spread = 1 / (0.35 + halfSpan * 1.9);
      // Soft start inside the fixture so the beam does not begin with an edge.
      const throat = smoothstep(0, 0.045, v);
      for (let x = 0; x < px; x++) {
        const nx = (x + 0.5) * invW - 1;
        const u = nx / halfSpan;
        const au = Math.abs(u);
        if (au > 1.72) {
          alpha[y * px + x] = 0;
          continue;
        }
        // Internal density. Real haze is not uniform: the beam is broken by
        // barn doors, by the gobo of whatever it passed through, and by the
        // convection cells in the room. Three decorrelated octaves whose phase
        // shears with depth mean the structure travels *through* the beam
        // rather than sliding with it, and the whole field is renormalised so
        // the average density is unchanged — this modulates, it does not dim.
        const turb =
          1 +
          0.2 * Math.sin(u * 7.3 + v * 2.1) +
          0.11 * Math.sin(u * 17.7 - v * 3.4) +
          0.13 * Math.sin(u * 3.1 - v * 9.7 + 1.3) +
          0.07 * Math.sin(u * 29.3 + v * 15.1);
        // Beam proper: a gaussian across the cone plus a much tighter core.
        // The penumbra the barn doors cut is deliberately *wide* — a cone edge
        // that resolves in two pixels is a triangle, not a volume.
        const beam =
          (Math.exp(-2.6 * u * u) * 0.62 * turb + Math.exp(-13 * u * u) * 0.5) *
          (1 - smoothstep(0.58, 1.34, au));
        // Skirt: the wide, weak halo of light scattered out of the cone by the
        // haze. Its own much softer cutoff, well inside the sprite edge so no
        // hard boundary can ever appear at the bottom corners.
        const skirt = Math.exp(-0.6 * u * u) * 0.2 * (1 - smoothstep(0.9, 1.7, au));
        alpha[y * px + x] = clamp01((beam + skirt) * fall * spread * throat);
      }
    }

    writeTinted(out, alpha);
  }

  /**
   * Seamless haze mask. Alpha spans 0.42–1 so multiplying it into the shaft
   * buffer thins the volume without ever punching a hole through it.
   */
  function bakeHazeMask(s: Surface, nz: Noise, salt: number): void {
    const px = s.w;
    const period = 6;
    const img = s.ctx.createImageData(px, px);
    const data = img.data;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const u = (x / px) * period;
        const v = (y / px) * period;
        const n = nz.tiled2(u + salt, v - salt, period) * 0.62 + nz.tiled2(u * 2.7, v * 2.7, period * 2.7) * 0.38;
        const q = (y * px + x) * 4;
        data[q] = 255;
        data[q + 1] = 255;
        data[q + 2] = 255;
        data[q + 3] = (0.42 + 0.58 * clamp01(n * 0.5 + 0.5)) * 255;
      }
    }
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.putImageData(img, 0, 0);
  }

  /** Wide, very soft horizontal haze band used for the depth strata. */
  function bakeHazeBand(s: Surface): void {
    const ctx = s.ctx;
    const W = s.lw;
    const H = s.lh;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.38, "rgba(255,255,255,0.55)");
    g.addColorStop(0.56, "rgba(255,255,255,1)");
    g.addColorStop(0.74, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Break the band up horizontally so it never reads as a printed gradient.
    ctx.globalCompositeOperation = "destination-in";
    const h = ctx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const n = noise.n2(i * 0.83, 4.2) * 0.5 + 0.5;
      h.addColorStop(t, `rgba(255,255,255,${(0.35 + 0.65 * n).toFixed(3)})`);
    }
    ctx.fillStyle = h;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }

  /** Vertical grade strip, stretched full width — cheaper than a full canvas. */
  function bakeGradeTop(s: Surface): void {
    const ctx = s.ctx;
    const H = s.lh;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(2,2,2,0.5)");
    g.addColorStop(0.12, "rgba(3,3,3,0.16)");
    g.addColorStop(0.42, "rgba(0,0,0,0)");
    g.addColorStop(0.78, "rgba(0,0,0,0.05)");
    g.addColorStop(1, "rgba(0,0,0,0.2)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s.lw, H);
  }

  /**
   * Anisotropic floor sheen — a polished deck smears a highlight along the view
   * axis, so the sprite is a tight gaussian across and a long exponential tail
   * down. Baked in the same three tints as the shafts so a key light's floor
   * reflection can be coloured by cross-fading two copies.
   */
  function bakeFloorSheen(out: Surface[]): void {
    const first = out[0];
    const alpha = new Float32Array(first.w * first.h);
    for (let y = 0; y < first.h; y++) {
      const v = y / first.h;
      const along = Math.exp(-2.4 * v) * (1 - v * 0.2);
      for (let x = 0; x < first.w; x++) {
        const u = (x / first.w) * 2 - 1;
        const across = Math.exp(-6.5 * u * u) * 0.7 + Math.exp(-42 * u * u) * 0.5;
        alpha[y * first.w + x] = clamp01(across * along);
      }
    }
    writeTinted(out, alpha);
  }

  /**
   * Writes one alpha field into a set of surfaces, one per tint.
   *
   * The field is rasterised **once**. The remaining copies are a `drawImage`
   * plus a `source-in` fill, which the compositor does far faster than JS can
   * refill an ImageData — the shaft sprite alone was three passes over 115k
   * pixels for three colours of the same shape.
   */
  function writeTinted(out: Surface[], alpha: Float32Array): void {
    const first = out[0];
    const img = first.ctx.createImageData(first.w, first.h);
    const data = img.data;
    for (let p = 0, n = first.w * first.h; p < n; p++) {
      const q = p * 4;
      data[q] = 255;
      data[q + 1] = 255;
      data[q + 2] = 255;
      data[q + 3] = alpha[p] * 255;
    }
    first.ctx.setTransform(1, 0, 0, 1, 0, 0);
    first.ctx.putImageData(img, 0, 0);
    for (let i = 1; i < out.length; i++) {
      const s = out[i];
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.globalCompositeOperation = "copy";
      s.ctx.drawImage(first.canvas, 0, 0, s.w, s.h);
      s.ctx.globalCompositeOperation = "source-over";
      tintSurface(s, TINT_CSS[i]);
    }
    tintSurface(first, TINT_CSS[0]);
  }

  /**
   * Three tinted copies of a white bakery sprite. Allocated at the sprite's own
   * logical size so nothing is resampled twice; painting is a separate step so
   * the allocation can happen up front and the (texture-dependent) bake can be
   * queued behind the warm.
   */
  function allocTintedSprite(id: TextureId, bake: number): Surface[] | null {
    const px = bakery.size(id);
    const out: Surface[] = [];
    for (let i = 0; i < 3; i++) {
      const s = createSurface(px, px, clamp(bake, 0.7, 2));
      if (!s) return null;
      out.push(s);
    }
    return out;
  }

  function paintTintedSprite(set: Surface[], id: TextureId): void {
    const px = bakery.size(id);
    const src = bakery.get(id);
    for (let i = 0; i < set.length; i++) {
      set[i].ctx.drawImage(src, 0, 0, px, px);
      tintSurface(set[i], TINT_CSS[i]);
    }
  }

  /** Vertical alpha ramp for the screen-space floor reflection. */
  function bakeReflectMask(s: Surface): void {
    const ctx = s.ctx;
    const W = s.lw;
    const H = s.lh;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    // Fresnel: a wet-looking floor reflects most at grazing angles, which here
    // means strongest right at the stage line and gone within a stage depth.
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.2, "rgba(255,255,255,0.6)");
    g.addColorStop(0.5, "rgba(255,255,255,0.26)");
    g.addColorStop(0.8, "rgba(255,255,255,0.07)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "destination-in";
    const h = ctx.createLinearGradient(0, 0, W, 0);
    h.addColorStop(0, "rgba(255,255,255,0)");
    h.addColorStop(0.1, "rgba(255,255,255,1)");
    h.addColorStop(0.9, "rgba(255,255,255,1)");
    h.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = h;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }

  /** Heavily defocused furniture at the frame edges — the lens as a character. */
  function bakeForeground(s: Surface): void {
    const ctx = s.ctx;
    const { w, sx, sy } = geo;
    const H = s.lh;

    // Out-of-focus flag / barn door intruding from the top-left corner.
    ctx.fillStyle = "#050404";
    ctx.beginPath();
    ctx.moveTo(-20, -20);
    ctx.lineTo(210 * sx, -20);
    ctx.lineTo(96 * sx, 118 * sy);
    ctx.lineTo(-20, 74 * sy);
    ctx.closePath();
    ctx.fill();
    // A warm rim on its lit edge, so the shape is legible rather than a smudge.
    ctx.strokeStyle = withAlpha("#ffb083", 0.3);
    ctx.lineWidth = 3.4 * sx;
    ctx.beginPath();
    ctx.moveTo(212 * sx, -18);
    ctx.lineTo(97 * sx, 118 * sy);
    ctx.stroke();

    // Defocused truss leg down the right edge.
    ctx.fillStyle = "#060505";
    ctx.fillRect(w - 34 * sx, -20, 40 * sx, H + 40);
    ctx.strokeStyle = withAlpha(ALUMINIUM, 0.16);
    ctx.lineWidth = 2.6 * sx;
    ctx.beginPath();
    ctx.moveTo(w - 33 * sx, -20);
    ctx.lineTo(w - 33 * sx, H + 20);
    ctx.stroke();

    // Cable sweeping across the bottom-left corner.
    ctx.strokeStyle = "rgba(4,3,3,0.95)";
    ctx.lineWidth = 9 * sy;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-20, H - 26 * sy);
    ctx.quadraticCurveTo(150 * sx, H + 26 * sy, 330 * sx, H + 40 * sy);
    ctx.stroke();

    // Rail crossing the bottom-right.
    ctx.strokeStyle = "rgba(6,5,5,0.9)";
    ctx.lineWidth = 13 * sy;
    ctx.beginPath();
    ctx.moveTo(w + 20, H - 96 * sy);
    ctx.quadraticCurveTo(w - 150 * sx, H - 34 * sy, w - 320 * sx, H + 20);
    ctx.stroke();
    ctx.strokeStyle = withAlpha(BONE, 0.09);
    ctx.lineWidth = 2.6 * sy;
    ctx.beginPath();
    ctx.moveTo(w + 20, H - 100 * sy);
    ctx.quadraticCurveTo(w - 150 * sx, H - 39 * sy, w - 320 * sx, H + 14);
    ctx.stroke();

    // Near-plane furniture is set dressing in shadow, not a colour statement.
    balanceSurface(s, 0.78, 0.0);
    // The whole plane is far outside the focal plane: blur it hard. This is the
    // single strongest lens cue in the frame.
    blurSurface(s, 9);
  }

  /**
   * Audience atlas for one depth tier. Every cell is drawn into a scratch
   * surface, given its rim lights, then blitted in — which lets the source-atop
   * shading passes act on one person at a time.
   */
  function bakeCrowdTier(atlas: Surface, scratch: Surface, tier: CrowdTier, specs: PersonSpec[]): void {
    const ctx = atlas.ctx;
    const sctx = scratch.ctx;
    const rim = withAlpha(rampAt(crowdRimRamp, 0.5 + tier.rim * 0.4), 0.62 + tier.rim * 0.16);

    for (let v = 0; v < specs.length; v++) {
      const p = specs[v];
      resetSurface(scratch);

      // Rim pass 1: the LED wall and the upstage keys wrap the silhouette from
      // behind. Offsetting the same shape up-left and painting it bright leaves
      // a clean lit sliver once the dark body lands on top.
      // Per-body jitter on the rim direction: a real house is lit by one rig,
      // but no two people are turned the same way into it.
      const jx = p.rimJitterX;
      const jy = p.rimJitterY;
      paintSilhouette(sctx, p, CELL_W, CELL_H, -1.1 + jx, -1.25 + jy, rim);
      // Rim pass 2: a weak aluminium fill from the opposite side.
      paintSilhouette(sctx, p, CELL_W, CELL_H, 0.9 - jx, -0.5, withAlpha(ALUMINIUM, 0.2));
      // The body itself.
      paintSilhouette(sctx, p, CELL_W, CELL_H, 0, 0, tier.tint);

      // Shading, clipped to whatever is already on the cell.
      sctx.globalCompositeOperation = "source-atop";
      const key = sctx.createLinearGradient(0, 0, CELL_W * 0.7, CELL_H * 0.6);
      key.addColorStop(0, withAlpha(BONE, 0.055 + tier.rim * 0.035));
      key.addColorStop(0.35, withAlpha(BONE, 0.014));
      key.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = key;
      sctx.fillRect(0, 0, CELL_W, CELL_H);

      // Wall bounce on the crown of the head only — a couple of pixels deep.
      const back = sctx.createLinearGradient(0, 0, 0, CELL_H * 0.2);
      back.addColorStop(0, withAlpha("#ffcaa4", 0.1));
      back.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = back;
      sctx.fillRect(0, 0, CELL_W, CELL_H * 0.24);

      // Rows sink into their own shadow toward the seat.
      const occl = sctx.createLinearGradient(0, CELL_H * 0.3, 0, CELL_H);
      occl.addColorStop(0, "rgba(0,0,0,0)");
      occl.addColorStop(1, "rgba(0,0,0,0.85)");
      sctx.fillStyle = occl;
      sctx.fillRect(0, CELL_H * 0.28, CELL_W, CELL_H * 0.72);
      sctx.globalCompositeOperation = "source-over";

      ctx.drawImage(scratch.canvas, v * CELL_W, 0, CELL_W, CELL_H);
    }

    // The house is a field of silhouettes: it must read as bodies in shadow,
    // not as an orange gradient with heads in it. The rim keeps enough warmth
    // to say "lit from behind" and loses the rest.
    balanceSurface(atlas, 0.96, 0.0);
    // Depth of field, baked once per tier rather than filtered per frame.
    if (tier.blur > 0) blurSurface(atlas, tier.blur);
  }

  /** Lays out the audience: tier baselines, populations and per-body motion. */
  function buildCrowd(): void {
    tiers.length = 0;
    people.length = 0;
    const { w, sy, crowdTop } = geo;
    const rowSpan = geo.apronY + 14 * sy - crowdTop;
    const rng = rngCrowd.fork(0x31);
    // The house is always laid out as four rows on a fixed rake; a cheaper tier
    // drops rows from the BACK, so every row the camera actually reads stays
    // exactly where it was and the composition is quality-independent.
    const ROWS = 4;
    const first = ROWS - clamp(settings.crowdTiers, 1, ROWS);
    for (let i = first; i < ROWS; i++) {
      const t = i / (ROWS - 1);
      tiers.push({
        index: i,
        from: 0,
        to: 0,
        // Rake: quadratic in depth, so rows bunch up toward the back exactly as
        // a raked riser foreshortens.
        baseline: crowdTop + rowSpan * (0.3 + 0.72 * t * t + 0.28 * t),
        scale: lerp(0.6, 1.02, t) * (geo.h / 620),
        blur: lerp(2.1, 0.5, t),
        tint: mixColor("#0d0c0b", "#050505", t),
        rim: lerp(1, 0.4, t),
        depth: lerp(0.2, 0.36, t),
        count: Math.max(6, Math.round(lerp(44, 24, t) * settings.crowdDensity)),
      });
    }

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      tier.from = people.length;
      const spacing = w / tier.count;
      for (let j = 0; j < tier.count; j++) {
        const jitter = rng.range(-spacing * 0.36, spacing * 0.36);
        const x = (j + 0.5) * spacing + jitter;
        // Shallow amphitheatre: the house curves away at the centre, which is
        // what stops the rows reading as four straight lines.
        const nx = (x / w) * 2 - 1;
        const curve = (1 - nx * nx) * 9 * sy;
        people.push({
          tier: i,
          variant: rng.int(0, CROWD_VARIANTS - 1),
          x,
          baseY: tier.baseline + curve + rng.range(-1.6, 1.6) * sy,
          scale: tier.scale * rng.range(0.85, 1.17),
          flip: rng.next() < 0.5,
          phase: rng.range(0, TAU),
          freq: rng.range(0.28, 0.72),
          ampX: rng.range(0.25, 0.85),
          ampY: rng.range(0.3, 1.1),
          phone: rng.next() < 0.075,
          phoneOffset: rng.range(0, 40),
          phonePeriod: rng.range(14, 34),
        });
      }
      tier.to = people.length;
    }
  }

  /* ================================================================ *
   * Rig layout
   * ================================================================ */

  function buildRig(): void {
    lamps.length = 0;
    lights.length = 0;
    const { w, sx, sy } = geo;
    const rng = rngRig.fork(0x41);

    // Fixture positions across the grid. The two inner fixtures are the keys
    // that matter; the outer three fill and rim.
    // Real rigs are hung to a plot, not a grid: fixtures sit at their own drop
    // heights on their own arms, and no two are the same distance apart.
    const spec: { fx: number; variant: number; rest: number; scale: number; drop: number }[] = [
      { fx: 0.185, variant: 0, rest: 0.36, scale: 1.05, drop: 0 },
      { fx: 0.352, variant: 2, rest: 0.15, scale: 0.92, drop: 9 },
      { fx: 0.497, variant: 0, rest: 0.02, scale: 1.14, drop: -4 },
      { fx: 0.668, variant: 1, rest: -0.16, scale: 0.95, drop: 6 },
      { fx: 0.826, variant: 0, rest: -0.38, scale: 1.02, drop: -2 },
      { fx: 0.072, variant: 1, rest: 0.52, scale: 0.84, drop: 13 },
      { fx: 0.941, variant: 2, rest: -0.5, scale: 0.86, drop: 11 },
    ];

    for (let i = 0; i < spec.length; i++) {
      const s = spec[i];
      const lx = s.fx * w;
      lamps.push({
        x: lx,
        y: (58 + s.drop) * sy + trussBow(lx, w, sy),
        variant: s.variant,
        scale: s.scale * Math.min(sx, sy),
        rest: s.rest,
        swing: createSpring({ stiffness: 26, damping: 1.9, mass: 1 }),
        drift: rng.range(0, 100),
        reach: LAMP_CELL_H * s.scale * Math.min(sx, sy),
        light: -1,
      });
    }

    // Key lights, ordered by importance: the tier table truncates this list.
    // Authored colour temperatures. These sit low on purpose: the rig is
    // balanced close to bone and only *pressure* drives it warm, so the room
    // reads as a lit television studio rather than as a gelled club.
    const lightSpec: { lamp: number; cone: number; warmth: number; power: number; front: boolean }[] = [
      { lamp: 2, cone: 0.2, warmth: 0.44, power: 1, front: true },
      { lamp: 0, cone: 0.15, warmth: 0.2, power: 0.82, front: false },
      { lamp: 4, cone: 0.15, warmth: 0.17, power: 0.8, front: true },
      { lamp: 1, cone: 0.1, warmth: 0.6, power: 0.6, front: false },
      { lamp: 3, cone: 0.11, warmth: 0.05, power: 0.54, front: false },
    ];
    for (let i = 0; i < lightSpec.length; i++) {
      const ls = lightSpec[i];
      const lamp = lamps[ls.lamp];
      lamp.light = i;
      lights.push({
        lamp: ls.lamp,
        baseCone: ls.cone,
        baseWarmth: ls.warmth,
        // Long enough that the beam still has body when it reaches the deck.
        length: (geo.stageY + geo.floorH * 0.55 - lamp.y) * 1.05,
        power: ls.power,
        front: ls.front,
        seed: rng.range(0, 1000),
        cone: ls.cone,
        warmth: ls.warmth,
        x: lamp.x,
        y: lamp.y + lamp.reach * 0.7,
        angle: lamp.rest,
        gain: ls.power,
      });
    }
  }

  /* ================================================================ *
   * Layer construction — amortised across frames
   *
   * The set is twenty-odd offscreen layers. Building them in one call was an
   * eleven-second stall on the first background draw, which is unshippable at
   * any frame rate; even at a tenth of that it is a visible hitch on the frame
   * the player sees first.
   *
   * So construction is a *queue*. `beginBuild` allocates the surfaces and
   * enqueues one closure per layer; `bootStep` drains the queue under a
   * millisecond budget, a few units per frame. Each finished layer joins a
   * reveal group that fades up over a few frames, so nothing snaps into
   * existence, and the composition root holds a broadcast standby card over the
   * whole thing until the set is live.
   *
   * The queue is also what makes a mid-game quality change free: the new set is
   * built into `staging` while the old one keeps drawing, and the swap happens
   * on the frame the last unit lands.
   * ================================================================ */

  function disposeLayers(l: Layers | null): void {
    // Canvases are garbage collected once unreferenced; dropping the record is
    // enough, and explicitly zeroing the backing stores helps Safari release
    // them promptly on a resize storm.
    if (!l) return;
    const all: Surface[] = [
      l.backdrop,
      l.ledOverlay,
      l.ledBars,
      l.ledContent,
      l.stage,
      l.rig,
      l.fore,
      l.lamps,
      l.hazeMask,
      l.haze,
      l.hazeFront,
      l.gradeTop,
      ...l.crowd,
      ...l.shafts,
      ...l.floorSheen,
      ...l.hazeBand,
      ...l.lampRings,
      ...l.glowSet,
      ...l.bokehSet,
    ];
    if (l.reflect) all.push(l.reflect);
    if (l.reflectOut) all.push(l.reflectOut);
    if (l.reflectMask) all.push(l.reflectMask);
    for (const s of all) {
      const c = s.canvas;
      if (typeof HTMLCanvasElement !== "undefined" && c instanceof HTMLCanvasElement) {
        c.width = 1;
        c.height = 1;
      } else if (typeof OffscreenCanvas !== "undefined" && c instanceof OffscreenCanvas) {
        c.width = 1;
        c.height = 1;
      }
    }
  }

  /**
   * Allocates the whole layer set and queues its bakes. Allocation is kept
   * together and up front — a canvas is cheap until something draws into it,
   * and having every surface exist from the first frame is what lets the draw
   * path composite a half-built set without a single null check per layer.
   */
  function beginBuild(): boolean {
    const bake = clamp(deviceScale * settings.bake, 0.7, 2);
    const { w, h, stageY, stageTop, rigH, ledW, ledH } = geo;

    const backdrop = createSurface(w, Math.max(16, stageY), bake);
    const ledOverlay = createSurface(ledW, ledH, bake);
    const ledBars = createSurface(768, 216, 1);
    const ledContent = createSurface(384, 108, 1);
    const stage = createSurface(w, Math.max(16, h - stageTop), bake);
    const rig = createSurface(w, rigH, bake);
    // The foreground plane carries no frequency above the blur radius, so it is
    // baked at half size and upscaled: identical on screen, 4x cheaper to blur.
    const fore = createSurface(w, h, 0.5);
    const lampsSurface = createSurface(LAMP_CELL_W * LAMP_VARIANTS, LAMP_CELL_H, bake);
    const lampRings: Surface[] = [];
    for (let i = 0; i < 3; i++) {
      const r = createSurface(LAMP_CELL_W * LAMP_VARIANTS, LAMP_CELL_H, bake);
      if (!r) return false;
      lampRings.push(r);
    }
    // The mask is organic low-frequency noise stretched over a haze buffer half
    // the frame's size, and every pixel of it costs two noise evaluations. A
    // 256px tile was four times the samples anything could resolve; `renderHaze`
    // rescales the pattern by lw/w, so the drift period is unchanged.
    const hazeMask = createSurface(256, 256, settings.maskBake);
    const hazeBand: Surface[] = [];
    for (let i = 0; i < 3; i++) {
      const b = createSurface(512, 96, 1);
      if (!b) return false;
      hazeBand.push(b);
    }
    const gradeTop = createSurface(8, 512, 1);
    const floorSheen: Surface[] = [];
    for (let i = 0; i < 3; i++) {
      const sheen = createSurface(96, 128, 1);
      if (!sheen) return false;
      floorSheen.push(sheen);
    }
    const hazeW = Math.max(64, Math.round(w / settings.hazeDiv));
    const hazeH = Math.max(48, Math.round(h / settings.hazeDiv));
    const haze = createSurface(hazeW, hazeH, 1);
    // The front pass gets its own accumulator rather than being drawn straight
    // into the frame: at this divisor it is a quarter of the fill cost, and the
    // upscale softens the beams exactly the way near haze should look.
    const hazeFront = createSurface(hazeW, hazeH, 1);

    const shafts: Surface[] = [];
    for (let i = 0; i < 3; i++) {
      // Pure analytic falloff — gaussians, an inverse square and a smoothstep —
      // with no feature smaller than a tenth of the sprite. Rasterising that at
      // 1:1 was 115k pixels of `Math.exp` per tint for a sprite that is then
      // stretched over an arbitrary cone anyway.
      const s = createSurface(SHAFT_W, SHAFT_H, settings.shaftBake);
      if (!s) return false;
      shafts.push(s);
    }

    const crowdScratch = createSurface(CELL_W, CELL_H, bake);
    const crowd: Surface[] = [];
    for (let i = 0; i < tiers.length; i++) {
      // A tier that is blurred to mush needs no resolution: dropping the atlas
      // scale with the blur radius keeps the bake cost roughly constant.
      const s = createSurface(CELL_W * CROWD_VARIANTS, CELL_H, bake / (1 + tiers[i].blur * 0.22));
      if (!s) return false;
      crowd.push(s);
    }

    let reflect: Surface | null = null;
    let reflectOut: Surface | null = null;
    let reflectMask: Surface | null = null;
    if (settings.reflection) {
      const rw = Math.max(48, Math.round(w / settings.reflectDiv));
      // Deliberately short: squashing a 2.4-stage-depth grab into this few rows
      // is what makes the reflection blur along the view axis far more than
      // across it, which is exactly how a polished floor behaves.
      const rh = Math.max(12, Math.round(geo.floorH / settings.reflectDiv));
      reflect = createSurface(rw, rh, 1);
      reflectOut = createSurface(rw, rh, 1);
      reflectMask = createSurface(rw, rh, 1);
    }

    const glowSet = allocTintedSprite("glow", bake);
    const bokehSet = allocTintedSprite("bokeh", bake);

    if (
      !backdrop ||
      !ledOverlay ||
      !ledBars ||
      !ledContent ||
      !stage ||
      !rig ||
      !fore ||
      !lampsSurface ||
      !hazeMask ||
      !haze ||
      !hazeFront ||
      !gradeTop ||
      !crowdScratch ||
      !glowSet ||
      !bokehSet
    ) {
      return false;
    }

    const next: Layers = {
      bake,
      quality,
      backdrop,
      ledOverlay,
      ledBars,
      ledContent,
      stage,
      rig,
      fore,
      lamps: lampsSurface,
      lampRings,
      crowd,
      shafts,
      hazeMask,
      hazeBand,
      haze,
      hazeFront,
      hazePattern: null,
      hazeFrontPattern: null,
      reflect,
      reflectOut,
      reflectMask,
      gradeTop,
      floorSheen,
      glowSet,
      bokehSet,
      reveal: { room: 0, stage: 0, crowd: 0, rig: 0, air: 0, fore: 0 },
    };

    // --- the queue ---------------------------------------------------
    // Ordered by what the eye reads first: the room and the deck, then the
    // audience, then the rig, then the air and the near plane. Grouping is by
    // reveal group, so a group's surfaces all land within a frame or two of
    // each other and its fade-up is a single event.
    const specRng = rngCrowd.fork(0x32);
    const specs: PersonSpec[] = [];
    for (let i = 0; i < CROWD_VARIANTS; i++) specs.push(makePerson(specRng));

    const q: BakeStep[] = [];
    const step = (group: RevealKey, run: () => void): void => {
      q.push({ group, run });
    };

    step("room", () => bakeBackdrop(backdrop));
    step("room", () => {
      bakeLedOverlay(ledOverlay);
      bakeLedBars(ledBars);
    });
    step("stage", () => bakeStage(stage));
    for (let i = 0; i < crowd.length; i++) {
      step("crowd", () => bakeCrowdTier(crowd[i], crowdScratch, tiers[i], specs));
    }
    step("crowd", () => {
      // Where each variant holds its phone, in cell-normalised space.
      for (let i = 0; i < specs.length; i++) {
        const p = specs[i];
        const side = p.arm === 2 ? -1 : 1;
        p.phoneX = 0.5 + side * (p.shoulderHalf * 0.9 + 0.03);
        p.phoneY = p.arm > 0 ? p.headY - p.headR * 0.4 : p.headY + p.headR * 2.6;
      }
      phoneSpecs = specs;
    });
    step("rig", () => bakeRig(rig));
    step("rig", () => {
      bakeLamps(lampsSurface, lampRings[0]);
      for (let i = 1; i < lampRings.length; i++) {
        lampRings[i].ctx.drawImage(lampRings[0].canvas, 0, 0, lampRings[i].lw, lampRings[i].lh);
      }
      for (let i = 0; i < lampRings.length; i++) tintSurface(lampRings[i], TINT_CSS[i]);
      // Fixtures hang on the same plane as the truss, so they take the same
      // defocus and the same chroma discipline: a par can is grey metal that
      // *emits* warm light, it is not itself orange.
      balanceSurface(lampsSurface, 0.84, 0.08);
      blurSurface(lampsSurface, 1.5);
      for (let i = 0; i < lampRings.length; i++) blurSurface(lampRings[i], 1.2);
    });
    step("air", () => bakeShafts(shafts));
    step("air", () => {
      bakeHazeMask(hazeMask, noise, 3.7);
      next.hazePattern = haze.ctx.createPattern(hazeMask.canvas, "repeat");
      next.hazeFrontPattern = hazeFront.ctx.createPattern(hazeMask.canvas, "repeat");
    });
    step("air", () => {
      bakeHazeBand(hazeBand[0]);
      for (let i = 1; i < hazeBand.length; i++) {
        hazeBand[i].ctx.drawImage(hazeBand[0].canvas, 0, 0, hazeBand[i].lw, hazeBand[i].lh);
      }
      for (let i = 0; i < hazeBand.length; i++) tintSurface(hazeBand[i], TINT_CSS[i]);
      bakeGradeTop(gradeTop);
      bakeFloorSheen(floorSheen);
    });
    step("fore", () => bakeForeground(fore));
    step("fore", () => {
      paintTintedSprite(glowSet, "glow");
      paintTintedSprite(bokehSet, "bokeh");
      if (reflectMask) bakeReflectMask(reflectMask);
    });

    staging = next;
    steps = q;
    stepCursor = 0;
    stepsTotal = q.length;
    // A boot has nothing to show, so the half-built set is published at once and
    // revealed group by group. A rebuild has a live set already on screen, and
    // swapping to a half-built one would be a flicker — it publishes at the end.
    if (!layers) {
      layers = next;
      staged = false;
    } else {
      staged = true;
    }
    return true;
  }

  /**
   * Runs queued construction. Returns true once the set is complete.
   *
   * Two independent brakes: wall-clock and unit count. The clock is the real
   * one, but a stubbed or coarse timer (screenshot harnesses freeze
   * `performance.now`, and cross-origin isolation is off by default) would let a
   * pure time budget drain the whole queue in one frame, so the unit cap keeps
   * the work spread whatever the clock says. One unit always runs, so progress
   * is guaranteed.
   */
  function bootStep(budgetMs: number, maxUnits = 6): boolean {
    if (stepCursor >= steps.length) return true;
    const started = nowMs();
    let ran = 0;
    while (stepCursor < steps.length) {
      if (ran > 0 && (ran >= maxUnits || nowMs() - started >= budgetMs)) break;
      steps[stepCursor].run();
      stepCursor += 1;
      ran += 1;
    }
    if (stepCursor < steps.length) return false;

    steps = [];
    bootComplete = true;
    if (staged && staging) {
      // The new set is complete: retire the old one and take it live whole.
      if (layers !== staging) disposeLayers(layers);
      layers = staging;
      const rv = layers.reveal;
      rv.room = 1;
      rv.stage = 1;
      rv.crowd = 1;
      rv.rig = 1;
      rv.air = 1;
      rv.fore = 1;
    }
    staged = false;
    staging = null;
    return true;
  }

  /** 0–1 construction progress, for the standby card's signal bar. */
  function buildProgress(): number {
    if (stepsTotal <= 0) return layers ? 1 : 0;
    return clamp01(stepCursor / stepsTotal);
  }

  /* ================================================================ *
   * Boot: the standby card and the group reveals
   *
   * The set cannot be ready on the first frame, so the first frame is *about*
   * not being ready. A television plant that has not taken a source to air puts
   * up bars and a slate; so does this one. The card holds for a minimum beat
   * even when construction finishes instantly, because a title that flashes for
   * one frame reads as a bug, and it holds indefinitely while construction is
   * still running, because that is what it is for.
   * ================================================================ */

  /** Minimum time the slate is on screen, however fast the set builds. */
  const STANDBY_HOLD = 0.26;
  /** Length of the switcher take that replaces it. */
  const STANDBY_TAKE = 0.16;
  /** Time a reveal group takes to fade up once its last layer lands. */
  const REVEAL_TIME = 0.18;

  /** 1 = slate at full strength, 0 = gone. */
  let standby = 1;
  let standbyAge = 0;
  /** True once a set has been fully constructed at least once. */
  let bootComplete = false;

  function groupPending(g: RevealKey): boolean {
    for (let i = stepCursor; i < steps.length; i++) if (steps[i].group === g) return true;
    return false;
  }

  function advanceBoot(rawDt: number): void {
    if (layers && !staged) {
      // Boot reveal: each group fades up as soon as its last layer has landed.
      const rv = layers.reveal;
      const k = REVEAL_TIME > 0 ? rawDt / REVEAL_TIME : 1;
      const keys: readonly RevealKey[] = ["room", "stage", "crowd", "rig", "air", "fore"];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (rv[key] >= 1) continue;
        if (groupPending(key)) continue;
        rv[key] = clamp01(rv[key] + k);
      }
    }
    if (standby <= 0) return;
    standbyAge += rawDt;
    if (!bootComplete) return;
    if (standbyAge < STANDBY_HOLD) return;
    standby = Math.max(0, standby - (STANDBY_TAKE > 0 ? rawDt / STANDBY_TAKE : 1));
  }

  /**
   * Baking is deferred to the first draw so the device pixel ratio can be read
   * off the live transform: `resize()` only knows logical dimensions, and
   * baking at 1x on a 2x display would leave the whole set visibly soft.
   */
  function ensureLayers(context: CanvasRenderingContext2D, scene: SceneContext): boolean {
    if (!deviceScaleKnown) {
      const m = context.getTransform();
      // Uniform component of the current transform, ignoring any camera roll.
      const sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
      // Quantised so a shake-induced cover scale cannot trigger a re-bake.
      deviceScale = clamp(Math.round(sc * 2) / 2, 1, 2);
      deviceScaleKnown = true;
    }

    const target = staging ?? layers;
    const matches =
      target !== null &&
      !dirty &&
      target.quality === scene.quality &&
      geo.w === scene.width &&
      geo.h === scene.height &&
      geo.stageY === scene.stageY;
    if (matches) return layers !== null;

    // A change of geometry or tier mid-build abandons the queue: finishing a set
    // nobody will draw would be pure cost.
    if (staging && staging !== layers) disposeLayers(staging);
    staging = null;
    steps = [];
    stepCursor = 0;
    stepsTotal = 0;

    quality = scene.quality;
    settings = QUALITY[quality];
    geo = buildGeometry(Math.max(64, scene.width), Math.max(64, scene.height), clamp(scene.stageY, 32, scene.height - 8));
    buildRig();
    buildCrowd();
    if (!layers) {
      // Nothing on screen to preserve: drop whatever half-built set exists.
      disposeLayers(null);
    }
    dirty = false;
    if (!beginBuild()) return false;
    return layers !== null;
  }

  /* ================================================================ *
   * Per-frame helpers
   * ================================================================ */

  /** Composite parallax offset for a plane at `depth` (0 = far, 1 = lens). */
  let parX = 0;
  let parY = 0;
  let driftX = 0;
  let driftY = 0;
  const PARALLAX_NEUTRAL = 0.42;
  const PARALLAX_GAIN = 0.6;

  function planeX(depth: number): number {
    return parX * (depth - PARALLAX_NEUTRAL) * PARALLAX_GAIN + driftX * depth;
  }

  function planeY(depth: number): number {
    return parY * (depth - PARALLAX_NEUTRAL) * PARALLAX_GAIN * 0.7 + driftY * depth;
  }

  /**
   * Repaints the video wall feed into its small buffer. Everything the room
   * sees behind the host comes from here, so it also drives the wall's spill
   * colour and the crowd's back light.
   */
  function drawLedFeed(scene: SceneContext, l: Layers): void {
    const s = l.ledContent;
    const ctx = s.ctx;
    const W = s.lw;
    const H = s.lh;
    const hot = clamp01(scene.intensity * 0.75 + scene.flash * 0.5);

    ctx.setTransform(s.w / W, 0, 0, s.h / H, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#060404";
    ctx.fillRect(0, 0, W, H);

    if (scene.phase === "lost") {
      // Dead air: the feed collapses to a dark noise field.
      ctx.globalAlpha = 0.5;
      ctx.drawImage(bakery.get("noise-coarse"), 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(6,5,4,0.7)";
      ctx.fillRect(0, 0, W, H);
    } else {
      // Scrolling bars. The strip is drawn twice so the scroll never seams.
      const speed = lerp(11, 42, hot) * (1 - scene.slow * 0.65);
      const bars = l.ledBars;
      const bw = (bars.lw * H) / bars.lh;
      const off = -((time * speed) % bw);
      ctx.globalAlpha = lerp(0.3, 0.56, energy);
      ctx.drawImage(bars.canvas, off, 0, bw, H);
      ctx.drawImage(bars.canvas, off + bw, 0, bw, H);
      ctx.globalAlpha = 1;
    }

    // Ident block.
    const identAlpha = scene.phase === "lost" ? 0.15 : lerp(0.4, 0.78, energy);
    ctx.textBaseline = "middle";
    ctx.globalAlpha = identAlpha;
    ctx.font = font(800, 25);
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    fillTracked(ctx, textCache, "MWM", W * 0.5 + 1, H * 0.38 + 1.2, 6, "center");
    ctx.fillStyle = BONE;
    const identW = fillTracked(ctx, textCache, "MWM", W * 0.5, H * 0.38, 6, "center");
    // Hot underline — a real broadcast ident always has one hard graphic edge.
    ctx.fillStyle = rampAt(keyRamp, 0.55 + hot * 0.45);
    ctx.fillRect(W * 0.5 - identW * 0.5, H * 0.38 + 16, identW, 1.8);
    ctx.font = font(600, 6.4);
    ctx.fillStyle = BONE_40;
    const sub =
      scene.phase === "idle"
        ? "STANDBY"
        : scene.phase === "won"
          ? "ROADMAP DELIVERED"
          : scene.phase === "lost"
            ? "SIGNAL LOST"
            : "COMMUNITY TAKEOVER";
    fillTracked(ctx, textCache, sub, W * 0.5, H * 0.38 + 25, 3.4, "center");
    ctx.globalAlpha = 1;

    // Backlog meter along the bottom: the room shows the pressure the player is
    // under, which is what makes the wall feel wired into the game.
    const meterW = W * 0.4;
    const meterX = (W - meterW) * 0.5;
    const meterY = H - 13;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(meterX, meterY, meterW, 2.2);
    const fill = clamp01(scene.maxBacklog > 0 ? scene.backlog / scene.maxBacklog : 0);
    if (fill > 0) {
      ctx.fillStyle = rampAt(keyRamp, 0.6 + fill * 0.4);
      ctx.fillRect(meterX, meterY, meterW * fill, 2.2);
      ctx.fillStyle = BONE_40;
      ctx.fillRect(meterX + meterW * fill - 1.2, meterY - 0.8, 1.4, 3.8);
    }
    for (let i = 1; i < 8; i++) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(meterX + (meterW * i) / 8, meterY, 0.8, 2.2);
    }

    // Crawl along the very bottom.
    ctx.font = font(600, 5.2);
    ctx.fillStyle = BONE_18;
    const crawl = "PROOF OF PATIENCE   ·   SOON   ·   WEN OG   ·   VBK   ·   POP V2   ·   ";
    const crawlLayout = measureTracked(ctx, textCache, crawl, 1.8);
    const cx = -((time * 26) % crawlLayout.total);
    fillTracked(ctx, textCache, crawl, cx, H - 4, 1.8, "left");
    fillTracked(ctx, textCache, crawl, cx + crawlLayout.total, H - 4, 1.8, "left");

    // Refresh shimmer: the rolling bar a camera sees on an LED wall. 0.32 Hz —
    // far below the 3 Hz flash ceiling, so it stays on under reduced motion.
    const band = 22;
    const sweep = ((time * 0.32) % 1) * (H + band) - band;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = reduced ? 0.05 : 0.13;
    // The baked haze band doubles as the refresh bar: soft-edged, and its
    // horizontal noise keeps the sweep from reading as a printed gradient.
    ctx.drawImage(l.hazeBand[1].canvas, 0, sweep, W, band);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // Exposure grade. The wall is bright *for the room*, not for the frame: it
    // reads as a light source only when the set around it stays darker. Pulled
    // back from a third of a stop to a fifth — the room around it is now a warm
    // *neutral*, so the panel no longer has to be crushed to stay separate from
    // it, and the brand surface it carries is the one the product is named for.
    ctx.fillStyle = "rgba(6,5,4,0.26)";
    ctx.fillRect(0, 0, W, H);
  }

  /** Composites the wall feed onto the set, sliced when the panel is glitching. */
  function blitLed(ctx: CanvasRenderingContext2D, l: Layers, dx: number, dy: number, fade: number): void {
    const { ledX, ledY, ledW, ledH } = geo;
    const src = l.ledContent;
    const x = ledX + dx;
    const y = ledY + dy;
    ctx.globalAlpha = fade;
    if (ledGlitch <= 0.001) {
      ctx.drawImage(src.canvas, x, y, ledW, ledH);
      ctx.globalAlpha = 1;
      return;
    }
    // Tape-style slice offsets: a handful of horizontal bands torn sideways.
    const slices = 7;
    const amp = ledGlitch * ledW * 0.045;
    for (let i = 0; i < slices; i++) {
      const t0 = i / slices;
      const t1 = (i + 1) / slices;
      const n = noise.n2(i * 3.1 + ledGlitchSeed, ledGlitchSeed * 0.7);
      const shift = Math.abs(n) > 0.45 ? n * amp : 0;
      ctx.drawImage(
        src.canvas,
        0,
        src.h * t0,
        src.w,
        src.h * (t1 - t0),
        x + shift,
        y + ledH * t0,
        ledW,
        ledH * (t1 - t0) + 0.5,
      );
    }
    // A single dropped-signal band.
    const bandY = y + ledH * (Math.abs(noise.n2(ledGlitchSeed, 9.4)) * 0.8 + 0.1);
    ctx.globalAlpha = clamp01(ledGlitch * 0.09) * fade;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, bandY, ledW, ledH * 0.03);
    ctx.globalAlpha = 1;
  }

  /**
   * Accumulates key lights into a half-resolution buffer, then multiplies the
   * result by drifting seamless noise. Working at a quarter of the pixel count
   * is not just cheaper — the upscale is what gives the beams their soft,
   * slightly out-of-focus edge.
   *
   * `frontOnly` selects the near pass, which is composited over the play field
   * instead of behind it.
   */
  function renderHaze(l: Layers, frontOnly: boolean): void {
    const haze = frontOnly ? l.hazeFront : l.haze;
    const pattern = frontOnly ? l.hazeFrontPattern : l.hazePattern;
    const hctx = haze.ctx;
    const hs = haze.w / geo.w;
    const vs = haze.h / geo.h;
    hctx.setTransform(1, 0, 0, 1, 0, 0);
    hctx.globalCompositeOperation = "source-over";
    hctx.globalAlpha = 1;
    hctx.clearRect(0, 0, haze.w, haze.h);
    hctx.setTransform(hs, 0, 0, vs, 0, 0);
    hctx.globalCompositeOperation = "lighter";

    const count = Math.min(settings.lights, lights.length);
    for (let i = 0; i < count; i++) {
      const li = lights[i];
      if (frontOnly) {
        if (!li.front) continue;
        // Near haze breathes: the visible density in front of the lens changes
        // far more than the density across the whole room.
        const turb = 0.62 + 0.38 * (noise.n2(time * 0.42 + li.seed, li.seed * 0.13) * 0.5 + 0.5);
        drawShaft(hctx, l, li, li.gain * 0.34 * turb * energy);
      } else {
        // Each beam breathes on its own phase. A room where every shaft pulses
        // together reads as a global dimmer move; shafts that drift
        // independently read as air moving through light.
        const turb = 0.8 + 0.2 * (noise.n2(time * 0.27 + li.seed * 0.7, li.seed * 0.21) * 0.5 + 0.5);
        drawShaft(hctx, l, li, li.gain * turb);
      }
    }

    // Multiply in the drifting noise: this is what turns five gradients into
    // air. The two masks move at different rates and scales, so the structure
    // inside the beams shears rather than translating rigidly.
    const masks = frontOnly ? 1 : settings.hazeMasks;
    if (pattern && masks > 0) {
      hctx.globalCompositeOperation = "destination-in";
      const t = time * (reduced ? 0.35 : 1);
      // The mask is baked below 1:1, so the pattern is stretched back to its
      // authored period before anything else scales it. Everything downstream —
      // drift rate, wrap period, apparent grain size — is then independent of
      // the bake resolution the tier chose.
      const fit = l.hazeMask.lw / l.hazeMask.w;
      const tile = l.hazeMask.lw;
      for (let m = 0; m < masks; m++) {
        // The front pass uses its own scale and direction so the near volume
        // never reads as a copy of the far one.
        const scale = frontOnly ? 1.15 : m === 0 ? 1.7 : 0.85;
        const rate = frontOnly ? -11 : m === 0 ? 7.5 : -4.2;
        const dx = t * rate + noise.n2(t * 0.06 + m * 5.3 + (frontOnly ? 40 : 0), 1.7) * 26;
        const dy = t * (m === 0 ? -2.6 : 1.8) + noise.n2(t * 0.05 + m * 9.1, 8.3) * 14;
        // Wrap the drift to one tile period. Without this the translation grows
        // without bound and the pattern eventually walks out of the frame.
        const px = tile * scale;
        const py = tile * scale * 1.35;
        hctx.save();
        hctx.setTransform(hs, 0, 0, vs, 0, 0);
        hctx.translate(dx - Math.floor(dx / px) * px, dy - Math.floor(dy / py) * py);
        hctx.scale(scale * fit, scale * fit * 1.35);
        hctx.fillStyle = pattern;
        // Fill generously past the frame: the transform moves the origin.
        hctx.fillRect(-geo.w * 2, -geo.h * 2, geo.w * 5, geo.h * 5);
        hctx.restore();
      }
    }

    hctx.globalCompositeOperation = "source-over";
    hctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Draws one light cone. `warmth` picks two adjacent tinted copies of the
   * shaft sprite and cross-fades them additively, which colours the beam
   * without a per-light tint buffer.
   */
  function drawShaft(
    ctx: CanvasRenderingContext2D,
    l: Layers,
    li: KeyLight,
    gain: number,
    coneMul = 1,
  ): void {
    if (gain <= 0.002) return;
    const warm = clamp01(li.warmth);
    const lo = warm < 0.5 ? 0 : 1;
    const f = warm < 0.5 ? warm * 2 : (warm - 0.5) * 2;
    // Cone half-angle → sprite width. The sprite's nominal half-span at the far
    // end is SHAFT_CONE_FRAC of its half-width, so the drawn width has to be
    // scaled up by the reciprocal for the cone edge to land where it should.
    const half = (Math.tan(li.cone * coneMul) * li.length) / SHAFT_CONE_FRAC;

    ctx.save();
    ctx.translate(li.x, li.y);
    ctx.rotate(li.angle);
    ctx.scale((half * 2) / SHAFT_W, li.length / SHAFT_H);
    const a0 = clamp01(gain * (1 - f));
    const a1 = clamp01(gain * f);
    if (a0 > 0.002) {
      ctx.globalAlpha = a0;
      ctx.drawImage(l.shafts[lo].canvas, -SHAFT_W * 0.5, 0, SHAFT_W, SHAFT_H);
    }
    if (a1 > 0.002) {
      ctx.globalAlpha = a1;
      ctx.drawImage(l.shafts[lo + 1].canvas, -SHAFT_W * 0.5, 0, SHAFT_W, SHAFT_H);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Draws the audience: back tier first, each body on its own idle cycle. */
  function drawCrowd(ctx: CanvasRenderingContext2D, scene: SceneContext, l: Layers, fade: number): void {
    const excite = clamp01(scene.intensity * 0.45 + Math.min(1, scene.combo / 8) * 0.4 + energy * 0.25);
    const motion = reduced ? 0.32 : 1;
    ctx.globalAlpha = fade;

    // Back to front. Aerial perspective is carried entirely by the per-tier
    // tint and blur baked into the atlas — a translucent rectangle over each
    // row would leave a hard horizontal edge exactly where the eye is looking
    // for depth.
    for (let ti = 0; ti < l.crowd.length; ti++) {
      const tier = tiers[ti];
      const atlas = l.crowd[ti];
      const dx = planeX(tier.depth);
      const dy = planeY(tier.depth);
      const cellW = atlas.w / CROWD_VARIANTS;
      const cellH = atlas.h;

      for (let i = tier.from; i < tier.to; i++) {
        const p = people[i];
        const w = CELL_W * p.scale;
        const h = CELL_H * p.scale;
        // Idle: a slow vertical bob plus a slower lateral shift, both scaled by
        // how excited the room is. Amplitudes stay under two pixels — a crowd
        // that visibly bounces reads as a screensaver.
        const ph = time * p.freq * TAU + p.phase;
        const bob = Math.sin(ph) * p.ampY * (0.5 + excite * 1.5) * motion;
        const sway = Math.sin(ph * 0.61 + p.phase) * p.ampX * (0.4 + excite) * motion;
        const x = p.x + dx + sway - w * 0.5;
        const y = p.baseY + dy + bob - h;
        if (p.flip) {
          ctx.save();
          ctx.translate(x + w * 0.5, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(atlas.canvas, p.variant * cellW, 0, cellW, cellH, -w * 0.5, y, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(atlas.canvas, p.variant * cellW, 0, cellW, cellH, x, y, w, h);
        }
      }
    }
    ctx.globalAlpha = 1;

    // Phone screens: small, genuinely bright rectangles that bloom, plus the
    // uplight they throw on the face above them.
    if (settings.phones && phoneSpecs.length > 0) {
      ctx.globalCompositeOperation = "lighter";
      const glow = bakery.get("glow");
      for (let i = 0; i < people.length; i++) {
        const p = people[i];
        if (!p.phone || p.tier >= l.crowd.length) continue;
        const cycle = ((time + p.phoneOffset) % p.phonePeriod) / p.phonePeriod;
        // Long on-periods with soft edges — nothing here strobes. Under reduced
        // motion the cycle is frozen to a deterministic subset instead of
        // lighting every screen at once, so the density still looks right.
        const on = reduced
          ? p.phoneOffset % 1 < 0.45
            ? 0.7
            : 0
          : smoothstep(0, 0.08, cycle) * (1 - smoothstep(0.55, 0.7, cycle));
        if (on < 0.02) continue;
        const tier = tiers[p.tier];
        const spec = phoneSpecs[p.variant];
        const w = CELL_W * p.scale;
        const h = CELL_H * p.scale;
        const sgn = p.flip ? -1 : 1;
        // Track the body's idle motion, or the screen detaches from the hand.
        const ph = time * p.freq * TAU + p.phase;
        const bob = Math.sin(ph) * p.ampY * (0.5 + excite * 1.5) * motion;
        const sway = Math.sin(ph * 0.61 + p.phase) * p.ampX * (0.4 + excite) * motion;
        const px = p.x + planeX(tier.depth) + sway + sgn * (spec.phoneX - 0.5) * w;
        const py = p.baseY + planeY(tier.depth) + bob - h + spec.phoneY * h;
        const sw = Math.max(1.4, w * 0.075);
        const sh = sw * 1.8;
        ctx.globalAlpha = clamp01(on * 0.36 * (1 - tier.rim * 0.35)) * fade;
        ctx.drawImage(glow, px - sw * 2.4, py - sh * 2.2, sw * 4.8, sh * 4.4);
        ctx.globalAlpha = clamp01(on * (0.58 - tier.rim * 0.2)) * fade;
        ctx.fillStyle = "#f2ece4";
        ctx.fillRect(px - sw * 0.5, py - sh * 0.5, sw, sh);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }

  /**
   * Live picture on the two foldback monitors. Every colour comes from a
   * pre-built ramp and every opacity from `globalAlpha`, so the whole thing
   * runs without allocating a single CSS string per frame.
   */
  function drawMonitors(
    scene: SceneContext,
    ctx: CanvasRenderingContext2D,
    l: Layers,
    dx: number,
    dy: number,
    fade: number,
  ): void {
    const { sx, sy } = geo;
    const mw = 70 * sx;
    const mh = 35 * sy;
    const my = 412 * sy + dy;
    const hot = rampAt(keyRamp, 0.7 + scene.intensity * 0.3);
    // Level meters read at ~1.8 Hz normally; slowed well under 3 Hz when the
    // player has asked for reduced motion.
    const rate = reduced ? 0.5 : 1.8;
    const bars = 11;
    const barW = (mw - 6 * sx) / bars - 1.2 * sx;

    for (let s = 0; s < 2; s++) {
      const cx = (s === 0 ? 118 * sx : geo.w - 118 * sx) + dx;
      const x = cx - mw * 0.5;
      ctx.globalAlpha = fade;
      ctx.fillStyle = "#0a0706";
      ctx.fillRect(x, my, mw, mh);
      for (let i = 0; i < bars; i++) {
        const n = Math.abs(noise.n2(time * rate + i * 0.7, cx * 0.01));
        const amp = clamp01(n * (0.35 + scene.intensity * 0.75) + scene.flash * 0.4);
        const bh = mh * 0.72 * amp;
        // The top three segments run hot — a peak-hold section, not a rainbow.
        ctx.globalAlpha = (i > bars - 3 ? 0.85 : 0.4 + amp * 0.35) * fade;
        ctx.fillStyle = i > bars - 3 ? hot : BONE;
        ctx.fillRect(x + 3 * sx + (i / bars) * (mw - 6 * sx), my + mh - 3 * sy - bh, barW, bh);
      }
      ctx.globalAlpha = 0.55 * fade;
      ctx.fillStyle = hot;
      ctx.fillRect(x, my + mh - 2 * sy, mw, 1.2 * sy);
      // Screen glow spilling onto the set.
      ctx.globalCompositeOperation = "lighter";
      drawTinted(ctx, l.glowSet, 0.86, (0.16 + scene.intensity * 0.1) * fade, x - mw * 0.6, my - mh * 0.7, mw * 2.2, mh * 2.6);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Bounce: a fixture pulling 208 counts at its lens does not leave the steel
   * it is clamped to black. Each lit lamp lays a wide, shallow pool back onto
   * the truss chord and the ceiling void around it — anisotropic, because the
   * spill runs along the chord — plus a tighter, hotter pool at the yoke. Drawn
   * before the fixture bodies so the metal sits *in* its own light.
   */
  function drawLampBounce(ctx: CanvasRenderingContext2D, l: Layers, dx: number, dy: number, fade: number): void {
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i];
      const li = lamp.light >= 0 && lamp.light < settings.lights ? lights[lamp.light] : null;
      if (!li || li.gain <= 0.01) continue;
      const r = LAMP_CELL_W * lamp.scale * 2.1;
      const x = lamp.x + dx;
      const y = lamp.y + dy;
      // Along the run: 4:1, so the chord catches a smear rather than a disc.
      drawTinted(ctx, l.glowSet, li.warmth, clamp01(li.gain * 0.24) * fade, x - r, y - r * 0.3, r * 2, r * 0.6);
      // At the yoke: the hot near-field, where the clamp and the body are.
      drawTinted(
        ctx,
        l.glowSet,
        li.warmth,
        clamp01(li.gain * 0.34) * fade,
        x - r * 0.44,
        y - r * 0.4,
        r * 0.88,
        r * 0.72,
      );
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /**
   * Anisotropic specular on the aluminium trim, tracking the fixtures.
   *
   * Brushed extrusion is a one-dimensional roughness: a source smears along the
   * grain and stays tight across it, so a fixture leaves a long low streak on
   * the band under it, not a round hot spot. The streak position follows the
   * fixture's own axis, so a swinging lamp drags its highlight along the trim.
   */
  function drawTrimSpecular(ctx: CanvasRenderingContext2D, l: Layers, dx: number, dy: number, fade: number): void {
    const { sx, sy, trimY, trimH, wallTopY } = geo;
    const count = Math.min(settings.lights, lights.length);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < count; i++) {
      const li = lights[i];
      if (li.gain <= 0.012) continue;
      for (let band = 0; band < 2; band++) {
        const by = band === 0 ? trimY : wallTopY;
        const bh = band === 0 ? trimH : 14 * sy;
        const power = band === 0 ? 1 : 0.5;
        // Mirror angle: the band is upstage of the rig, so the highlight sits
        // where the fixture's axis reflects off a horizontal surface.
        const hx = li.x + Math.tan(li.angle) * (by - li.y) * 0.5 + dx;
        if (hx < -geo.w * 0.5 || hx > geo.w * 1.5) continue;
        const sw = (240 + 260 * li.gain) * sx;
        drawTinted(
          ctx,
          l.glowSet,
          li.warmth,
          clamp01(li.gain * 0.3 * power) * fade,
          hx - sw * 0.5,
          by + dy - bh * 0.9,
          sw,
          bh * 2.8,
        );
        // The filament line itself, sitting on the extrusion's specular band a
        // third of the way down the face — where `bakeBackdrop` puts it.
        ctx.globalAlpha = clamp01(li.gain * 0.4 * power) * fade;
        ctx.fillStyle = rampAt(keyRamp, clamp01(li.warmth * 0.75 + 0.12));
        ctx.fillRect(hx - sw * 0.16, by + dy + bh * 0.3, sw * 0.32, Math.max(0.6, 1.2 * sy));
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Fixtures: body, emissive lens, hot core, optional anamorphic flare. */
  function drawLamps(ctx: CanvasRenderingContext2D, l: Layers, dx: number, dy: number, fade: number): void {
    const cellW = l.lamps.w / LAMP_VARIANTS;
    const cellH = l.lamps.h;
    const star = bakery.get("star-flare");
    drawLampBounce(ctx, l, dx, dy, fade);

    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i];
      const li = lamp.light >= 0 && lamp.light < settings.lights ? lights[lamp.light] : null;
      const dw = LAMP_CELL_W * lamp.scale;
      const dh = LAMP_CELL_H * lamp.scale;
      const angle = lamp.rest + lamp.swing.value;

      ctx.save();
      ctx.translate(lamp.x + dx, lamp.y + dy);
      ctx.rotate(angle);
      ctx.globalAlpha = fade;
      ctx.drawImage(l.lamps.canvas, lamp.variant * cellW, 0, cellW, cellH, -dw * 0.5, -6 * lamp.scale, dw, dh);
      ctx.globalAlpha = 1;

      if (li && li.gain > 0.004) {
        const colour = rampAt(keyRamp, li.warmth);
        const lensY = (lamp.variant === 0 ? 82 : lamp.variant === 1 ? 76 : 80) * lamp.scale - 6 * lamp.scale;
        const lensR = (lamp.variant === 1 ? 16 : 13) * lamp.scale;
        ctx.globalCompositeOperation = "lighter";
        // The fresnel rings, lit at the beam colour: the same two-copy
        // cross-fade the shafts use, with a source rect into the atlas.
        const ringLo = li.warmth < 0.5 ? 0 : 1;
        const ringF = li.warmth < 0.5 ? li.warmth * 2 : (li.warmth - 0.5) * 2;
        const ringA = clamp01(li.gain * 1.5) * fade;
        if (ringA * (1 - ringF) > 0.002) {
          ctx.globalAlpha = clamp01(ringA * (1 - ringF));
          ctx.drawImage(l.lampRings[ringLo].canvas, lamp.variant * cellW, 0, cellW, cellH, -dw * 0.5, -6 * lamp.scale, dw, dh);
        }
        if (ringA * ringF > 0.002) {
          ctx.globalAlpha = clamp01(ringA * ringF);
          ctx.drawImage(l.lampRings[ringLo + 1].canvas, lamp.variant * cellW, 0, cellW, cellH, -dw * 0.5, -6 * lamp.scale, dw, dh);
        }
        // Hot filament core — small and near-white, so the bloom pass has a
        // genuine highlight to find rather than a soft blob standing in for one.
        ctx.globalAlpha = clamp01(li.gain * 0.9) * fade;
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(0, lensY, lensR * 0.42, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = clamp01(li.gain) * fade;
        ctx.fillStyle = "#fffaf4";
        ctx.beginPath();
        ctx.arc(0, lensY, lensR * 0.2, 0, TAU);
        ctx.fill();
        // Halo in the air immediately around the lens.
        drawTinted(ctx, l.glowSet, li.warmth, li.gain * 0.55 * fade, -lensR * 2.6, lensY - lensR * 2.6, lensR * 5.2, lensR * 5.2);
        if (settings.lampFlare) {
          ctx.globalAlpha = clamp01(li.gain * 0.15) * fade;
          ctx.drawImage(star, -lensR * 5, lensY - lensR * 5, lensR * 10, lensR * 10);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    }
  }

  /** Specular streaks the key lights lay down the polished deck. */
  function drawFloorSpecular(ctx: CanvasRenderingContext2D, l: Layers, fade: number): void {
    const { stageY, floorH, w } = geo;
    ctx.globalCompositeOperation = "lighter";
    const count = Math.min(settings.lights, lights.length);
    for (let i = 0; i < count; i++) {
      const li = lights[i];
      if (li.gain <= 0.01) continue;
      // Where the beam axis crosses the deck. Anything landing far outside the
      // frame contributes nothing and is skipped.
      const hitX = li.x + Math.tan(li.angle) * (stageY - li.y);
      if (hitX < -w * 0.4 || hitX > w * 1.4) continue;
      // Anisotropy: a polished floor smears a highlight along the view axis, so
      // the streak is far taller than it is wide.
      const sw = Math.tan(li.cone) * (stageY - li.y) * 2.1 + 26;
      const sh = floorH * lerp(1.5, 2.4, clamp01(li.gain));
      // Same two-copy cross-fade the shafts use, so the reflection is the
      // colour of the light that made it.
      const warm = clamp01(li.warmth);
      const lo = warm < 0.5 ? 0 : 1;
      const f = warm < 0.5 ? warm * 2 : (warm - 0.5) * 2;
      const a = clamp01(li.gain * 0.42) * fade;
      if (a * (1 - f) > 0.002) {
        ctx.globalAlpha = clamp01(a * (1 - f));
        ctx.drawImage(l.floorSheen[lo].canvas, hitX - sw * 0.5, stageY, sw, sh);
      }
      if (a * f > 0.002) {
        ctx.globalAlpha = clamp01(a * f);
        ctx.drawImage(l.floorSheen[lo + 1].canvas, hitX - sw * 0.5, stageY, sw, sh);
      }
      // The beam has to *land*. A shaft that fades out in mid-air is a gradient;
      // a shaft that puts a pool of light on the deck is a light. The pool is
      // wide and shallow because the deck is seen at a grazing angle, and it
      // widens with the cone so a tightened rig punches a smaller, harder spot.
      const poolW = sw * 1.55;
      const poolH = Math.max(10, floorH * 0.62);
      drawTinted(
        ctx,
        l.glowSet,
        warm,
        clamp01(li.gain * 0.38) * fade,
        hitX - poolW * 0.5,
        stageY - poolH * 0.22,
        poolW,
        poolH,
      );
      // Hot contact line right where the beam meets the nosing.
      ctx.globalAlpha = clamp01(li.gain * 0.4) * fade;
      ctx.fillStyle = rampAt(floorRamp, 0.16 + warm * 0.4);
      ctx.fillRect(hitX - sw * 0.32, stageY + 1, sw * 0.64, 2.2);
      drawTinted(ctx, l.glowSet, warm, li.gain * 0.3 * fade, hitX - sw * 0.5, stageY - sw * 0.16, sw, sw * 0.4);
    }

    // Warm wash from the LED tape and the wall, right under the nosing.
    ctx.globalAlpha = clamp01(0.18 + floorHeat * 0.4);
    ctx.fillStyle = rampAt(floorRamp, 0.8 + floorHeat * 0.2);
    ctx.fillRect(0, stageY + 5, w, 1.4);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Impact scuffs and their brief hot flare on the deck. */
  function drawImpacts(ctx: CanvasRenderingContext2D, l: Layers, reveal: number): void {
    ctx.globalCompositeOperation = "lighter";
    const ring = bakery.get("ring");
    for (let i = 0; i < impacts.length; i++) {
      const m = impacts[i];
      if (!m.live) continue;
      const t = clamp01(m.age / 0.85);
      const fade = 1 - ease.outCubic(t);
      const r = lerp(18, 96, ease.outQuart(t)) * (0.6 + m.force * 0.7);
      // Scuffs live on the deck: a landing above the line still marks the floor
      // directly beneath it.
      const my = Math.max(m.y, geo.stageY);
      ctx.globalAlpha = clamp01(fade * 0.24 * m.force) * reveal;
      ctx.drawImage(ring, m.x - r, my - r * 0.26, r * 2, r * 0.52);
      drawTinted(ctx, l.glowSet, 0.72, fade * fade * 0.4 * m.force * reveal, m.x - r * 0.8, my - r * 0.3, r * 1.6, r * 0.6);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /* ================================================================ *
   * Public surface
   * ================================================================ */

  function resize(width: number, height: number): void {
    if (!(width > 0) || !(height > 0)) return;
    geo = buildGeometry(Math.max(64, width), Math.max(64, height), geo.stageY);
    dirty = true;
    deviceScaleKnown = false;
  }

  function update(scene: SceneContext): void {
    const dt = Number.isFinite(scene.dt) ? clamp(scene.dt, 0, 0.1) : 0;
    const rawDt = Number.isFinite(scene.rawDt) ? clamp(scene.rawDt, 0, 0.1) : 0;
    time += dt;
    rawTime += rawDt;
    reduced = scene.reducedMotion;
    advanceBoot(rawDt);

    // Phase energy: the room comes up to temperature when the show starts and
    // drops on a loss. A spring rather than a lerp so it overshoots slightly on
    // the way in, the way a dimmer rack does.
    const won = scene.phase === "won";
    const lost = scene.phase === "lost";
    const idle = scene.phase === "idle";
    phaseEnergy.set(won ? 1 : lost ? 0.42 : idle ? 0.96 : 1);
    phaseEnergy.update(dt);
    pressure.set(clamp01(scene.intensity));
    pressure.update(dt);

    press = clamp01(pressure.value);
    energy = clamp01(phaseEnergy.value);

    // Phase look. These are the four *lighting states* of the show and they are
    // deliberately far apart: measured on the pre-fix build, win and lose sat
    // within 11 % of each other on identical stage regions and both sat below
    // gameplay, which made the two endings indistinguishable from each other
    // and from a dark bug.
    warmBias = won ? -0.24 : lost ? 0.36 : idle ? -0.02 : 0;
    coneBias = won ? 1.5 : lost ? 0.62 : idle ? 1.26 : 1;
    // Attract runs the rig *hotter* than the show, not colder. The title card
    // is a DOM scrim that passes a quarter of the picture at its lightest point,
    // so a set lit for gameplay arrives on screen at a sixth of its value and
    // reads as a black rectangle behind a headline. The set has to be over-lit
    // to survive the scrim; the composition is unchanged.
    gainBias = won ? 1.35 : lost ? 0.66 : idle ? 1.34 : 1;
    hazeBias = won ? 0.58 : lost ? 1.7 : idle ? 0.9 : 1;
    houseLift = won ? 1 : idle ? 1.15 : lost ? 0.1 : 0;

    // Camera parallax. The differential is taken about a neutral plane so that,
    // whether or not the loop has already applied the camera transform, the
    // back of the room lags the front rather than the whole set sliding.
    parX = damp(parX, camera.offset.x, 22, rawDt);
    parY = damp(parY, camera.offset.y, 22, rawDt);
    // A very slow operator drift on top: three pixels at 0.05 Hz reads as a
    // hand on a fluid head, not as motion.
    const driftScale = reduced ? 0.25 : 1;
    driftX = noise.n2(time * 0.055, 3.1) * 3.4 * driftScale;
    driftY = noise.n2(time * 0.047, 91.7) * 2.1 * driftScale;

    // --- fixtures ---
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i];
      lamp.swing.update(dt);
      if (!reduced) {
        // Air movement in the room nudges every fixture continuously.
        lamp.swing.set(noise.n2(time * 0.13 + lamp.drift, lamp.drift * 0.31) * 0.012);
      } else {
        lamp.swing.set(0);
      }
    }

    // --- key lights ---
    // Everything here is recomputed from the authored `base*` values, never
    // from last frame's, so pressure and mood can never accumulate.
    const count = lights.length;
    for (let i = 0; i < count; i++) {
      const li = lights[i];
      const lamp = lamps[li.lamp];
      li.angle = lamp.rest + lamp.swing.value;
      // The emitter sits at the lens, not the yoke, so a swinging lamp sweeps
      // its beam from the correct pivot.
      const reach = lamp.reach * 0.72;
      li.x = lamp.x + Math.sin(li.angle) * reach + planeX(0.8);
      li.y = lamp.y + Math.cos(li.angle) * reach + planeY(0.8);
      // Under pressure the rig gets tighter, hotter and higher in contrast; in
      // slow motion the beams pinch a little further for a harder look. The
      // spans below are wide on purpose: between one caller and seven the rig
      // used to move by a tenth of a luminance step, which is not a reaction.
      li.cone = li.baseCone * coneBias * lerp(1.12, 0.54, press) * lerp(1, 0.9, clamp01(scene.slow));
      const flicker = reduced ? 1 : 1 + noise.n2(time * 2.3 + li.seed, li.seed * 0.7) * 0.035;
      // The rig is tungsten, so the resting point of this ramp sits above the
      // middle stop, not below it. Pulling it under the bone stop is what left
      // the whole room reading as cool grey: every additive light in the set is
      // coloured from here, so a cool rig makes a cool set no matter what the
      // surfaces underneath are authored as.
      li.warmth = clamp01(li.baseWarmth + warmBias + scene.mood * 0.18 - 0.09 + press * 0.42);
      li.gain = clamp01(
        li.power *
          energy *
          gainBias *
          flicker *
          lerp(0.46, 1.62, press) *
          (1 + clamp01(scene.flash) * 0.8),
      );
    }

    // --- video wall glitch decay ---
    if (ledGlitch > 0) ledGlitch = Math.max(0, ledGlitch - rawDt * 3.6);

    // --- floor heat from recent impacts ---
    floorHeat = damp(floorHeat, 0, 2.4, rawDt);

    // --- impact marks ---
    for (let i = 0; i < impacts.length; i++) {
      const m = impacts[i];
      if (!m.live) continue;
      m.age += rawDt;
      if (m.age > 0.9) m.live = false;
    }

    // --- ambient dust ---
    // The preset is long-lived and wrapping, so a small top-up on a slow timer
    // holds a steady population instead of a stampede at spawn.
    dustTimer -= dt;
    if (dustTimer <= 0) {
      dustTimer = reduced ? 4.2 : 2.4;
      const n = Math.max(1, Math.round(6 * (reduced ? 0.3 : 1) * (quality === "low" ? 0.5 : 1)));
      particles.emit("ambient-dust", {
        x: geo.w * 0.5,
        y: geo.stageY * 0.55,
        count: n,
        behind: true,
        color: rampAt(hazeRamp, 0.3 + press * 0.4),
      });
    }

    // --- audience camera flashes ---
    if (!reduced && scene.phase !== "idle") {
      flashTimer -= dt;
      if (flashTimer <= 0) {
        const rate = lerp(2.6, 0.5, clamp01(press * 0.6 + Math.min(1, scene.combo / 9) * 0.4));
        flashTimer = rngAir.range(rate * 0.5, rate * 1.5);
        if (tiers.length > 0) {
          const tier = tiers[rngAir.int(0, tiers.length - 1)];
          particles.emit("crowd-flash", {
            x: rngAir.range(geo.w * 0.04, geo.w * 0.96),
            y: tier.baseline - CELL_H * tier.scale * rngAir.range(0.55, 0.9),
            behind: true,
          });
        }
      }
    }
  }

  function drawBackground(context: CanvasRenderingContext2D, scene: SceneContext): void {
    const ready = ensureLayers(context, scene);
    // One unit of construction is always run from the draw path, so a host that
    // never calls `bootStep` still finishes the set — just more slowly.
    if (!bootStep(2, 1)) {
      /* still building; whatever exists is composited below */
    }
    if (!ready) return;
    const l = layers;
    if (!l) return;
    const { w, h, stageY, stageTop, rigH } = geo;
    // Reveal weights. On a boot each group fades up as it lands (behind the
    // standby card); on a rebuild they are all 1 because the live set is only
    // ever swapped whole.
    const rv = l.reveal;

    context.save();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;

    // Wipe to the room's darkest value so the parallax offsets never reveal
    // whatever was in the buffer before.
    context.fillStyle = CHARCOAL;
    context.fillRect(0, 0, w, h);

    // --- plane 0/1: wall, foam, trim, video wall ---
    const backX = planeX(0.12);
    const backY = planeY(0.12);
    if (rv.room <= 0.001) {
      context.restore();
      return;
    }
    context.globalAlpha = rv.room;
    context.drawImage(l.backdrop.canvas, backX, backY, w, stageY);

    drawLedFeed(scene, l);
    blitLed(context, l, backX, backY, rv.room);
    context.globalAlpha = rv.room;
    context.drawImage(l.ledOverlay.canvas, geo.ledX + backX, geo.ledY + backY, geo.ledW, geo.ledH);
    context.globalAlpha = 1;

    // Wall spill: the video wall is the back of the room's key, so it throws a
    // tinted halo onto the flat and wraps the audience from behind.
    const wallHot = clamp01(scene.intensity * 0.6 + scene.flash * 0.5 + 0.15);
    context.globalCompositeOperation = "lighter";
    // The spill is warm but not saturated: light bouncing off a grey flat keeps
    // the source's colour temperature and loses most of its chroma. The panel
    // stays the saturated thing; the wall around it only reports what colour the
    // panel is.
    drawTinted(
      context,
      l.glowSet,
      0.22 + wallHot * 0.4,
      (0.09 + wallHot * 0.13) * energy * (scene.phase === "lost" ? 0.3 : 1) * rv.room,
      geo.ledX + backX - geo.ledW * 0.14,
      geo.ledY + backY - geo.ledH * 0.28,
      geo.ledW * 1.28,
      geo.ledH * 1.85,
    );
    context.globalCompositeOperation = "source-over";

    // --- the rig's own light landing on the set ---
    // Specular the fixtures lay on the aluminium trim. Without it the only
    // motivated light in the room is the shaft itself and every surface the
    // beam passes reads as unlit.
    drawTrimSpecular(context, l, backX, backY, rv.room);

    // --- house lights ---
    // Attract and victory are not the show: the audience wash comes up, the
    // room becomes legible, and the frame stops being a black rectangle with a
    // title on it. Motivated by the house rig above the audience, so it enters
    // from the top of the wall and dies before the deck.
    if (houseLift > 0.005) {
      const houseA = houseLift * 0.5 * (0.7 + energy * 0.5);
      context.globalCompositeOperation = "lighter";
      drawTinted(context, l.hazeBand, 0.28, houseA * 0.7, -w * 0.05, geo.wallTopY - geo.sy * 40, w * 1.1, geo.sy * 300);
      drawTinted(
        context,
        l.glowSet,
        0.3,
        houseA * 0.5,
        w * 0.1,
        geo.wallTopY - geo.sy * 60,
        w * 0.8,
        geo.sy * 420,
      );
      context.globalCompositeOperation = "source-over";
    }

    // --- ON AIR tally ---
    {
      const { sx, sy, trimY, trimH } = geo;
      const tallyW = 96 * sx;
      const tallyH = 21 * sy;
      const tx = 660 * sx + backX;
      const ty = trimY + (trimH - tallyH) * 0.5 + backY;
      const live =
        (scene.phase === "playing" ? 1 : scene.phase === "won" ? 0.8 : scene.phase === "idle" ? 0.3 : 0.12) * rv.room;
      context.save();
      context.globalCompositeOperation = "lighter";
      // A tally is a gelled lamp behind a legend, and its gel is the show's
      // colour. It is one of the few things in the room allowed to sit at a full
      // stop of chroma: it is a source, not a lit surface.
      drawTinted(
        context,
        l.glowSet,
        1,
        live * (0.1 + scene.intensity * 0.12),
        tx - tallyW * 0.45,
        ty - tallyH * 1.5,
        tallyW * 1.9,
        tallyH * 4,
      );
      context.globalAlpha = live * (0.72 + scene.intensity * 0.28);
      context.fillStyle = HEMI;
      roundedPath(context, tx + 2 * sx, ty + 2 * sy, tallyW - 4 * sx, tallyH - 4 * sy, 2 * sx);
      context.fill();
      // Hot centre of the lamp behind the diffuser, so the legend reads black
      // against a genuinely blown face rather than against flat orange.
      context.globalAlpha = live * (0.3 + scene.intensity * 0.3);
      context.fillStyle = rampAt(keyRamp, 0.88);
      roundedPath(context, tx + 5 * sx, ty + 5 * sy, tallyW - 10 * sx, tallyH - 10 * sy, 1.5 * sx);
      context.fill();
      context.globalAlpha = live;
      context.font = font(800, 10 * sy);
      context.textBaseline = "middle";
      context.fillStyle = "#1a0703";
      context.globalCompositeOperation = "source-over";
      fillTracked(context, textCache, "ON AIR", tx + tallyW * 0.5, ty + tallyH * 0.5, 3 * sx, "center");
      context.restore();
    }

    // --- plane 2: audience ---
    if (rv.crowd > 0.001) drawCrowd(context, scene, l, rv.crowd);

    // --- far haze stratum, sitting between the crowd and the stage ---
    context.globalCompositeOperation = "lighter";
    {
      const bandH = geo.sy * 190;
      const bx = Math.sin(time * 0.031) * 40 - 20;
      drawTinted(
        context,
        l.hazeBand,
        0.14 + scene.intensity * 0.4,
        (0.05 + scene.intensity * 0.14) * hazeBias * energy * rv.air,
        bx,
        geo.crowdTop - bandH * 0.42,
        w * 1.1,
        bandH,
      );
    }
    context.globalCompositeOperation = "source-over";

    // --- plane 3/4: apron, monitors, nosing, deck ---
    const stageDX = planeX(0.52);
    const stageDY = planeY(0.52);
    if (rv.stage > 0.001) {
      context.globalAlpha = rv.stage;
      context.drawImage(l.stage.canvas, stageDX, stageTop + stageDY, w, h - stageTop);
      context.globalAlpha = 1;
      drawMonitors(scene, context, l, stageDX, stageDY, rv.stage);
      drawFloorSpecular(context, l, rv.stage * rv.air);
      drawImpacts(context, l, rv.stage);
    }

    // --- volumetric light ---
    if (rv.air > 0.001) {
      renderHaze(l, false);
      context.globalCompositeOperation = "lighter";
      // Haze density is the loudest cue the room has for pressure: thin and
      // clean at one caller, thick and volumetric at seven.
      context.globalAlpha = clamp01((0.3 + scene.intensity * 0.78) * hazeBias) * energy * rv.air;
      // No offset: the shafts were accumulated at absolute coordinates that
      // already include the rig's parallax, so the buffer maps 1:1.
      context.drawImage(l.haze.canvas, 0, 0, w, h);
      context.globalAlpha = 1;
    }
    context.globalCompositeOperation = "source-over";

    // --- mid haze stratum, drifting the other way ---
    context.globalCompositeOperation = "lighter";
    {
      const bandH = geo.sy * 180;
      const bx = -Math.sin(time * 0.023 + 1.7) * 56 - 30;
      drawTinted(
        context,
        l.hazeBand,
        0.28 + scene.intensity * 0.38,
        (0.028 + scene.intensity * 0.13) * hazeBias * energy * rv.air,
        bx,
        geo.apronY - bandH * 0.55,
        w * 1.15,
        bandH,
      );
    }
    context.globalCompositeOperation = "source-over";

    // --- plane 5: rig ---
    const rigDX = planeX(0.8);
    const rigDY = planeY(0.8);
    if (rv.rig > 0.001) {
      context.globalAlpha = rv.rig;
      context.drawImage(l.rig.canvas, rigDX, rigDY, w, rigH);
      context.globalAlpha = 1;
      drawLamps(context, l, rigDX, rigDY, rv.rig);
    }

    // --- atmospheric grade over the whole set ---
    context.globalAlpha = rv.room;
    context.drawImage(l.gradeTop.canvas, 0, 0, w, h);
    context.globalAlpha = 1;

    context.restore();
  }

  function drawForeground(context: CanvasRenderingContext2D, scene: SceneContext): void {
    const l = layers;
    if (!l) return;
    const { w, h, stageY, floorH } = geo;
    // Air and near-plane reveals. Both fade in behind the standby card on a
    // boot; on a rebuild they are already 1.
    const airFade = l.reveal.air;
    const foreFade = l.reveal.fore;

    context.save();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;

    // --- screen-space floor reflection -------------------------------
    // drawForeground runs after the cards, the desk and the effects, so the
    // frame above the stage line is exactly what the deck should be showing.
    if (foreFade > 0.01 && settings.reflection && l.reflect && l.reflectOut && l.reflectMask) {
      const src = context.canvas;
      const srcW = src.width;
      const srcH = src.height;
      if (srcW > 4 && srcH > 4) {
        const m = context.getTransform();
        const grabH = Math.min(stageY, floorH * 2.4);
        const y0 = stageY - grabH;
        // Map the logical grab rect into backing-store pixels through whatever
        // transform the loop has installed — device scale, camera, or both. Two
        // opposite corners are enough: any camera roll is under two degrees, so
        // the axis-aligned bound is within a pixel of the true rect.
        const x0d = m.a * 0 + m.c * y0 + m.e;
        const y0d = m.b * 0 + m.d * y0 + m.f;
        const x1d = m.a * w + m.c * stageY + m.e;
        const y1d = m.b * w + m.d * stageY + m.f;
        const sxp = Math.max(0, Math.min(x0d, x1d));
        const syp = Math.max(0, Math.min(y0d, y1d));
        const swp = Math.min(srcW - sxp, Math.abs(x1d - x0d));
        const shp = Math.min(srcH - syp, Math.abs(y1d - y0d));

        if (swp > 2 && shp > 2) {
          const a = l.reflect;
          const b = l.reflectOut;
          a.ctx.setTransform(1, 0, 0, 1, 0, 0);
          a.ctx.globalCompositeOperation = "source-over";
          a.ctx.globalAlpha = 1;
          a.ctx.clearRect(0, 0, a.w, a.h);
          a.ctx.drawImage(src, sxp, syp, swp, shp, 0, 0, a.w, a.h);

          b.ctx.setTransform(1, 0, 0, 1, 0, 0);
          b.ctx.globalCompositeOperation = "source-over";
          b.ctx.globalAlpha = 1;
          b.ctx.clearRect(0, 0, b.w, b.h);
          // Mirror about the stage line and foreshorten: the deck recedes, so
          // the reflection is vertically compressed. Three offset taps give the
          // anisotropic vertical smear polished concrete actually produces.
          b.ctx.save();
          b.ctx.translate(0, b.h);
          b.ctx.scale(1, -1);
          b.ctx.globalCompositeOperation = "lighter";
          const taps = 3;
          for (let i = 0; i < taps; i++) {
            b.ctx.globalAlpha = (1 - i / taps) * 0.62;
            b.ctx.drawImage(a.canvas, 0, -i * 1.6, b.w, b.h + i * 3.2);
          }
          b.ctx.restore();
          b.ctx.globalCompositeOperation = "destination-in";
          b.ctx.globalAlpha = 1;
          b.ctx.drawImage(l.reflectMask.canvas, 0, 0, b.w, b.h);
          b.ctx.globalCompositeOperation = "source-over";

          // Additive: a reflection adds light to the floor, it does not replace
          // it — which also means the desk sitting on the deck is never erased.
          context.globalCompositeOperation = "lighter";
          context.globalAlpha = clamp01(0.3 + scene.intensity * 0.1) * energy * foreFade;
          context.drawImage(b.canvas, 0, stageY + 5, w, floorH);
          context.globalAlpha = 1;
          context.globalCompositeOperation = "source-over";
        }
      }
    }

    // --- shafts that pass in front of the play field -----------------
    if (airFade > 0.01) {
      renderHaze(l, true);
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = clamp01((0.4 + scene.intensity * 0.62) * hazeBias) * energy * airFade;
      context.drawImage(l.hazeFront.canvas, 0, 0, w, h);
      context.globalAlpha = 1;
    }

    // --- foreground haze bloom ---------------------------------------
    // Kept modest in area: this is the wash of light scattered off the near
    // haze, not a soft blob standing in for the bloom pass, which will find the
    // real highlights on its own.
    const bloom = clamp01(0.12 + scene.intensity * 0.2 + scene.flash * 0.4) * energy * foreFade;
    context.globalCompositeOperation = "lighter";
    drawTinted(context, l.glowSet, 0.34 + scene.intensity * 0.44, bloom * 0.7, w * 0.06, stageY - h * 0.5, w * 0.88, h * 0.62);
    context.globalCompositeOperation = "source-over";

    // --- defocused foreground furniture ------------------------------
    context.globalAlpha = 0.9 * foreFade;
    context.drawImage(l.fore.canvas, planeX(1) * 1.6, planeY(1) * 1.6, w, h);
    context.globalAlpha = 1;

    // --- out-of-focus practicals at the frame edges ------------------
    if (settings.bokeh > 0 && foreFade > 0.01) {
      context.globalCompositeOperation = "lighter";
      for (let i = 0; i < settings.bokeh; i++) {
        // Deterministic placement from noise rather than stored state: these
        // never need to persist, and it keeps the frame reproducible.
        const seed = i * 17.3;
        const bx = (noise.n2(seed, 1.3) * 0.5 + 0.5) * w;
        const edge = bx < w * 0.5 ? bx / (w * 0.5) : (w - bx) / (w * 0.5);
        // Only near the edges: a bokeh ball in the middle of frame is a bug.
        if (edge > 0.34) continue;
        const by = (noise.n2(seed + 5.1, 7.7) * 0.5 + 0.5) * h;
        const r = lerp(26, 74, noise.n2(seed + 11.9, 2.2) * 0.5 + 0.5);
        const drift = noise.n2(rawTime * 0.07 + seed, 3.3) * 9;
        const twinkle = 0.5 + 0.5 * (noise.n2(rawTime * 0.4 + seed, 8.8) * 0.5 + 0.5);
        drawTinted(
          context,
          l.bokehSet,
          0.45 + (i % 3) * 0.16,
          0.1 * twinkle * (1 - edge / 0.34) * (0.5 + scene.intensity * 0.7) * foreFade,
          bx - r + drift,
          by - r + drift * 0.6,
          r * 2,
          r * 2,
        );
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    }

    // --- lens dirt: only visible when something bright faces the lens --
    const lit = Math.min(settings.lights, lights.length);
    let facing = 0;
    for (let i = 0; i < lit; i++) facing += lights[i].gain;
    facing = clamp01(facing / Math.max(1, lit));
    const dirt = clamp01(0.035 + facing * 0.075 + scene.flash * 0.22) * foreFade;
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = dirt;
    context.drawImage(bakery.get("lens-dirt"), 0, 0, w, h);
    if (quality === "ultra") {
      context.globalAlpha = clamp01(dirt * 0.16);
      context.drawImage(bakery.get("lens-scratches"), 0, 0, w, h);
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";

    context.restore();
  }

  /* ================================================================ *
   * Standby card
   * ================================================================ */

  /**
   * The broadcast standby the show sits behind while the set is built.
   *
   * Colour bars, because that is what a plant with no source to air puts up —
   * but bars obeying this show's palette: a luminance staircase in warm
   * neutrals with exactly one saturated bar, hemi orange, where a real card
   * would put its most saturated primary. Under them a slate with the ident, a
   * running timecode that ticks like hardware, and a signal bar wired to the
   * actual construction progress, so the one piece of feedback on screen is
   * telling the truth.
   *
   * It leaves as a switcher take: two barn doors part from the centre line and
   * carry the card off the top and bottom of frame, with a bone edge on each
   * door. Nothing strobes, so the reduced-motion path only has to slow the sync
   * sweep — the composition is identical either way.
   */
  function drawStandby(context: CanvasRenderingContext2D, scene: SceneContext): void {
    if (standby <= 0.001) return;
    const { w, h } = geo;
    const take = smootherstep(0, 1, clamp01(1 - standby));
    const mid = h * 0.5;

    context.save();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;

    // Top door.
    context.save();
    context.beginPath();
    context.rect(-w, -h, w * 3, mid * (1 - take) + h);
    context.clip();
    context.translate(0, -mid * take);
    paintStandbyCard(context, scene);
    context.restore();

    // Bottom door.
    context.save();
    context.beginPath();
    context.rect(-w, mid + (h - mid) * take, w * 3, h * 2);
    context.clip();
    context.translate(0, (h - mid) * take);
    paintStandbyCard(context, scene);
    context.restore();

    // The doors' lit edges. They only exist while the take is running.
    if (take > 0.001 && take < 0.999) {
      const edge = clamp01(Math.sin(take * Math.PI) * 1.4);
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = edge * 0.85;
      context.fillStyle = BONE;
      context.fillRect(0, mid * (1 - take) - 1.4, w, 1.4);
      context.fillRect(0, mid + (h - mid) * take, w, 1.4);
      context.globalAlpha = edge * 0.3;
      context.fillStyle = HEMI;
      context.fillRect(0, mid * (1 - take) - 4, w, 4);
      context.fillRect(0, mid + (h - mid) * take, w, 4);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    }
    context.restore();
  }

  /** The card itself, drawn full-frame at the current origin. */
  function paintStandbyCard(context: CanvasRenderingContext2D, scene: SceneContext): void {
    const { w, h } = geo;
    const t = rawTime;

    // --- field -------------------------------------------------------
    context.fillStyle = "#070605";
    context.fillRect(0, 0, w, h);

    // --- bars --------------------------------------------------------
    // A luminance staircase, not a hue wheel: this show has one saturated hue
    // and the card is not an excuse to break that.
    const barTop = h * 0.06;
    const barH = h * 0.5;
    const bars = ["#f4ede6", "#d2cbc3", "#aca59d", "#877f78", "#615a55", "#3d3835", HEMI, "#161211"];
    const bw = w / bars.length;
    for (let i = 0; i < bars.length; i++) {
      context.fillStyle = bars[i];
      context.fillRect(i * bw, barTop, bw + 0.5, barH);
    }
    // Every bar picks up the same soft top-down falloff, so the card reads as a
    // lit card on a lens rather than eight flat rectangles.
    const barGrade = context.createLinearGradient(0, barTop, 0, barTop + barH);
    barGrade.addColorStop(0, "rgba(255,255,255,0.07)");
    barGrade.addColorStop(0.5, "rgba(0,0,0,0)");
    barGrade.addColorStop(1, "rgba(0,0,0,0.2)");
    context.fillStyle = barGrade;
    context.fillRect(0, barTop, w, barH);

    // --- castellation strip -----------------------------------------
    const castTop = barTop + barH;
    const castH = h * 0.05;
    for (let i = 0; i < bars.length; i++) {
      context.fillStyle = bars[bars.length - 1 - i];
      context.fillRect(i * bw, castTop, bw + 0.5, castH);
    }
    context.fillStyle = "rgba(0,0,0,0.3)";
    context.fillRect(0, castTop, w, castH);

    // --- PLUGE + reference patches ----------------------------------
    const plugeTop = castTop + castH;
    const plugeH = h * 0.062;
    context.fillStyle = "#0d0b0a";
    context.fillRect(0, plugeTop, w, plugeH);
    const pluge = ["#000000", "#141110", "#232020", "#000000"];
    for (let i = 0; i < pluge.length; i++) {
      context.fillStyle = pluge[i];
      context.fillRect(w * 0.04 + i * bw * 0.42, plugeTop, bw * 0.42, plugeH);
    }
    context.fillStyle = "#f4ede6";
    context.fillRect(w - bw * 1.1, plugeTop, bw * 0.7, plugeH);
    context.fillStyle = HEMI;
    context.fillRect(w - bw * 2.1, plugeTop, bw * 0.7, plugeH);

    // --- lower field -------------------------------------------------
    const slateTop = plugeTop + plugeH;
    context.fillStyle = "#080706";
    context.fillRect(0, slateTop, w, h - slateTop);
    // Hairline above the slate, so the card has a drawn edge rather than a
    // gradient that fades into whatever is behind it.
    context.fillStyle = withAlpha(ALUMINIUM, 0.4);
    context.fillRect(0, slateTop, w, Math.max(1, h * 0.0016));

    // --- registration geometry --------------------------------------
    context.strokeStyle = withAlpha(BONE, 0.22);
    context.lineWidth = 1;
    const inset = w * 0.022;
    const armX = w * 0.03;
    const armY = h * 0.045;
    for (let i = 0; i < 4; i++) {
      const cx = i % 2 === 0 ? inset : w - inset;
      const cy = i < 2 ? inset * 0.9 : h - inset * 0.9;
      const sx = i % 2 === 0 ? 1 : -1;
      const sy = i < 2 ? 1 : -1;
      context.beginPath();
      context.moveTo(cx, cy + sy * armY);
      context.lineTo(cx, cy);
      context.lineTo(cx + sx * armX, cy);
      context.stroke();
    }
    // Centre circle: the geometry check every test card carries.
    context.strokeStyle = withAlpha(BONE, 0.14);
    context.beginPath();
    context.arc(w * 0.5, barTop + barH * 0.5, Math.min(w, h) * 0.31, 0, TAU);
    context.stroke();
    context.beginPath();
    context.moveTo(w * 0.5, barTop);
    context.lineTo(w * 0.5, barTop + barH);
    context.moveTo(w * 0.5 - Math.min(w, h) * 0.31, barTop + barH * 0.5);
    context.lineTo(w * 0.5 + Math.min(w, h) * 0.31, barTop + barH * 0.5);
    context.stroke();

    // --- sync sweep --------------------------------------------------
    // One slow bright band travelling down the card. 0.16 Hz — nowhere near a
    // flash rate, and slower still when motion is reduced.
    const sweepRate = reduced ? 0.06 : 0.16;
    const sweepY = ((t * sweepRate) % 1) * (h + 160) - 80;
    const sweep = context.createLinearGradient(0, sweepY - 70, 0, sweepY + 70);
    sweep.addColorStop(0, "rgba(255,255,255,0)");
    sweep.addColorStop(0.5, withAlpha(BONE, reduced ? 0.03 : 0.055));
    sweep.addColorStop(1, "rgba(255,255,255,0)");
    context.globalCompositeOperation = "lighter";
    context.fillStyle = sweep;
    context.fillRect(0, sweepY - 70, w, 140);
    context.globalCompositeOperation = "source-over";

    // --- slate -------------------------------------------------------
    const sy0 = slateTop + (h - slateTop) * 0.42;
    context.textBaseline = "middle";
    context.textAlign = "left";
    const left = w * 0.075;

    context.fillStyle = withAlpha(BONE, 0.62);
    context.font = font(700, h * 0.018);
    fillTracked(context, textCache, "MWM STUDIOS · STAGE 4 · TX FEED", left, sy0 - h * 0.062, 3.4, "left");

    context.fillStyle = BONE;
    context.font = font(800, h * 0.048);
    fillTracked(context, textCache, "PROOF OF PATIENCE", left, sy0 - h * 0.018, 2.2, "left");

    // Standby lamp: a slow 1 Hz breath, well under any flash threshold.
    const pulse = reduced ? 0.72 : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * TAU));
    context.fillStyle = withAlpha(HEMI, 0.35 + pulse * 0.55);
    const dotR = h * 0.0088;
    context.beginPath();
    context.arc(left + dotR, sy0 + h * 0.032, dotR, 0, TAU);
    context.fill();
    context.fillStyle = withAlpha(BONE, 0.86);
    context.font = font(800, h * 0.021);
    fillTracked(context, textCache, "STANDBY", left + dotR * 3.4, sy0 + h * 0.033, 5.2, "left");

    // --- signal bar --------------------------------------------------
    const barX = w * 0.46;
    const barW = w * 0.465;
    const barY = sy0 + h * 0.027;
    const barHt = h * 0.011;
    context.fillStyle = withAlpha(BONE, 0.13);
    context.fillRect(barX, barY, barW, barHt);
    const prog = clamp01(buildProgress() * 0.94 + (bootComplete ? 0.06 : 0));
    context.fillStyle = HEMI;
    context.fillRect(barX, barY, barW * prog, barHt);
    context.fillStyle = withAlpha("#ffd2b4", 0.9);
    context.fillRect(barX, barY, barW * prog, barHt * 0.34);
    context.fillStyle = withAlpha(BONE, 0.4);
    context.font = font(700, h * 0.0155);
    fillTracked(
      context,
      textCache,
      bootComplete ? "SIGNAL LOCKED · 1000x620 · REC.709" : "SIGNAL ACQUIRING · BUILDING SET",
      barX,
      barY - h * 0.028,
      2.6,
      "left",
    );

    // --- timecode ----------------------------------------------------
    // Counts real frames at 30 fps, zero-padded, monospaced by construction —
    // the numerals tick the way a hardware counter does.
    const frames = Math.floor(t * 30);
    const tc = `${pad2(Math.floor(frames / 108000) % 24)}:${pad2(Math.floor(frames / 1800) % 60)}:${pad2(
      Math.floor(frames / 30) % 60,
    )}:${pad2(frames % 30)}`;
    context.fillStyle = withAlpha(BONE, 0.72);
    context.font = font(700, h * 0.026);
    context.textAlign = "right";
    fillTracked(context, textCache, tc, w - left, sy0 - h * 0.045, 2.8, "right");
    context.textAlign = "left";

    // Quality/tier readout, bottom right — the kind of line an engineer leaves
    // on a slate so the truck knows what it is looking at.
    context.fillStyle = withAlpha(ALUMINIUM, 0.55);
    context.font = font(700, h * 0.0145);
    fillTracked(
      context,
      textCache,
      `${scene.quality.toUpperCase()} · ${scene.reducedMotion ? "REDUCED MOTION" : "FULL MOTION"}`,
      w - left,
      h - h * 0.045,
      2.4,
      "right",
    );

    // --- lens ---------------------------------------------------------
    // The card is on the same lens as the show: it gets the same corner falloff.
    const vig = context.createRadialGradient(w * 0.5, h * 0.46, Math.min(w, h) * 0.34, w * 0.5, h * 0.5, w * 0.76);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.44)");
    context.fillStyle = vig;
    context.fillRect(0, 0, w, h);
  }

  function onImpact(x: number, y: number, force: number): void {
    const f = clamp01(Number.isFinite(force) ? force : 0.5);
    const px = Number.isFinite(x) ? x : geo.w * 0.5;
    const py = Number.isFinite(y) ? y : geo.stageY;

    // Record the scuff.
    const mark = impacts[impactCursor];
    impactCursor = (impactCursor + 1) % IMPACT_SLOTS;
    mark.x = px;
    mark.y = py;
    mark.force = 0.35 + f * 0.65;
    mark.age = 0;
    mark.live = true;
    floorHeat = clamp01(floorHeat + f * 0.6);

    // Dust kicked off the deck: two low, wide fans plus a slow puff.
    const dustScale = reduced ? 0.3 : 1;
    const dustColour = rampAt(hazeRamp, 0.3 + f * 0.35);
    for (const dir of [0, Math.PI]) {
      particles.emit("dust-kick", {
        x: px,
        y: geo.stageY - 2,
        angle: dir - 0.16,
        spread: 0.7,
        count: Math.max(1, Math.round(9 * (0.5 + f) * dustScale)),
        speed: lerp(90, 210, f),
        scale: lerp(0.8, 1.5, f),
        color: dustColour,
        behind: true,
      });
    }
    particles.emit("smoke-puff", {
      x: px,
      y: geo.stageY - 6,
      count: Math.max(1, Math.round(4 * (0.4 + f) * dustScale)),
      speed: lerp(30, 76, f),
      scale: lerp(0.7, 1.3, f),
      color: dustColour,
      behind: true,
    });

    // The nearest fixture takes the knock. Impulse falls off with distance so a
    // hit at the far edge of the stage does not rattle the whole grid.
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < lamps.length; i++) {
      const d = Math.abs(lamps[i].x - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && !reduced) {
      const falloff = 1 / (1 + Math.pow(bestD / (geo.w * 0.22), 2));
      lamps[best].swing.impulse((px < lamps[best].x ? -1 : 1) * f * falloff * 1.35);
      // Neighbours get a fraction of it, so the grid reads as one structure.
      for (const n of [best - 1, best + 1]) {
        if (n < 0 || n >= lamps.length) continue;
        const d = Math.abs(lamps[n].x - px);
        const fo = 1 / (1 + Math.pow(d / (geo.w * 0.22), 2));
        lamps[n].swing.impulse((px < lamps[n].x ? -1 : 1) * f * fo * 0.45);
      }
    }

    // The video wall drops frames on a heavy landing.
    if (!reduced) {
      ledGlitch = clamp01(Math.max(ledGlitch, 0.35 + f * 0.65));
      ledGlitchSeed = (ledGlitchSeed + 7.31) % 1000;
    }
  }

  return {
    resize,
    update,
    drawBackground,
    drawForeground,
    onImpact,
    bootStep,
    drawStandby,
    get bootProgress(): number {
      return bootComplete ? 1 : buildProgress();
    },
    get onAir(): boolean {
      return standby <= 0.001;
    },
  };
}
