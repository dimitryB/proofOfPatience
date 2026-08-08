/**
 * POP — WebGL2 post-processing chain.
 *
 * The 2D layer draws a broadcast studio; this file is the lens and the sensor
 * that photograph it. Everything that makes a frame read as *film* rather than
 * *canvas* happens here: a real bloom pyramid, lateral chromatic aberration,
 * barrel distortion, a filmic tonemapper, a grade, natural vignetting, grain
 * and broadcast line structure.
 *
 * Pipeline (all offscreen work in a half/float linear space):
 *
 *   2D canvas ──texImage2D──▶ [ingest]   sRGB→linear + highlight expansion
 *                                │
 *                                ├──────────────────────────────┐
 *                                ▼                              │
 *                          [prefilter]  soft-knee threshold     │
 *                          13-tap Karis downsample → mip0       │
 *                                ▼                              │
 *                          [downsample ×N]  13-tap dual filter  │
 *                                ▼                              │
 *                          [upsample ×N]    9-tap tent, ADD     │
 *                                ▼                              │
 *                             bloom (mip0) ──────────┐          │
 *                                                    ▼          ▼
 *                                                 [composite] ──▶ canvas
 *
 * Colour management: the source canvas is sRGB-encoded. It is decoded to linear
 * light on ingest, every physical operation (bloom, flash, vignette, white
 * balance, contrast) happens in linear, a filmic curve maps linear → display,
 * and only then is the result re-encoded to sRGB. Grain, scanlines and dither
 * are display artefacts and are applied after the encode, which is where they
 * physically belong.
 *
 * Hard rules honoured (see docs/ENGINE_ARCHITECTURE.md):
 *  - no npm dependencies, no Node built-ins — the module imports cleanly in a
 *    Cloudflare Worker because every DOM touch is lazy and guarded;
 *  - no `Math.random`: the only stochastic content is hashed in GLSL from a
 *    seed that can be supplied by the injected `Rng`, so frames are
 *    reproducible for screenshot diffing;
 *  - nothing allocates per frame: one VAO, one program per variant, uniform
 *    locations cached at link time, scalar uniform setters only;
 *  - `available === false` and a silent no-op whenever WebGL2 or float render
 *    targets are missing, or the context is lost. This never throws.
 */

import type { PostChain, PostParams, QualityTier, Rng } from "../render/types";

/* ------------------------------------------------------------------ *
 * Flash shape — the ultimate needs a place, not just an amount
 * ------------------------------------------------------------------ */

/**
 * `PostParams.flashAmount` is a scalar, and a scalar can only raise the whole
 * frame at once. A detonation has an **origin**, a **front** travelling out
 * from it and a **falloff** behind the front; without those, POP OFF is a
 * uniform white-out with no direction and no scale.
 *
 * These fields extend the frozen contract rather than changing it: a caller
 * that only knows `PostParams` gets the old uniform behaviour (the defaults
 * below reproduce it exactly), and a caller that knows this extension can
 * detonate from a point. The shape is public so the effects layer can place its
 * wordmark, ring and debris against the *same* numbers instead of guessing —
 * nothing here reaches into any render module.
 */
export interface FlashShape {
  /** Detonation origin in normalised frame coordinates, y down (0,0 = top left). */
  flashCenterX: number;
  flashCenterY: number;
  /**
   * Radius the leading edge has reached, in half-frame-heights. The frame's
   * far corner sits at roughly `0.5 * hypot(aspect, 1)` — about 0.95 at 16:10 —
   * so a radius above ~1.2 has swept the whole picture.
   */
  flashRadius: number;
  /** Thickness of the bright shell, as a fraction of the radius. */
  flashFront: number;
  /** 0 = pure radial detonation, 1 = the flat full-frame flash. */
  flashUniform: number;
}

/**
 * The chroma curve `saturation` alone cannot describe.
 *
 * `saturation` is a single multiplier on every pixel's distance from the
 * achromatic axis, which forces one choice for the whole frame: hold the set
 * neutral and lose the brand, or show the brand and tint the set. These two
 * numbers split that decision by chroma. Everything below the knee is a lit
 * surface and keeps `saturation`; everything well above it is a source and gets
 * `saturation * chromaGain`.
 */
export interface GradeShape {
  /** Chroma multiplier applied on top of `saturation` to saturated pixels. */
  chromaGain: number;
  /**
   * Relative chroma (|c| / luma, linear light) at which `chromaGain` starts to
   * come in; it is fully applied at three times this value. A warm grey under a
   * tungsten key measures about 0.3–0.5 here, a hemi orange source 2.0 and up.
   */
  chromaKnee: number;
}

/** `PostParams` plus the optional flash and grade shapes. Structurally a `PostParams`. */
export type PopPostParams = PostParams & Partial<FlashShape> & Partial<GradeShape>;

/** Neutral: a caller that sets nothing gets a plain global `saturation`. */
export const DEFAULT_GRADE_SHAPE: GradeShape = {
  chromaGain: 1,
  chromaKnee: 0.55,
};

/**
 * The shape a caller gets when it sets nothing: centred, swept out past the
 * corners, fully uniform — i.e. byte-identical to the pre-shape behaviour.
 */
export const DEFAULT_FLASH_SHAPE: FlashShape = {
  flashCenterX: 0.5,
  flashCenterY: 0.5,
  flashRadius: 1.4,
  flashFront: 0.34,
  flashUniform: 1,
};

/**
 * The flash's spatial weight at a point, matching the composite shader exactly.
 *
 * Exported so the 2D fallback, and any module that wants to place something
 * against the blast, can evaluate the same curve the GPU does instead of
 * approximating it. `distance` is in half-frame-heights from the origin.
 */
export function flashFalloff(distance: number, shape: Partial<FlashShape>): number {
  const radius = Math.max(1e-3, shape.flashRadius ?? DEFAULT_FLASH_SHAPE.flashRadius);
  const uniform = clamp(shape.flashUniform ?? DEFAULT_FLASH_SHAPE.flashUniform, 0, 1);
  const thick = Math.max(0.02, shape.flashFront ?? DEFAULT_FLASH_SHAPE.flashFront) * radius;
  const n = Math.max(0, distance) / radius;
  // Behind the front: a softened inverse square, so the core stays hot and the
  // wash dies off with distance instead of filling the frame flat.
  const body = 1 / (1 + n * n * 2.4);
  // On the front: a bright shell riding the leading edge.
  const q = (distance - radius) / thick;
  const shell = Math.exp(-q * q);
  const shaped = Math.min(3, body + shell * 1.35);
  return shaped + (1 - shaped) * uniform;
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export interface PostChainOptions {
  /**
   * Present into an existing canvas instead of creating one. When the chain
   * creates its own canvas it also maintains the inline CSS size; when the
   * caller supplies one, layout is left entirely alone.
   */
  canvas?: HTMLCanvasElement;
  quality?: QualityTier;
  /**
   * Overrides the `prefers-reduced-motion` media query. When motion is reduced
   * the composition is identical — the same bloom, grade, vignette and line
   * structure — but nothing animates: grain freezes, the interlace shimmer and
   * hum bar stop, glitch is disabled and full-frame flashes are attenuated.
   */
  reducedMotion?: boolean;
  /** Deterministic seed source for grain, dither and glitch hashes. */
  rng?: Rng;
  /** Explicit seed; wins over `rng`. */
  seed?: number;
  /** Keep the drawing buffer readable after present (screenshot diffing). */
  preserveDrawingBuffer?: boolean;
  /** Hard ceiling on device pixel ratio, on top of the per-tier ceiling. */
  maxDpr?: number;
}

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

/**
 * The house look: a warm, slightly under-exposed late-night studio on a fast
 * cine prime. Bloom threshold sits *above* the LDR white point on purpose —
 * only pixels the ingest pass promotes into HDR (near-white, or a fully
 * saturated hemi orange) are treated as genuine light sources.
 */
export function defaultPostParams(): PopPostParams {
  return {
    bloomStrength: 0.56,
    // Above the LDR white point on purpose, and further above it than it was:
    // once the video wall is allowed to be a real source, a threshold this
    // close to white lets a mid-bright orange panel bloom, and bloom lands on
    // every pixel in frame. Measured on the audience — which is nowhere near a
    // light — the wall's halo was worth three points of red-over-blue on its
    // own. Only what the ingest pass promotes into genuine HDR blooms now.
    bloomThreshold: 1.08,
    bloomRadius: 1.15,
    // Separation at the frame *corner*, in CSS pixels. The profile below is
    // r^3-weighted and gated off across the middle of frame, so this number is
    // only ever spent where a real lens spends it.
    chroma: 1.05,
    vignette: 0.47,
    grain: 0.05,
    scanline: 0.15,
    barrel: 0.05,
    exposure: 1.04,
    contrast: 1.08,
    // Below 1: the set is authored warm and the grade's job is to hold the
    // *neutrals*, not to push them further. What it must not do is take the
    // brand down with them, which is what `chromaGain` is for.
    saturation: 0.6,
    // A tungsten white balance. The set is lit by 3000 K lamps and shot without
    // correction, so the room's white point is warm — that is a hue shift, and
    // it costs almost no chroma. Pulling this to near zero is what left the set
    // reading as cool grey; pushing it with `saturation` above 1 is what made it
    // an orange wash. The two controls do different jobs.
    temperature: 0.09,
    chromaGain: 3.8,
    chromaKnee: 0.55,
    flashAmount: 0,
    flashColor: [1, 0.62, 0.4],
    glitch: 0,
    radialBlur: 0,
    ...DEFAULT_FLASH_SHAPE,
  };
}

/* ------------------------------------------------------------------ *
 * Quality tiers
 * ------------------------------------------------------------------ */

interface TierSettings {
  /** Bloom pyramid levels, counting the half-res prefilter output as level 0. */
  levels: number;
  /** Radial blur taps; 0 compiles the feature out entirely. */
  radialTaps: number;
  /** 3 = plain RGB split, 5 = spectral recombination. */
  chromaTaps: number;
  /** Karis (inverse-luma) averaging in the prefilter kills bloom fireflies. */
  karis: boolean;
  /** Fetch bloom per channel so halos get their own fringing. */
  bloomChroma: boolean;
  /** Multiplier on the grain amount. */
  grain: number;
  /** Device-pixel-ratio ceiling. */
  maxDpr: number;
  /** Absolute device-pixel budget; protects integrated GPUs on 4K panels. */
  pixelBudget: number;
}

const TIERS: Record<QualityTier, TierSettings> = {
  low: {
    levels: 4,
    radialTaps: 0,
    chromaTaps: 3,
    karis: false,
    bloomChroma: false,
    grain: 0.7,
    maxDpr: 1,
    pixelBudget: 1.4e6,
  },
  medium: {
    levels: 5,
    radialTaps: 6,
    chromaTaps: 3,
    karis: true,
    bloomChroma: false,
    grain: 0.9,
    maxDpr: 1.5,
    pixelBudget: 2.2e6,
  },
  high: {
    levels: 6,
    radialTaps: 10,
    chromaTaps: 5,
    karis: true,
    bloomChroma: true,
    grain: 1,
    maxDpr: 2,
    pixelBudget: 3.2e6,
  },
  ultra: {
    levels: 7,
    radialTaps: 14,
    chromaTaps: 5,
    karis: true,
    bloomChroma: true,
    grain: 1,
    maxDpr: 2,
    pixelBudget: 4.8e6,
  },
};

/**
 * Highlight reconstruction. The source is an 8-bit LDR canvas, so nothing in it
 * exceeds 1.0 — feed that straight to a filmic curve and white comes out grey
 * and nothing ever blooms. These constants push the *top* of the range back
 * into HDR: below EXPAND_START the image is bit-for-bit untouched, and a fully
 * bright channel is promoted to EXPAND_MAX so the tonemapper's shoulder lands
 * white on white and highlights have something to bloom with. Driven by the max
 * channel rather than luma, so a saturated #ff4600 counts as emissive — which
 * in this art direction it always is.
 */
const EXPAND_START = 0.82;
const EXPAND_MAX = 4.5;

/** Scanline pitch in CSS pixels. 2.4 gives ~258 lines over a 620px frame. */
const SCAN_PITCH_CSS = 2.4;
/** Grain cell size in CSS pixels — keeps grain the same size on HiDPI. */
const GRAIN_CELL_CSS = 1.25;
/** Film grain refreshes at the film rate, not the display rate. */
const GRAIN_HZ = 24;
/** Linear-light gain applied to `flashAmount` before the tonemapper. */
const FLASH_GAIN = 4;

/* ------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------ */

/**
 * Attribute-less fullscreen triangle. Vertex 0 → (0,0), 1 → (2,0), 2 → (0,2) in
 * UV space, which covers clip space [-1,3]²; the hardware clips the excess. One
 * triangle instead of two avoids the diagonal seam where quad-based fullscreen
 * passes double-shade a strip of quads.
 */
const VERT_SRC = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG_INGEST = `precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform float uExpandStart;
uniform float uExpandMax;

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c * (1.0 / 12.92);
  vec3 hi = pow(max(c + 0.055, vec3(0.0)) * (1.0 / 1.055), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

void main() {
  // The 2D canvas has its origin top-left, GL renders bottom-up. Flipping once
  // here keeps every downstream pass in GL orientation and lets the composite
  // present straight to the default framebuffer.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 c = srgbToLinear(texture(uSrc, uv).rgb);

  // Highlight reconstruction — see EXPAND_START in the TS source. The trigger
  // is the mean of luminance and peak channel: pure luminance would never
  // promote a saturated light source, pure peak would promote every flat
  // saturated graphic, and this game paints a lot of flat hemi orange that must
  // stay hemi orange. Halfway between, only near-white survives the threshold.
  float b = 0.5 * (dot(c, vec3(0.2126, 0.7152, 0.0722)) + max(c.r, max(c.g, c.b)));
  float t = smoothstep(uExpandStart, 1.0, b);
  fragColor = vec4(c * (1.0 + t * t * (uExpandMax - 1.0)), 1.0);
}`;

/**
 * 13-tap "dual filter" downsample from Jorge Jimenez's Call of Duty: Advanced
 * Warfare talk. Four overlapping 2×2 boxes on the outer ring plus one centred
 * box: with bilinear filtering this samples an effective 6×6 footprint for 13
 * fetches and — crucially — is stable under repeated application, so the
 * pyramid does not shimmer when the camera moves a subpixel.
 *
 * Offsets are in *source* texels, so a ±2 offset is ±1 destination texel.
 */
const CHUNK_TAPS13 = `
  vec2 tx = uTexel;
  vec3 a = texture(uSrc, vUv + tx * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uSrc, vUv + tx * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uSrc, vUv + tx * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uSrc, vUv + tx * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uSrc, vUv                        ).rgb;
  vec3 f = texture(uSrc, vUv + tx * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uSrc, vUv + tx * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSrc, vUv + tx * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture(uSrc, vUv + tx * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture(uSrc, vUv + tx * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture(uSrc, vUv + tx * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture(uSrc, vUv + tx * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSrc, vUv + tx * vec2( 1.0, -1.0)).rgb;
`;

const FRAG_PREFILTER = `precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1 / source size
uniform vec4 uCurve;   // x threshold, y threshold-knee, z 2*knee, w 0.25/knee
uniform float uExposure;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

#if KARIS
// Weight each box by inverse luma before averaging: one blown pixel then
// contributes its share of *area* rather than its share of *energy*, which is
// what stops a single specular hit from flickering as a firefly in the pyramid.
float kw(vec3 c) { return 1.0 / (1.0 + dot(c, LUMA)); }
vec3 kavg(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = kw(a), wb = kw(b), wc = kw(c), wd = kw(d);
  return (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-4);
}
#endif

void main() {
${CHUNK_TAPS13}
#if KARIS
  vec3 sum = kavg(j, k, l, m) * 0.5
           + kavg(a, b, d, e) * 0.125
           + kavg(b, c, e, f) * 0.125
           + kavg(d, e, g, h) * 0.125
           + kavg(e, f, h, i) * 0.125;
#else
  vec3 sum = e * 0.125
           + (a + c + g + i) * 0.03125
           + (b + d + f + h) * 0.0625
           + (j + k + l + m) * 0.125;
#endif

  sum *= uExposure;

  // Soft-knee threshold: a quadratic ramp through the knee, linear above it, so
  // a highlight fades into the bloom instead of switching on at one grey level.
  float br = max(sum.r, max(sum.g, sum.b));
  float rq = clamp(br - uCurve.y, 0.0, uCurve.z);
  rq = uCurve.w * rq * rq;
  fragColor = vec4(sum * (max(rq, br - uCurve.x) / max(br, 1e-5)), 1.0);
}`;

const FRAG_DOWNSAMPLE = `precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
${CHUNK_TAPS13}
  vec3 sum = e * 0.125
           + (a + c + g + i) * 0.03125
           + (b + d + f + h) * 0.0625
           + (j + k + l + m) * 0.125;
  fragColor = vec4(sum, 1.0);
}`;

/**
 * 9-tap tent (3×3 kernel [1 2 1; 2 4 2; 1 2 1] / 16) applied while walking back
 * up the pyramid, accumulated with ONE/ONE blending. Adding a tent-filtered
 * coarse level onto each finer level is what produces the wide, smooth,
 * scale-invariant falloff of real lens bloom; a single gaussian at one scale
 * always reads as a cheap halo with a visible edge.
 */
const FRAG_UPSAMPLE = `precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1 / source (coarser) mip size
uniform float uRadius;

void main() {
  vec4 d = uTexel.xyxy * vec4(1.0, 1.0, -1.0, 0.0) * uRadius;
  vec3 s = texture(uSrc, vUv - d.xy).rgb;
  s += texture(uSrc, vUv - d.wy).rgb * 2.0;
  s += texture(uSrc, vUv - d.zy).rgb;
  s += texture(uSrc, vUv + d.zw).rgb * 2.0;
  s += texture(uSrc, vUv       ).rgb * 4.0;
  s += texture(uSrc, vUv + d.xw).rgb * 2.0;
  s += texture(uSrc, vUv + d.zy).rgb;
  s += texture(uSrc, vUv + d.wy).rgb * 2.0;
  s += texture(uSrc, vUv + d.xy).rgb;
  fragColor = vec4(s * (1.0 / 16.0), 1.0);
}`;

const FRAG_COMPOSITE = `precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uResolution;   // device pixels
uniform float uTime;         // wrapped seconds
uniform float uGrainSeed;    // quantised time, or a constant when motion is off
uniform float uSeed;
uniform float uMotion;       // 1 normal, 0 reduced motion

uniform float uBloomStrength;
uniform float uChroma;       // device pixels of separation at the frame corner
uniform float uVignette;
uniform float uGrain;
uniform float uGrainCell;
uniform float uScanline;
uniform float uScanPitch;    // device pixels between lines
uniform float uBarrel;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
uniform float uChromaGain;   // extra chroma for pixels that are already saturated
uniform float uChromaKnee;   // relative chroma at which that extra starts
uniform float uFlashAmount;
uniform vec3  uFlashColor;
uniform vec2  uFlashOrigin;   // normalised frame coords, y down (2D canvas space)
uniform float uFlashRadius;   // front radius, half-heights
uniform float uFlashFront;    // shell thickness as a fraction of the radius
uniform float uFlashUniform;  // 0 radial, 1 flat full-frame
uniform float uGlitch;
uniform float uRadial;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.283185307179586;

/* Dave Hoskins' hash13 — three multiply/fract rounds, no texture, no banding
   at the scales used here. Inputs are kept small (wrapped time, cell indices)
   so mediump-class hardware still decorrelates properly. */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

/* Uchimura's "Gran Turismo" curve: an explicit toe / linear / shoulder
   decomposition, blended with smooth weights.

   Chosen over an ACES RRT+ODT fit after measuring both against this palette.
   ACES is built for a cinema ODT and its toe drops everything below ~0.0033
   linear onto zero — which puts the entire deep-charcoal end of this set
   (#080604 is 0.002 linear) at pure black — while its highlight desaturation
   rotates a saturated hemi orange toward amber. GT holds mid-grey at unity, so
   no exposure fudge is needed, keeps separation down in the charcoal, and being
   per-channel it leaves the one saturated hue in this game where it was.

   P peak white, A mid slope, M linear-section start, L linear-section length,
   C toe curvature (1.0 would be a straight, digital-looking shadow). */
const float GT_P = 1.0;
const float GT_A = 1.0;
const float GT_M = 0.22;
const float GT_L = 0.4;
const float GT_C = 1.2;

vec3 tonemapGT(vec3 x) {
  const float l0 = ((GT_P - GT_M) * GT_L) / GT_A;
  const float S0 = GT_M + l0;
  const float S1 = GT_M + GT_A * l0;
  const float CP = -((GT_A * GT_P) / (GT_P - S1)) / GT_P;

  vec3 w0 = 1.0 - smoothstep(0.0, GT_M, x);
  vec3 w2 = step(S0, x);
  vec3 w1 = 1.0 - w0 - w2;

  // The toe input is clamped to the section it is actually weighted into, so a
  // very large x can never raise pow() to infinity and then meet a zero weight.
  vec3 toe = GT_M * pow(min(max(x, vec3(0.0)), vec3(GT_M)) / GT_M, vec3(GT_C));
  vec3 shoulder = GT_P - (GT_P - S1) * exp(CP * (x - S0));
  vec3 linearPart = GT_M + GT_A * (x - GT_M);
  return clamp(toe * w0 + linearPart * w1 + shoulder * w2, 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  // Squared radius of the frame corner in aspect-corrected, half-height units.
  float maxR2 = 0.25 * (aspect * aspect + 1.0);

  /* ---- analogue glitch: horizontal band displacement ------------------ *
   * Bands are chosen by hashing the row index against a coarse time step, so a
   * band holds its offset for a few frames the way a tape dropout does, rather
   * than boiling per frame. Gated by uMotion: reduced motion removes it. */
  float glitch = uGlitch;
  float bandFlash = 0.0;
  if (glitch > 0.0015) {
    float bands = mix(9.0, 40.0, glitch);
    float row = floor(uv.y * bands);
    float tick = floor(uTime * mix(7.0, 24.0, glitch));
    float pick = hash13(vec3(row, tick, uSeed));
    float live = step(1.0 - glitch * 0.6, pick);
    float amt = hash13(vec3(row * 2.13 + 5.0, tick, uSeed + 3.0)) * 2.0 - 1.0;
    uv.x += live * amt * glitch * 0.055;
    bandFlash = live * hash13(vec3(row * 7.7, tick + 2.0, uSeed));

    // One hard tear sweeping down the frame — the signature of a dropout.
    float tear = fract(uTime * 0.9 + hash13(vec3(tick, uSeed, 1.0)));
    // Note the explicit inversion: smoothstep with edge0 > edge1 is undefined
    // by the spec even though every driver happens to ramp it downward.
    float onTear = 1.0 - smoothstep(0.0, 0.05, abs(vUv.y - tear));
    uv.x += onTear * glitch * 0.09 * (hash13(vec3(tick, 9.0, uSeed)) - 0.5);
    uv.y += onTear * glitch * 0.004;
  }

  /* ---- lens: barrel distortion + lateral chromatic aberration ---------- *
   * Brown-Conrady radial model truncated to two terms. The whole field is then
   * normalised by the corner magnification so the corners map exactly onto the
   * source corners: no clamped smear, at the cost of a slight overall zoom —
   * which is what a real lens/sensor pair does anyway.
   *
   * CA is lateral: the per-channel scale grows with q = (r/rmax)^2 and is then
   * multiplied by the radius itself, so separation grows as r^3 — near zero
   * across the middle of frame, unmistakable in the corners. uChroma is the
   * separation in device pixels at the corner.
   *
   * qc gates the profile off entirely across the inner third of the field.
   * A real lens is corrected on axis; what makes CA read as a defect rather
   * than as glass is fringing on high-contrast UI-scale edges near the middle
   * of frame, and r^3 alone still leaves a fraction of a pixel there. Below
   * q = 0.1 (about a third of the way to the corner) the three channels sample
   * exactly the same texel, and full separation is only reached out past
   * q = 0.62 where nothing but the set lives. */
  vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
  float r2 = dot(c, c);
  float q = clamp(r2 / maxR2, 0.0, 1.0);
  float qc = q * smoothstep(0.10, 0.62, q);

  float k = uBarrel * 0.55;
  float caScale = (uChroma / uResolution.y) / sqrt(max(maxR2, 1e-4)) + glitch * 0.012;
  float norm = 1.0 / ((1.0 + k * maxR2 * 1.35) * (1.0 + caScale));
  float fG = (1.0 + k * r2 * (1.0 + 0.35 * q)) * norm;

  vec2 invAspect = vec2(1.0 / aspect, 1.0);
  vec2 uvG = c * fG * invAspect + 0.5;

#if CHROMA_TAPS == 5
  // Five samples along the radial line recombined through a coarse spectral
  // response, so the fringe sweeps violet → amber instead of showing three
  // hard-edged copies of the image.
  vec2 s0 = c * (fG * (1.0 - caScale * qc))       * invAspect + 0.5;
  vec2 s1 = c * (fG * (1.0 - caScale * qc * 0.5)) * invAspect + 0.5;
  vec2 s3 = c * (fG * (1.0 + caScale * qc * 0.5)) * invAspect + 0.5;
  vec2 s4 = c * (fG * (1.0 + caScale * qc))       * invAspect + 0.5;
  vec3 t0 = texture(uScene, s0).rgb;
  vec3 t1 = texture(uScene, s1).rgb;
  vec3 t2 = texture(uScene, uvG).rgb;
  vec3 t3 = texture(uScene, s3).rgb;
  vec3 t4 = texture(uScene, s4).rgb;
  vec3 scene = vec3(
    t2.r * 0.15 + t3.r * 0.45 + t4.r * 0.40,
    t0.g * 0.08 + t1.g * 0.34 + t2.g * 0.40 + t3.g * 0.15 + t4.g * 0.03,
    t0.b * 0.42 + t1.b * 0.40 + t2.b * 0.15 + t3.b * 0.03);
  vec2 uvR = s4;
  vec2 uvB = s0;
#else
  vec2 uvR = c * (fG * (1.0 + caScale * qc)) * invAspect + 0.5;
  vec2 uvB = c * (fG * (1.0 - caScale * qc)) * invAspect + 0.5;
  vec3 scene = vec3(
    texture(uScene, uvR).r,
    texture(uScene, uvG).g,
    texture(uScene, uvB).b);
#endif

#if RADIAL_TAPS > 0
  /* ---- radial (zoom) blur toward the centre --------------------------- *
   * Streaks converge on the frame centre and the centre itself stays sharp, so
   * the effect reads as speed rather than as an out-of-focus frame. */
  if (uRadial > 0.002) {
    vec2 dir = vec2(0.5) - uvG;
    float amount = uRadial * 0.17 * smoothstep(0.02, 0.55, q);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < RADIAL_TAPS; i++) {
      float t = float(i) / float(RADIAL_TAPS - 1);
      float w = 1.0 - 0.55 * t;
      acc += texture(uScene, uvG + dir * (t * amount)).rgb * w;
      wsum += w;
    }
    scene = mix(scene, acc / wsum, clamp(uRadial * 1.25, 0.0, 0.92));
  }
#endif

  /* ---- bloom --------------------------------------------------------- */
#if BLOOM_CHROMA
  vec3 bloom = vec3(
    texture(uBloom, uvR).r,
    texture(uBloom, uvG).g,
    texture(uBloom, uvB).b);
#else
  vec3 bloom = texture(uBloom, uvG).rgb;
#endif

  // Bloom is generated from the already-exposed scene, so it is not scaled by
  // exposure a second time. The tint is the faint warmth of coated glass.
  vec3 color = scene * uExposure;
  // Coated glass is faintly warm, but the tint has to stay faint: bloom lands
  // on *every* pixel in frame, so a warm halo is the one place where a small
  // number turns into chroma across the whole set. Measured: taking this from
  // (1.03, 0.98, 0.92) to (1.04, 0.978, 0.905) moved the audience — which is
  // nowhere near a light source — by four points of red-over-blue.
  color += bloom * (uBloomStrength * vec3(1.03, 0.98, 0.92));

  /* ---- flash: an origin, a travelling front and a falloff ------------- *
   * Lands in linear light before the tonemapper, so a big one blows out
   * through the shoulder like a real light instead of clipping flat.
   *
   * The shape is what makes it an *event*: energy is deposited around an
   * origin, a bright shell rides the leading edge outward, and everything the
   * shell has already passed falls off as a softened inverse square. Setting
   * uFlashUniform to 1 collapses this back to the flat full-frame flash, which
   * is what a small confirmation beat wants. See FlashShape in the TS source —
   * flashFalloff() there evaluates this identical curve on the CPU. */
  if (uFlashAmount > 0.0005) {
    // The origin arrives in 2D-canvas coordinates (y down); this pass runs in
    // GL orientation, so flip it once here rather than at every call site.
    vec2 fo = vec2(uFlashOrigin.x, 1.0 - uFlashOrigin.y);
    float fd = length((uv - fo) * vec2(aspect, 1.0));
    float fr = max(uFlashRadius, 1e-3);
    float fn = fd / fr;
    float body = 1.0 / (1.0 + fn * fn * 2.4);
    float ft = max(uFlashFront, 0.02) * fr;
    float fq = (fd - fr) / ft;
    float shell = exp(-fq * fq);
    float shaped = min(body + shell * 1.35, 3.0);
    float amt = mix(shaped, 1.0, clamp(uFlashUniform, 0.0, 1.0));
    color += uFlashColor * (uFlashAmount * amt * ${FLASH_GAIN.toFixed(1)});
  }

  /* ---- natural vignette ---------------------------------------------- *
   * cos^4 law: with cos(theta) = 1/sqrt(1 + (r/f)^2) the fourth power is
   * 1/(1 + (r/f)^2)^2, so no trig is needed. f^2 = 1.1 half-heights gives the
   * gentle falloff of a fast prime rather than a painted-on dark ring. */
  float rf = 1.0 + r2 / 1.1;
  float cos4 = 1.0 / (rf * rf);
  color *= mix(1.0, cos4, clamp(uVignette, 0.0, 1.0));
  // Edges of fast glass also lose a little colour, not just light.
  color = mix(color, vec3(dot(color, LUMA)), uVignette * 0.2 * q);

  /* ---- grade (linear) ------------------------------------------------- */
  float temp = clamp(uTemperature, -1.0, 1.0);
  vec3 gain = vec3(1.0 + 0.16 * temp, 1.0 + 0.015 * abs(temp), 1.0 - 0.18 * temp);
  gain /= max(dot(gain, LUMA), 1e-4);   // hold mid-grey luminance
  color *= gain;

  // Split tone: neutral shadows against warm highlights. This is what separates
  // a "warm image" from a graded one — the deep charcoal stays where the black
  // point is and the tungsten shows up where the light actually lands, so the
  // room reads warm without a single flat pixel of orange being added to it.
  float lum = dot(color, LUMA);
  vec3 tone = mix(vec3(0.972, 0.992, 1.05), vec3(1.062, 1.0, 0.928),
                  smoothstep(0.0, 0.55, lum));
  color *= mix(vec3(1.0), tone, 0.35 + 0.45 * max(temp, 0.0));

  // ASC-style power contrast pivoted on 18% grey; in linear this behaves like
  // film density rather than the S-curve-on-sRGB that crushes shadows to mud.
  color = pow(max(color, vec3(1e-5)) * (1.0 / 0.18), vec3(uContrast)) * 0.18;

  /* ---- chroma, weighted by how saturated the pixel already is --------- *
   * A single global saturation number cannot express this look. Below 1 it
   * holds the set neutral but drains the one hue the product is built on;
   * above 1 the brand reads but every warm grey in the room goes orange with
   * it. So chroma is spent as a curve instead of a constant: diffuse surfaces
   * — anything under the knee, which is every lit aluminium, concrete and
   * fabric in the set — are pulled *down*, and genuine sources (the LED wall,
   * the tape, the tally, a card frame) are pushed *up*. The measurable result
   * is a set whose neutrals stay neutral while the accent gets further from
   * them, which is the actual definition of a brand accent.
   *
   * The weight is relative chroma — distance from the achromatic axis over
   * luminance — so it is exposure-invariant: a hemi source reads as a source in
   * the shadows and in the highlights alike. */
  float gl = dot(color, LUMA);
  vec3 chroma = color - vec3(gl);
  float rel = length(chroma) / max(gl, 1e-4);
  float sel = smoothstep(uChromaKnee, uChromaKnee * 2.4, rel);
  color = max(vec3(gl) + chroma * (uSaturation * mix(1.0, uChromaGain, sel)), vec3(0.0));

  /* ---- tonemap -------------------------------------------------------- */
  // Sensor bleach: a per-channel curve alone would let a genuinely blown
  // highlight stay coloured forever. Pulling the very top of the range toward
  // its own peak restores the white-hot core of a real overexposure without
  // touching anything a flat graphic colour can reach.
  /* ---- black point ---------------------------------------------------- *
   * GT's toe holds separation all the way down, which is exactly what the
   * charcoal end of this palette needs — but it also means nothing in the
   * picture ever reaches black. Measured on the delivered frame the darkest
   * 1 % of the stage sat at 10/255 and the image read flat rather than graded.
   * One subtractive offset in linear, an order of magnitude below the toe's
   * knee, gives the frame a defined black without touching the shadow
   * separation the toe exists to protect. */
  color = max(color - vec3(0.0024), vec3(0.0));

  float peak = max(color.r, max(color.g, color.b));
  color = mix(color, vec3(peak), smoothstep(2.0, 8.0, peak) * 0.35);
  color = tonemapGT(color);

  color = linearToSrgb(color);

  /* ---- display artefacts (after the encode, where they belong) -------- */
  if (uScanline > 0.001) {
    // Scanlines are a property of the display, not the lens, so they use the
    // undistorted screen coordinate and never bend with the barrel.
    float lines = uResolution.y / max(uScanPitch, 1.0);
    float s = 0.5 + 0.5 * cos(vUv.y * lines * TAU);
    // Fade the modulation out when a line would be thinner than ~2 device
    // pixels, otherwise it aliases into moiré on high-DPI panels.
    float aa = smoothstep(1.1, 2.4, uScanPitch);
    color *= 1.0 + uScanline * (0.30 * (s * 2.0 - 1.0) - 0.06) * aa;

    // Interlace shimmer: fields alternate at 2.5 Hz (deliberately below the
    // 3 Hz photosensitivity limit) at a fraction of a percent of amplitude.
    float field = step(0.5, fract(vUv.y * lines * 0.5 + floor(uTime * 2.5) * 0.5));
    color *= 1.0 + uScanline * 0.045 * (field - 0.5) * aa * uMotion;

    // Mains hum bar rolling slowly up frame, the way an un-genlocked feed does.
    float bar = (fract(vUv.y * 0.8 - uTime * 0.055) - 0.5) * 5.0;
    color *= 1.0 + uScanline * 0.05 * exp(-bar * bar) * uMotion;
  }

  if (glitch > 0.0015) {
    color += vec3(0.10, 0.085, 0.07) * bandFlash * glitch;
    color = mix(color, vec3(dot(color, LUMA)), bandFlash * glitch * 0.35);
    float st = hash13(vec3(floor(vUv * uResolution * 0.5), floor(uTime * 30.0)));
    color += (st - 0.5) * glitch * 0.12;
  }

  if (uGrain > 0.0005) {
    // Three decorrelated fields, mostly recombined into a monochrome grain:
    // real stock has fine chroma grain over much coarser luma grain.
    vec2 gp = floor(vUv * uResolution / max(uGrainCell, 0.5));
    float n1 = hash13(vec3(gp, uGrainSeed));
    float n2 = hash13(vec3(gp + 19.7, uGrainSeed + 4.1));
    float n3 = hash13(vec3(gp + 47.3, uGrainSeed + 9.3));
    float mono = (n1 + n2 + n3) * (1.0 / 3.0) - 0.5;
    vec3 g = mix(vec3(mono), vec3(n1, n2, n3) - 0.5, 0.3);
    // Emulsion is thin in the shadows, so that is where grain lives.
    float w = mix(1.35, 0.30, smoothstep(0.02, 0.8, dot(color, LUMA)));
    color += g * (uGrain * w);
  }

  // Triangular-PDF dither at one 8-bit step. This set is almost entirely deep
  // charcoal ramps, which band visibly without it. Seeded rather than animated
  // so screenshots stay byte-stable.
  vec2 dp = vUv * uResolution;
  float d1 = hash13(vec3(dp, uSeed));
  float d2 = hash13(vec3(dp + 3.7, uSeed + 1.7));
  color += (d1 + d2 - 1.0) * (1.0 / 255.0);

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Params arrive from gameplay code; one NaN must not black out the frame. */
function safe(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function warn(message: string): void {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`[postfx] ${message}`);
  }
}

interface GlProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
}

interface RenderTarget {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

/** A candidate sized internal format for the HDR working targets. */
interface ColorFormat {
  internal: number;
  name: string;
}

interface SourceSize {
  w: number;
  h: number;
}

/**
 * Dimensions of anything WebGL can upload. Each source type spells its
 * intrinsic size differently, and the layout `width` of an <img> is not it.
 */
function sourceSize(source: TexImageSource): SourceSize | null {
  const s = source as Partial<{
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
    videoWidth: number;
    videoHeight: number;
    displayWidth: number;
    displayHeight: number;
    codedWidth: number;
    codedHeight: number;
  }>;
  const w = s.naturalWidth || s.videoWidth || s.displayWidth || s.codedWidth || s.width || 0;
  const h = s.naturalHeight || s.videoHeight || s.displayHeight || s.codedHeight || s.height || 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

/** SVG images are the one CanvasImageSource WebGL refuses to accept. */
function asTexSource(source: CanvasImageSource): TexImageSource | null {
  if (typeof SVGImageElement !== "undefined" && source instanceof SVGImageElement) return null;
  return source as TexImageSource;
}

function createCanvasElement(): HTMLCanvasElement | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  return document.createElement("canvas");
}

function detectReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Chain
 * ------------------------------------------------------------------ */

export function createPostChain(options: PostChainOptions = {}): PostChain {
  const ownsCanvas = !options.canvas;
  const surface = options.canvas ?? createCanvasElement();

  // Server render, or a DOM without <canvas>: hand back an inert chain rather
  // than throwing. The property is typed non-optional by the contract, so the
  // headless case gets a minimal stand-in that satisfies the shape and is never
  // touched, because `available` is false and every method is a no-op.
  if (!surface) {
    const stub = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    return inertChain(stub, null);
  }
  // Rebound after the guard so nested function declarations see the narrowed
  // type rather than `HTMLCanvasElement | null`.
  const canvas: HTMLCanvasElement = surface;

  let quality: QualityTier = options.quality ?? "high";
  let tier = TIERS[quality];

  const seed =
    options.seed !== undefined
      ? options.seed
      : options.rng
        ? Math.floor(options.rng.next() * 4096)
        : 137;

  /* -- reduced motion ------------------------------------------------- */
  const motionForced = options.reducedMotion;
  let reducedMotion = motionForced ?? detectReducedMotion();
  let motionQuery: MediaQueryList | null = null;
  const onMotionChange = (event: MediaQueryListEvent): void => {
    if (motionForced === undefined) reducedMotion = event.matches;
  };
  if (motionForced === undefined && typeof window !== "undefined" && window.matchMedia) {
    try {
      motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      motionQuery.addEventListener("change", onMotionChange);
    } catch {
      motionQuery = null;
    }
  }

  /* -- context -------------------------------------------------------- */
  let gl: WebGL2RenderingContext | null = null;
  try {
    const context = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: options.preserveDrawingBuffer === true,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: false,
    });
    // Duck-typed rather than `instanceof WebGL2RenderingContext`: capture and
    // debugging tools hand back a proxy that fails the identity check while
    // being a perfectly good WebGL2 context. These two methods are WebGL2-only.
    gl =
      context &&
      typeof context.texStorage2D === "function" &&
      typeof context.createVertexArray === "function"
        ? context
        : null;
  } catch {
    gl = null;
  }

  if (!gl) {
    warn("WebGL2 unavailable; falling back to a direct blit.");
    return inertChain(canvas, ownsCanvas ? canvas : null);
  }

  const context = gl;

  /* -- render target format ------------------------------------------- */
  // Half-float is what makes the chain work: bloom needs to carry values well
  // above 1.0, and an 8-bit pyramid clips them into a flat white blob.
  const hasFloatRt = context.getExtension("EXT_color_buffer_float") !== null;
  const hasHalfRt = context.getExtension("EXT_color_buffer_half_float") !== null;
  const candidates: ColorFormat[] = [];
  if (hasFloatRt || hasHalfRt) {
    candidates.push({ internal: context.RGBA16F, name: "RGBA16F" });
  }
  if (hasFloatRt) {
    // Half the bandwidth of RGBA16F and plenty of range for bloom, but only
    // colour-renderable when the full float extension is present.
    candidates.push({ internal: context.R11F_G11F_B10F, name: "R11F_G11F_B10F" });
  }
  const colorFormat = candidates.find((c) => probeFormat(context, c.internal)) ?? null;
  if (!colorFormat) {
    warn("no float/half-float render target; falling back to a direct blit.");
    return inertChain(canvas, null);
  }
  if (colorFormat !== candidates[0]) warn(`falling back to ${colorFormat.name} render targets.`);
  const format: ColorFormat = colorFormat;

  const maxTextureSize = Math.max(64, context.getParameter(context.MAX_TEXTURE_SIZE) as number);

  /* -- state ----------------------------------------------------------- */
  let disposed = false;
  let contextLost = false;
  let built = false;
  /** Set when allocation fails outright; distinct from a recoverable loss. */
  let failed = false;

  let vao: WebGLVertexArrayObject | null = null;
  let srcTex: WebGLTexture | null = null;
  let blackTex: WebGLTexture | null = null;
  let scene: RenderTarget | null = null;
  const mips: RenderTarget[] = [];
  const programs = new Map<string, GlProgram>();

  // Resolved once per build/quality change. The render path only ever reads
  // these — it never builds a shader key or a source string, because that would
  // allocate a string on every frame.
  let progIngest: GlProgram | null = null;
  let progPrefilter: GlProgram | null = null;
  let progDown: GlProgram | null = null;
  let progUp: GlProgram | null = null;
  let progComposite: GlProgram | null = null;

  let uploadWidth = 0;
  let uploadHeight = 0;

  let cssWidth = 0;
  let cssHeight = 0;
  let requestedDpr = 1;
  let pixelWidth = 0;
  let pixelHeight = 0;
  /** Device pixels per CSS pixel actually in use after every clamp. */
  let pixelScale = 1;

  /* -- GL object helpers ---------------------------------------------- */

  function compile(type: number, source: string): WebGLShader | null {
    const shader = context.createShader(type);
    if (!shader) return null;
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      warn(`shader compile failed: ${context.getShaderInfoLog(shader) ?? "unknown"}`);
      context.deleteShader(shader);
      return null;
    }
    return shader;
  }

  /**
   * Links a program and harvests every active uniform location up front, so the
   * per-frame path never calls `getUniformLocation` (a synchronous driver query
   * that has no business being in a render loop).
   */
  function link(key: string, buildSource: () => string): GlProgram | null {
    const cached = programs.get(key);
    if (cached) return cached;

    const vs = compile(context.VERTEX_SHADER, VERT_SRC);
    const fs = compile(context.FRAGMENT_SHADER, buildSource());
    if (!vs || !fs) {
      if (vs) context.deleteShader(vs);
      if (fs) context.deleteShader(fs);
      return null;
    }
    const program = context.createProgram();
    if (!program) {
      context.deleteShader(vs);
      context.deleteShader(fs);
      return null;
    }
    context.attachShader(program, vs);
    context.attachShader(program, fs);
    context.linkProgram(program);
    // Shaders are reference-counted by the program; detaching lets the driver
    // free the compiler's copy immediately.
    context.detachShader(program, vs);
    context.detachShader(program, fs);
    context.deleteShader(vs);
    context.deleteShader(fs);

    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      warn(`program link failed: ${context.getProgramInfoLog(program) ?? "unknown"}`);
      context.deleteProgram(program);
      return null;
    }

    const uniforms = new Map<string, WebGLUniformLocation>();
    const count = context.getProgramParameter(program, context.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = context.getActiveUniform(program, i);
      if (!info) continue;
      const name = info.name.endsWith("[0]") ? info.name.slice(0, -3) : info.name;
      const location = context.getUniformLocation(program, info.name);
      if (location) uniforms.set(name, location);
    }

    const entry: GlProgram = { program, uniforms };
    programs.set(key, entry);
    return entry;
  }

  function fragment(body: string, defines: Record<string, number>): string {
    let head = "#version 300 es\n";
    for (const name of Object.keys(defines)) head += `#define ${name} ${defines[name]}\n`;
    return head + body;
  }

  function setF(p: GlProgram, name: string, value: number): void {
    const location = p.uniforms.get(name);
    if (location) context.uniform1f(location, value);
  }

  function set2F(p: GlProgram, name: string, x: number, y: number): void {
    const location = p.uniforms.get(name);
    if (location) context.uniform2f(location, x, y);
  }

  function set3F(p: GlProgram, name: string, x: number, y: number, z: number): void {
    const location = p.uniforms.get(name);
    if (location) context.uniform3f(location, x, y, z);
  }

  function set4F(p: GlProgram, name: string, x: number, y: number, z: number, w: number): void {
    const location = p.uniforms.get(name);
    if (location) context.uniform4f(location, x, y, z, w);
  }

  function setTex(p: GlProgram, name: string, unit: number, texture: WebGLTexture | null): void {
    const location = p.uniforms.get(name);
    if (!location) return;
    context.activeTexture(context.TEXTURE0 + unit);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.uniform1i(location, unit);
  }

  function createTarget(width: number, height: number): RenderTarget | null {
    const tex = context.createTexture();
    const fbo = context.createFramebuffer();
    if (!tex || !fbo) {
      if (tex) context.deleteTexture(tex);
      if (fbo) context.deleteFramebuffer(fbo);
      return null;
    }
    context.bindTexture(context.TEXTURE_2D, tex);
    context.texStorage2D(context.TEXTURE_2D, 1, format.internal, width, height);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    // Clamping matters: the tent filter reaches outside the frame on every
    // level, and REPEAT would wrap the opposite edge's highlights into frame.
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);

    context.bindFramebuffer(context.FRAMEBUFFER, fbo);
    context.framebufferTexture2D(
      context.FRAMEBUFFER,
      context.COLOR_ATTACHMENT0,
      context.TEXTURE_2D,
      tex,
      0,
    );
    const ok = context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.bindTexture(context.TEXTURE_2D, null);
    if (!ok) {
      context.deleteTexture(tex);
      context.deleteFramebuffer(fbo);
      return null;
    }
    return { fbo, tex, width, height };
  }

  function destroyTarget(target: RenderTarget | null): void {
    if (!target || contextLost) return;
    context.deleteTexture(target.tex);
    context.deleteFramebuffer(target.fbo);
  }

  function releaseTargets(): void {
    destroyTarget(scene);
    scene = null;
    for (const mip of mips) destroyTarget(mip);
    mips.length = 0;
  }

  /* -- construction ---------------------------------------------------- */

  function build(): boolean {
    vao = context.createVertexArray();
    srcTex = context.createTexture();
    blackTex = context.createTexture();
    if (!vao || !srcTex || !blackTex) return false;

    context.bindTexture(context.TEXTURE_2D, srcTex);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);

    // A 1×1 black texture stands in for bloom when the pass is switched off, so
    // the composite never samples an incomplete texture unit.
    context.bindTexture(context.TEXTURE_2D, blackTex);
    context.texImage2D(
      context.TEXTURE_2D,
      0,
      context.RGBA8,
      1,
      1,
      0,
      context.RGBA,
      context.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.bindTexture(context.TEXTURE_2D, null);

    // These are context-wide unpack flags and this context is ours alone, so
    // they are set once instead of per upload.
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, 0);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
    context.disable(context.DEPTH_TEST);
    context.disable(context.STENCIL_TEST);
    context.disable(context.CULL_FACE);
    context.disable(context.SCISSOR_TEST);
    context.disable(context.BLEND);
    context.colorMask(true, true, true, true);

    uploadWidth = 0;
    uploadHeight = 0;
    built = true;
    return ensurePrograms();
  }

  /**
   * Resolves the five programs the current tier needs. Variants are compiled on
   * demand and kept, so flipping between quality tiers costs a Map lookup after
   * the first visit to each tier.
   */
  function ensurePrograms(): boolean {
    progIngest = link("ingest", () => fragment(FRAG_INGEST, {}));
    progPrefilter = link(`prefilter:${tier.karis ? 1 : 0}`, () =>
      fragment(FRAG_PREFILTER, { KARIS: tier.karis ? 1 : 0 }),
    );
    progDown = link("down", () => fragment(FRAG_DOWNSAMPLE, {}));
    progUp = link("up", () => fragment(FRAG_UPSAMPLE, {}));
    progComposite = link(
      `composite:${tier.chromaTaps}:${tier.radialTaps}:${tier.bloomChroma ? 1 : 0}`,
      () =>
        fragment(FRAG_COMPOSITE, {
          CHROMA_TAPS: tier.chromaTaps,
          RADIAL_TAPS: tier.radialTaps,
          BLOOM_CHROMA: tier.bloomChroma ? 1 : 0,
        }),
    );
    return !!(progIngest && progPrefilter && progDown && progUp && progComposite);
  }

  /** Recomputes the backing-store size and reallocates every render target. */
  function allocate(): boolean {
    releaseTargets();
    if (pixelWidth < 2 || pixelHeight < 2) return false;

    scene = createTarget(pixelWidth, pixelHeight);
    if (!scene) return false;

    // Level 0 is half resolution: the prefilter downsamples as it thresholds.
    let w = Math.max(1, pixelWidth >> 1);
    let h = Math.max(1, pixelHeight >> 1);
    for (let i = 0; i < tier.levels; i++) {
      // Below 4px a 13-tap kernel is sampling the same texel repeatedly and the
      // level contributes nothing but a bind.
      if (i > 0 && (w < 4 || h < 4)) break;
      const target = createTarget(Math.max(1, w), Math.max(1, h));
      if (!target) break;
      mips.push(target);
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    return mips.length > 0;
  }

  function applySize(width: number, height: number, dpr: number): void {
    cssWidth = Math.max(1, Math.round(safe(width, 1)));
    cssHeight = Math.max(1, Math.round(safe(height, 1)));
    requestedDpr = clamp(safe(dpr, 1), 0.5, 4);

    const ceiling = Math.min(tier.maxDpr, safe(options.maxDpr ?? 4, 4));
    let ratio = Math.min(requestedDpr, ceiling);
    let pw = Math.max(2, Math.round(cssWidth * ratio));
    let ph = Math.max(2, Math.round(cssHeight * ratio));

    // Two independent ceilings: total pixels (fill-rate) and the driver's
    // maximum texture edge.
    const total = pw * ph;
    if (total > tier.pixelBudget) ratio *= Math.sqrt(tier.pixelBudget / total);
    const longest = Math.max(pw, ph);
    if (longest > maxTextureSize) ratio *= maxTextureSize / longest;

    pw = Math.max(2, Math.floor(cssWidth * ratio));
    ph = Math.max(2, Math.floor(cssHeight * ratio));
    pixelScale = ph / cssHeight;

    if (pw === pixelWidth && ph === pixelHeight && scene && mips.length > 0) return;

    pixelWidth = pw;
    pixelHeight = ph;
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    if (ownsCanvas) {
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    if (!allocate()) {
      warn("render target allocation failed; falling back to a direct blit.");
      failed = true;
    }
  }

  /* -- passes ---------------------------------------------------------- */

  function bindTarget(target: RenderTarget | null): void {
    if (target) {
      context.bindFramebuffer(context.FRAMEBUFFER, target.fbo);
      context.viewport(0, 0, target.width, target.height);
    } else {
      context.bindFramebuffer(context.FRAMEBUFFER, null);
      context.viewport(0, 0, pixelWidth, pixelHeight);
    }
  }

  function draw(): void {
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  function uploadSource(source: TexImageSource): boolean {
    const size = sourceSize(source);
    if (!size) return false;
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, srcTex);
    if (size.w === uploadWidth && size.h === uploadHeight) {
      // Same dimensions: re-specifying storage every frame makes the driver
      // orphan and reallocate the texture, so patch it in place instead.
      context.texSubImage2D(
        context.TEXTURE_2D,
        0,
        0,
        0,
        context.RGBA,
        context.UNSIGNED_BYTE,
        source,
      );
    } else {
      context.texImage2D(
        context.TEXTURE_2D,
        0,
        context.RGBA8,
        context.RGBA,
        context.UNSIGNED_BYTE,
        source,
      );
      uploadWidth = size.w;
      uploadHeight = size.h;
    }
    return true;
  }

  function renderBloom(params: PostParams): boolean {
    const strength = safe(params.bloomStrength, 0);
    if (!(strength > 0) || !scene || mips.length === 0) return false;

    const prefilter = progPrefilter;
    const down = progDown;
    const up = progUp;
    if (!prefilter || !down || !up) return false;

    // --- prefilter: full res → mip0, soft-knee threshold ---------------
    const threshold = Math.max(0, safe(params.bloomThreshold, 1));
    const knee = Math.max(threshold * 0.5, 1e-3);
    context.useProgram(prefilter.program);
    setTex(prefilter, "uSrc", 0, scene.tex);
    set2F(prefilter, "uTexel", 1 / scene.width, 1 / scene.height);
    set4F(prefilter, "uCurve", threshold, threshold - knee, knee * 2, 0.25 / knee);
    setF(prefilter, "uExposure", Math.max(0, safe(params.exposure, 1)));
    bindTarget(mips[0]);
    draw();

    // --- progressive downsample ----------------------------------------
    context.useProgram(down.program);
    for (let i = 1; i < mips.length; i++) {
      const src = mips[i - 1];
      setTex(down, "uSrc", 0, src.tex);
      set2F(down, "uTexel", 1 / src.width, 1 / src.height);
      bindTarget(mips[i]);
      draw();
    }

    // --- upsample, accumulating additively into the finer level ---------
    const radius = clamp(safe(params.bloomRadius, 1), 0.25, 3);
    context.useProgram(up.program);
    setF(up, "uRadius", radius);
    context.enable(context.BLEND);
    context.blendEquation(context.FUNC_ADD);
    context.blendFunc(context.ONE, context.ONE);
    for (let i = mips.length - 1; i > 0; i--) {
      const src = mips[i];
      setTex(up, "uSrc", 0, src.tex);
      set2F(up, "uTexel", 1 / src.width, 1 / src.height);
      bindTarget(mips[i - 1]);
      draw();
    }
    context.disable(context.BLEND);
    return true;
  }

  /* -- public surface --------------------------------------------------- */

  function isReady(): boolean {
    return built && !disposed && !contextLost && !failed && !!scene && mips.length > 0;
  }

  function render(source: CanvasImageSource, params: PostParams, timeSeconds: number): void {
    if (disposed || contextLost || failed || !built) return;

    const texSource = asTexSource(source);
    if (!texSource) return;

    // First frame before any resize(): adopt the source's own dimensions.
    if (!scene || mips.length === 0) {
      const size = sourceSize(texSource);
      if (!size) return;
      applySize(size.w, size.h, 1);
      if (!isReady()) return;
    }
    const sceneTarget = scene;
    if (!sceneTarget) return;

    const composite = progComposite;
    const ingest = progIngest;
    if (!composite || !ingest) return;

    context.bindVertexArray(vao);
    context.disable(context.BLEND);

    if (!uploadSource(texSource)) return;

    // --- ingest: sRGB → linear, highlight reconstruction, Y flip --------
    context.useProgram(ingest.program);
    setTex(ingest, "uSrc", 0, srcTex);
    setF(ingest, "uExpandStart", EXPAND_START);
    setF(ingest, "uExpandMax", EXPAND_MAX);
    bindTarget(sceneTarget);
    draw();

    const hasBloom = renderBloom(params);

    // --- composite -------------------------------------------------------
    // Wrapping time keeps hash inputs small enough that a 24-bit mantissa still
    // decorrelates them after an hour-long session.
    const time = safe(timeSeconds, 0) % 600;
    const motion = reducedMotion ? 0 : 1;
    const grainSeed = reducedMotion ? seed * 0.5 + 11 : Math.floor(time * GRAIN_HZ) % 4096;

    context.useProgram(composite.program);
    setTex(composite, "uScene", 0, sceneTarget.tex);
    setTex(composite, "uBloom", 1, hasBloom && mips.length > 0 ? mips[0].tex : blackTex);
    set2F(composite, "uResolution", pixelWidth, pixelHeight);
    setF(composite, "uTime", time);
    setF(composite, "uGrainSeed", grainSeed);
    setF(composite, "uSeed", seed);
    setF(composite, "uMotion", motion);

    // Additive accumulation makes the pyramid sum roughly `levels` copies of the
    // average highlight, so normalising by the level count keeps `bloomStrength`
    // meaning the same thing across quality tiers.
    const bloomNorm = hasBloom ? 1 / mips.length : 0;
    setF(composite, "uBloomStrength", Math.max(0, safe(params.bloomStrength, 0)) * bloomNorm);
    setF(composite, "uChroma", Math.max(0, safe(params.chroma, 0)) * pixelScale);
    setF(composite, "uVignette", clamp(safe(params.vignette, 0), 0, 1));
    setF(composite, "uGrain", Math.max(0, safe(params.grain, 0)) * tier.grain);
    setF(composite, "uGrainCell", GRAIN_CELL_CSS * pixelScale);
    setF(composite, "uScanline", clamp(safe(params.scanline, 0), 0, 1));
    setF(composite, "uScanPitch", SCAN_PITCH_CSS * pixelScale);
    setF(composite, "uBarrel", clamp(safe(params.barrel, 0), 0, 1));
    setF(composite, "uExposure", Math.max(0, safe(params.exposure, 1)));
    setF(composite, "uContrast", clamp(safe(params.contrast, 1), 0.25, 3));
    setF(composite, "uSaturation", clamp(safe(params.saturation, 1), 0, 3));
    setF(composite, "uTemperature", clamp(safe(params.temperature, 0), -1, 1));

    // Grade shape. A caller that only knows the frozen contract supplies neither
    // of these and gets the plain global chroma scale it always got.
    const grade = params as PopPostParams;
    setF(
      composite,
      "uChromaGain",
      clamp(safe(grade.chromaGain ?? DEFAULT_GRADE_SHAPE.chromaGain, 1), 0, 4),
    );
    setF(
      composite,
      "uChromaKnee",
      clamp(safe(grade.chromaKnee ?? DEFAULT_GRADE_SHAPE.chromaKnee, 0.55), 0.02, 4),
    );

    // Reduced motion keeps the flash — it is compositionally load-bearing — but
    // halves it, so a rapid sequence of hits cannot read as a strobe.
    const flash = clamp(safe(params.flashAmount, 0), 0, 4) * (reducedMotion ? 0.5 : 1);
    setF(composite, "uFlashAmount", flash);
    const fc = params.flashColor;
    set3F(
      composite,
      "uFlashColor",
      Math.max(0, safe(fc ? fc[0] : 1, 1)),
      Math.max(0, safe(fc ? fc[1] : 1, 1)),
      Math.max(0, safe(fc ? fc[2] : 1, 1)),
    );

    // Flash shape. A caller that only knows the frozen contract supplies none
    // of these and gets the flat full-frame flash it always got.
    const shape = params as PopPostParams;
    set2F(
      composite,
      "uFlashOrigin",
      clamp(safe(shape.flashCenterX ?? DEFAULT_FLASH_SHAPE.flashCenterX, 0.5), -1, 2),
      clamp(safe(shape.flashCenterY ?? DEFAULT_FLASH_SHAPE.flashCenterY, 0.5), -1, 2),
    );
    setF(
      composite,
      "uFlashRadius",
      clamp(safe(shape.flashRadius ?? DEFAULT_FLASH_SHAPE.flashRadius, 1.4), 0.02, 8),
    );
    setF(
      composite,
      "uFlashFront",
      clamp(safe(shape.flashFront ?? DEFAULT_FLASH_SHAPE.flashFront, 0.34), 0.02, 4),
    );
    setF(
      composite,
      "uFlashUniform",
      clamp(safe(shape.flashUniform ?? DEFAULT_FLASH_SHAPE.flashUniform, 1), 0, 1),
    );

    // Glitch is shake-class motion: reduced motion removes it outright.
    setF(composite, "uGlitch", clamp(safe(params.glitch, 0), 0, 1) * motion);
    setF(composite, "uRadial", clamp(safe(params.radialBlur, 0), 0, 1));

    bindTarget(null);
    draw();

    context.bindVertexArray(null);
    context.bindFramebuffer(context.FRAMEBUFFER, null);
  }

  /* -- lifecycle -------------------------------------------------------- */

  function releaseAll(deleteObjects: boolean): void {
    if (deleteObjects) {
      releaseTargets();
      for (const entry of programs.values()) context.deleteProgram(entry.program);
      if (vao) context.deleteVertexArray(vao);
      if (srcTex) context.deleteTexture(srcTex);
      if (blackTex) context.deleteTexture(blackTex);
    } else {
      // Context is gone: the objects went with it, so drop the handles without
      // touching the driver.
      scene = null;
      mips.length = 0;
    }
    programs.clear();
    progIngest = null;
    progPrefilter = null;
    progDown = null;
    progUp = null;
    progComposite = null;
    vao = null;
    srcTex = null;
    blackTex = null;
    scene = null;
    mips.length = 0;
    built = false;
    uploadWidth = 0;
    uploadHeight = 0;
  }

  const onContextLost = (event: Event): void => {
    // Without preventDefault the browser will never offer a restore.
    event.preventDefault();
    contextLost = true;
    releaseAll(false);
  };

  const onContextRestored = (): void => {
    if (disposed) return;
    // Every GL object died with the old context, so this is a full rebuild.
    contextLost = false;
    failed = false;
    pixelWidth = 0;
    pixelHeight = 0;
    if (!build()) {
      failed = true;
      return;
    }
    if (cssWidth > 0 && cssHeight > 0) applySize(cssWidth, cssHeight, requestedDpr);
  };

  canvas.addEventListener("webglcontextlost", onContextLost, false);
  canvas.addEventListener("webglcontextrestored", onContextRestored, false);

  if (!build()) {
    warn("shader build failed; falling back to a direct blit.");
    releaseAll(true);
    canvas.removeEventListener("webglcontextlost", onContextLost, false);
    canvas.removeEventListener("webglcontextrestored", onContextRestored, false);
    if (motionQuery) motionQuery.removeEventListener("change", onMotionChange);
    return inertChain(canvas, null);
  }

  return {
    get available(): boolean {
      return !disposed && !contextLost && !failed && built;
    },
    get canvas(): HTMLCanvasElement {
      return canvas;
    },
    resize(width: number, height: number, dpr: number): void {
      if (disposed || contextLost || failed) return;
      applySize(width, height, dpr);
    },
    render,
    setQuality(next: QualityTier): void {
      if (disposed || next === quality || !TIERS[next]) return;
      quality = next;
      tier = TIERS[next];
      if (contextLost || failed || !built) return;
      if (!ensurePrograms()) {
        failed = true;
        return;
      }
      // Level count and the DPR ceiling both moved, so force a reallocation.
      pixelWidth = 0;
      pixelHeight = 0;
      if (cssWidth > 0 && cssHeight > 0) applySize(cssWidth, cssHeight, requestedDpr);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onContextLost, false);
      canvas.removeEventListener("webglcontextrestored", onContextRestored, false);
      if (motionQuery) motionQuery.removeEventListener("change", onMotionChange);
      motionQuery = null;
      releaseAll(!contextLost);
      if (!contextLost) {
        // Ask the driver to reclaim the backing store now rather than at the
        // next GC; the canvas may outlive the chain in a React tree.
        const lose = context.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      }
    },
  };
}

/**
 * Verifies that a colour format really is renderable. Extension presence is
 * necessary but not sufficient — some drivers advertise the extension and then
 * fail framebuffer completeness for the format, so the only honest test is to
 * build a tiny target and ask.
 */
function probeFormat(gl: WebGL2RenderingContext, internalFormat: number): boolean {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) {
    if (tex) gl.deleteTexture(tex);
    if (fbo) gl.deleteFramebuffer(fbo);
    return false;
  }
  // Drain any pre-existing error so the probe's own verdict is not polluted.
  for (let guard = 0; guard < 8 && gl.getError() !== gl.NO_ERROR; guard++);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, 4, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  // texStorage2D on an unsupported internal format raises INVALID_ENUM; clear
  // the flag so a later, legitimate error is not misattributed.
  return complete && gl.getError() === gl.NO_ERROR;
}

/**
 * The unavailable path. `available` is false so callers blit the source canvas
 * themselves, exactly as the contract says. When the chain created the canvas
 * there is nowhere else for the frame to go, so it also blits into it through
 * 2D — but only if no GL context was ever obtained on that canvas, since a
 * canvas can only ever hand out one context type.
 */
function inertChain(canvas: HTMLCanvasElement, blitTarget: HTMLCanvasElement | null): PostChain {
  let ctx: CanvasRenderingContext2D | null = null;
  let ctxTried = false;
  let width = 0;
  let height = 0;

  function fallbackContext(): CanvasRenderingContext2D | null {
    if (ctxTried) return ctx;
    ctxTried = true;
    if (!blitTarget || typeof blitTarget.getContext !== "function") return null;
    try {
      ctx = blitTarget.getContext("2d");
    } catch {
      ctx = null;
    }
    return ctx;
  }

  return {
    available: false,
    canvas,
    resize(w: number, h: number, dpr: number): void {
      width = Math.max(1, Math.round(safe(w, 1)));
      height = Math.max(1, Math.round(safe(h, 1)));
      const ratio = clamp(safe(dpr, 1), 0.5, 3);
      const pw = Math.max(2, Math.round(width * ratio));
      const ph = Math.max(2, Math.round(height * ratio));
      if (typeof canvas.getContext !== "function") return;
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      if (blitTarget) {
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    },
    render(source: CanvasImageSource): void {
      const target = fallbackContext();
      if (!target || canvas.width < 1 || canvas.height < 1) return;
      try {
        target.clearRect(0, 0, canvas.width, canvas.height);
        target.drawImage(source, 0, 0, canvas.width, canvas.height);
      } catch {
        // A broken or tainted source must not take the frame loop down.
      }
    },
    setQuality(): void {
      /* nothing to scale without a GPU path */
    },
    dispose(): void {
      ctx = null;
      ctxTried = true;
    },
  };
}
