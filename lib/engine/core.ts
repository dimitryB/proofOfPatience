/**
 * POP engine core — determinism, motion, time and colour.
 *
 * Every other engine and render module sits on top of this file, so it holds a
 * deliberately high bar: exact analytic solutions where a closed form exists,
 * real gradient noise rather than hashed value noise, and colour maths that
 * happens in linear light instead of averaging gamma-encoded bytes.
 *
 * Constraints this file honours (see docs/ENGINE_ARCHITECTURE.md):
 *   - no `Math.random`, ever: all stochastic behaviour flows from `createRng`;
 *   - no DOM or Node access at module scope — the app server-renders, and this
 *     module must import cleanly inside a Cloudflare Worker;
 *   - nothing expensive runs at import time; lookup tables build on first use;
 *   - no allocation in the per-frame hot paths (vector helpers accept an `out`
 *     target, springs cache their integration coefficients).
 */

import type { Camera, Clock, Noise, Rng, Spring, SpringConfig, Vec2 } from "../render/types";

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Scalar maths
 * ------------------------------------------------------------------ */

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Hermite smoothstep. Both call shapes are supported because both are common:
 * `smoothstep(t)` treats the argument as an already-normalised 0–1 parameter,
 * `smoothstep(edge0, edge1, x)` matches the GLSL signature.
 */
export function smoothstep(t: number): number;
export function smoothstep(edge0: number, edge1: number, x: number): number;
export function smoothstep(a: number, b?: number, c?: number): number {
  const t = normaliseEdges(a, b, c);
  return t * t * (3 - 2 * t);
}

/** Ken Perlin's second-order smoothstep: zero first *and* second derivative at both ends. */
export function smootherstep(t: number): number;
export function smootherstep(edge0: number, edge1: number, x: number): number;
export function smootherstep(a: number, b?: number, c?: number): number {
  const t = normaliseEdges(a, b, c);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function normaliseEdges(a: number, b: number | undefined, c: number | undefined): number {
  if (b === undefined || c === undefined) return clamp01(a);
  const span = b - a;
  if (span === 0) return c >= b ? 1 : 0;
  return clamp01((c - a) / span);
}

/**
 * Framerate-independent exponential approach — the correct replacement for the
 * ubiquitous `x += (target - x) * 0.1`, which silently changes speed with the
 * refresh rate. `lambda` is a rate in units of 1/second: the remaining distance
 * is multiplied by e^(-lambda·dt), so lambda ≈ 12 halves the gap every ~58 ms.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  if (!(dt > 0) || !Number.isFinite(dt)) return current;
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Inverse of `lerp`: where does `value` sit between a and b. Degenerate spans return 0. */
export function invLerp(a: number, b: number, value: number): number {
  const span = b - a;
  return span === 0 ? 0 : (value - a) / span;
}

/** Map a value from one range to another; optionally clamped to the output range. */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  clamped = false,
): number {
  const t = invLerp(inMin, inMax, value);
  const mapped = outMin + (outMax - outMin) * t;
  if (!clamped) return mapped;
  return outMin < outMax ? clamp(mapped, outMin, outMax) : clamp(mapped, outMax, outMin);
}

/* ------------------------------------------------------------------ *
 * Easing
 * ------------------------------------------------------------------ */

type Easing = (t: number) => number;

// Back-overshoot constants (easings.net): c1 ≈ 1.70158 gives ~10% overshoot.
const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;
const BACK_C2 = BACK_C1 * 1.525;
const ELASTIC_C4 = TAU / 3;
const ELASTIC_C5 = TAU / 4.5;

/** Shared by inBounce / outBounce / inOutBounce — four decaying parabolic arcs. */
function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) {
    const u = t - 1.5 / d;
    return n * u * u + 0.75;
  }
  if (t < 2.5 / d) {
    const u = t - 2.25 / d;
    return n * u * u + 0.9375;
  }
  const u = t - 2.625 / d;
  return n * u * u + 0.984375;
}

/**
 * The full easing set. Every function clamps its input to 0–1 first, so feeding
 * an un-normalised progress value can never produce NaN or an exploding
 * elastic/expo tail mid-frame.
 */
export const ease = {
  linear: (t: number): number => clamp01(t),

  inQuad: (t: number): number => {
    const x = clamp01(t);
    return x * x;
  },
  outQuad: (t: number): number => {
    const x = 1 - clamp01(t);
    return 1 - x * x;
  },
  inOutQuad: (t: number): number => {
    const x = clamp01(t);
    return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) * (-2 * x + 2)) / 2;
  },

  inCubic: (t: number): number => {
    const x = clamp01(t);
    return x * x * x;
  },
  outCubic: (t: number): number => {
    const x = 1 - clamp01(t);
    return 1 - x * x * x;
  },
  inOutCubic: (t: number): number => {
    const x = clamp01(t);
    if (x < 0.5) return 4 * x * x * x;
    const u = -2 * x + 2;
    return 1 - (u * u * u) / 2;
  },

  inQuart: (t: number): number => {
    const x = clamp01(t);
    return x * x * x * x;
  },
  outQuart: (t: number): number => {
    const x = 1 - clamp01(t);
    return 1 - x * x * x * x;
  },
  inOutQuart: (t: number): number => {
    const x = clamp01(t);
    if (x < 0.5) return 8 * x * x * x * x;
    const u = -2 * x + 2;
    return 1 - (u * u * u * u) / 2;
  },

  inQuint: (t: number): number => {
    const x = clamp01(t);
    return x * x * x * x * x;
  },
  outQuint: (t: number): number => {
    const x = 1 - clamp01(t);
    return 1 - x * x * x * x * x;
  },
  inOutQuint: (t: number): number => {
    const x = clamp01(t);
    if (x < 0.5) return 16 * x * x * x * x * x;
    const u = -2 * x + 2;
    return 1 - (u * u * u * u * u) / 2;
  },

  inExpo: (t: number): number => {
    const x = clamp01(t);
    return x === 0 ? 0 : Math.pow(2, 10 * x - 10);
  },
  outExpo: (t: number): number => {
    const x = clamp01(t);
    return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
  },
  inOutExpo: (t: number): number => {
    const x = clamp01(t);
    if (x === 0) return 0;
    if (x === 1) return 1;
    return x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2;
  },

  inSine: (t: number): number => 1 - Math.cos((clamp01(t) * Math.PI) / 2),
  outSine: (t: number): number => Math.sin((clamp01(t) * Math.PI) / 2),
  inOutSine: (t: number): number => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2,

  inCirc: (t: number): number => {
    const x = clamp01(t);
    return 1 - Math.sqrt(1 - x * x);
  },
  outCirc: (t: number): number => {
    const x = clamp01(t) - 1;
    return Math.sqrt(1 - x * x);
  },
  inOutCirc: (t: number): number => {
    const x = clamp01(t);
    if (x < 0.5) return (1 - Math.sqrt(1 - 4 * x * x)) / 2;
    const u = -2 * x + 2;
    return (Math.sqrt(1 - u * u) + 1) / 2;
  },

  inBack: (t: number): number => {
    const x = clamp01(t);
    return BACK_C3 * x * x * x - BACK_C1 * x * x;
  },
  outBack: (t: number): number => {
    const x = clamp01(t) - 1;
    return 1 + BACK_C3 * x * x * x + BACK_C1 * x * x;
  },
  inOutBack: (t: number): number => {
    const x = clamp01(t);
    if (x < 0.5) {
      const u = 2 * x;
      return (u * u * ((BACK_C2 + 1) * u - BACK_C2)) / 2;
    }
    const u = 2 * x - 2;
    return (u * u * ((BACK_C2 + 1) * u + BACK_C2) + 2) / 2;
  },

  inElastic: (t: number): number => {
    const x = clamp01(t);
    if (x === 0) return 0;
    if (x === 1) return 1;
    return -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * ELASTIC_C4);
  },
  outElastic: (t: number): number => {
    const x = clamp01(t);
    if (x === 0) return 0;
    if (x === 1) return 1;
    return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ELASTIC_C4) + 1;
  },
  inOutElastic: (t: number): number => {
    const x = clamp01(t);
    if (x === 0) return 0;
    if (x === 1) return 1;
    const s = Math.sin((20 * x - 11.125) * ELASTIC_C5);
    return x < 0.5 ? -(Math.pow(2, 20 * x - 10) * s) / 2 : (Math.pow(2, -20 * x + 10) * s) / 2 + 1;
  },

  inBounce: (t: number): number => 1 - bounceOut(1 - clamp01(t)),
  outBounce: (t: number): number => bounceOut(clamp01(t)),
  inOutBounce: (t: number): number => {
    const x = clamp01(t);
    return x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2;
  },
} as const satisfies Record<string, Easing>;

/* ------------------------------------------------------------------ *
 * 2D vectors
 * ------------------------------------------------------------------ */

function writeVec(out: Vec2 | undefined, x: number, y: number): Vec2 {
  if (out) {
    out.x = x;
    out.y = y;
    return out;
  }
  return { x, y };
}

/**
 * Small, allocation-aware 2D vector helpers. Every function that produces a
 * vector takes an optional `out` target so hot loops can reuse scratch objects
 * instead of littering the nursery.
 *
 * Canvas space is y-down, so a positive rotation appears clockwise on screen
 * even though the maths is the usual counter-clockwise convention.
 */
export const vec = {
  add(a: Vec2, b: Vec2, out?: Vec2): Vec2 {
    return writeVec(out, a.x + b.x, a.y + b.y);
  },
  sub(a: Vec2, b: Vec2, out?: Vec2): Vec2 {
    return writeVec(out, a.x - b.x, a.y - b.y);
  },
  scale(a: Vec2, s: number, out?: Vec2): Vec2 {
    return writeVec(out, a.x * s, a.y * s);
  },
  len(a: Vec2): number {
    return Math.sqrt(a.x * a.x + a.y * a.y);
  },
  lenSq(a: Vec2): number {
    return a.x * a.x + a.y * a.y;
  },
  norm(a: Vec2, out?: Vec2): Vec2 {
    const l = Math.sqrt(a.x * a.x + a.y * a.y);
    if (l < 1e-12) return writeVec(out, 0, 0);
    const inv = 1 / l;
    return writeVec(out, a.x * inv, a.y * inv);
  },
  dot(a: Vec2, b: Vec2): number {
    return a.x * b.x + a.y * b.y;
  },
  /** 2D cross product: the z component of the 3D cross, i.e. signed parallelogram area. */
  cross(a: Vec2, b: Vec2): number {
    return a.x * b.y - a.y * b.x;
  },
  rot(a: Vec2, radians: number, out?: Vec2): Vec2 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return writeVec(out, a.x * c - a.y * s, a.x * s + a.y * c);
  },
  dist(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  },
  /** Direction of `a`, or — when `b` is supplied — the direction from `a` to `b`. */
  angle(a: Vec2, b?: Vec2): number {
    if (b) return Math.atan2(b.y - a.y, b.x - a.x);
    return Math.atan2(a.y, a.x);
  },
  lerp(a: Vec2, b: Vec2, t: number, out?: Vec2): Vec2 {
    return writeVec(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  },
  /**
   * Mirror `v` about the plane whose normal is `n` (v - 2(v·n)n). The normal is
   * re-normalised when it is not already unit length, so callers can pass a raw
   * surface vector without a separate normalise step.
   */
  reflect(v: Vec2, n: Vec2, out?: Vec2): Vec2 {
    let nx = n.x;
    let ny = n.y;
    const lsq = nx * nx + ny * ny;
    if (lsq < 1e-12) return writeVec(out, v.x, v.y);
    if (Math.abs(lsq - 1) > 1e-6) {
      const inv = 1 / Math.sqrt(lsq);
      nx *= inv;
      ny *= inv;
    }
    const d = 2 * (v.x * nx + v.y * ny);
    return writeVec(out, v.x - d * nx, v.y - d * ny);
  },
} as const;

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

interface Rgba {
  r: number; // 0–255
  g: number;
  b: number;
  a: number; // 0–1
}

/** Anything the colour helpers accept: a CSS string or an already-parsed rgba record. */
type ColorInput = string | Rgba;

/**
 * Parse failures resolve to the set's own deep charcoal rather than a debug
 * magenta: a mistake reads as a hole in the frame instead of a hue that would
 * violate the single-saturated-colour rule.
 */
const FALLBACK: Rgba = { r: 8, g: 6, b: 4, a: 1 };

const colorCache = new Map<string, Rgba>();
const COLOR_CACHE_LIMIT = 512;

// sRGB transfer function, exact (IEC 61966-2-1). The 256-entry table covers the
// overwhelmingly common integer-channel case; fractional channels take the slow
// path. Built on first use so importing this module stays free.
let srgbTable: Float64Array | null = null;

function srgbTableRef(): Float64Array {
  if (!srgbTable) {
    const table = new Float64Array(256);
    for (let i = 0; i < 256; i++) table[i] = srgbToLinearUnit(i / 255);
    srgbTable = table;
  }
  return srgbTable;
}

function srgbToLinearUnit(s: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgbUnit(l: number): number {
  if (l <= 0) return 0;
  if (l >= 1) return 1;
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

/** 0–255 sRGB channel to 0–1 linear light. */
function toLinear(channel: number): number {
  const i = channel | 0;
  if (i === channel && i >= 0 && i < 256) return srgbTableRef()[i];
  return srgbToLinearUnit(channel / 255);
}

/** 0–1 linear light back to a 0–255 sRGB channel. */
function fromLinear(linear: number): number {
  return linearToSrgbUnit(linear) * 255;
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

function parseHex(hex: string): Rgba | null {
  const n = hex.length;
  if (n !== 3 && n !== 4 && n !== 6 && n !== 8) return null;
  const digits = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const d = hexDigit(hex.charCodeAt(i));
    if (d < 0) return null;
    digits[i] = d;
  }
  if (n === 3 || n === 4) {
    // #rgb / #rgba — each nibble doubles (0xf -> 0xff), i.e. multiply by 17.
    return {
      r: digits[0] * 17,
      g: digits[1] * 17,
      b: digits[2] * 17,
      a: n === 4 ? (digits[3] * 17) / 255 : 1,
    };
  }
  return {
    r: digits[0] * 16 + digits[1],
    g: digits[2] * 16 + digits[3],
    b: digits[4] * 16 + digits[5],
    a: n === 8 ? (digits[6] * 16 + digits[7]) / 255 : 1,
  };
}

function parseChannel(token: string, scale: number): number {
  const value = parseFloat(token);
  if (!Number.isFinite(value)) return NaN;
  return token.charCodeAt(token.length - 1) === 37 /* % */ ? (value / 100) * scale : value;
}

function parseFunctional(body: string): Rgba | null {
  // Accepts both legacy `rgb(r, g, b)` / `rgba(r, g, b, a)` and the modern
  // space-separated `rgb(r g b / a)` form, with or without percentages.
  const parts = body.replace(/,/g, " ").replace(/\//g, " ").split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < parts.length; i++) if (parts[i].length > 0) tokens.push(parts[i]);
  if (tokens.length < 3) return null;
  const r = parseChannel(tokens[0], 255);
  const g = parseChannel(tokens[1], 255);
  const b = parseChannel(tokens[2], 255);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  let a = 1;
  if (tokens.length > 3) {
    const parsed = parseChannel(tokens[3], 1);
    if (!Number.isFinite(parsed)) return null;
    a = clamp01(parsed);
  }
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a };
}

function parseUncached(css: string): Rgba {
  const s = css.trim().toLowerCase();
  if (s.length === 0) return FALLBACK;
  if (s.charCodeAt(0) === 35 /* # */) return parseHex(s.slice(1)) ?? FALLBACK;
  if (s.charCodeAt(0) === 114 /* r */) {
    const open = s.indexOf("(");
    const close = s.lastIndexOf(")");
    if (open > 0 && close > open) return parseFunctional(s.slice(open + 1, close)) ?? FALLBACK;
    return FALLBACK;
  }
  // The palette is hex-only, so the named-colour set stays deliberately tiny —
  // just enough that a stray keyword never poisons a gradient with NaN.
  if (s === "transparent" || s === "none") return { r: 0, g: 0, b: 0, a: 0 };
  if (s === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (s === "black") return { r: 0, g: 0, b: 0, a: 1 };
  return FALLBACK;
}

/**
 * CSS colour to `{ r, g, b, a }` with r/g/b in 0–255 and a in 0–1.
 *
 * Handles `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` and the
 * modern slash-alpha form. Parsed results are memoised (the returned object is
 * always a fresh copy, so callers are free to mutate it) which makes repeated
 * per-frame lookups of palette constants essentially free.
 */
export function parseColor(css: string): Rgba {
  let hit = colorCache.get(css);
  if (!hit) {
    hit = parseUncached(css);
    // Bounded so a renderer generating unique colour strings cannot leak.
    if (colorCache.size >= COLOR_CACHE_LIMIT) colorCache.clear();
    colorCache.set(css, hit);
  }
  return { r: hit.r, g: hit.g, b: hit.b, a: hit.a };
}

function toRgba(input: ColorInput): Rgba {
  return typeof input === "string" ? parseColor(input) : input;
}

function byteHex(value: number): string {
  const v = clamp(Math.round(value), 0, 255);
  return v < 16 ? "0" + v.toString(16) : v.toString(16);
}

/** Serialise back to CSS: opaque colours become hex, translucent ones `rgba()`. */
function toCss(r: number, g: number, b: number, a: number): string {
  const alpha = clamp01(a);
  if (alpha >= 0.999) return "#" + byteHex(r) + byteHex(g) + byteHex(b);
  const R = clamp(Math.round(r), 0, 255);
  const G = clamp(Math.round(g), 0, 255);
  const B = clamp(Math.round(b), 0, 255);
  return "rgba(" + R + "," + G + "," + B + "," + Math.round(alpha * 1000) / 1000 + ")";
}

// OKLab (Björn Ottosson) — perceptually uniform enough that a bone→orange ramp
// keeps its chroma instead of dipping through mud in the middle.
function linearToOklab(r: number, g: number, b: number, out: Float64Array): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.629978701 * b);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

function oklabToLinear(L: number, A: number, B: number, out: Float64Array): void {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

// Scratch buffers for the colour conversions: colour maths is called often
// enough (gradient ramps, per-card tints) that per-call allocation is waste.
const labA = new Float64Array(3);
const labB = new Float64Array(3);
const labOut = new Float64Array(3);

/**
 * Blend two colours and return a CSS string.
 *
 * The mix happens in **linear light** with premultiplied alpha — averaging
 * gamma-encoded bytes darkens midpoints and is the single most common reason
 * procedural gradients look muddy. Pass `"oklab"` for ramps between strongly
 * different hues, where perceptual uniformity beats radiometric correctness.
 *
 * Building a CSS string is not free: cache the result, never call this per
 * particle per frame.
 */
export function mixColor(
  a: ColorInput,
  b: ColorInput,
  t: number,
  space: "linear" | "oklab" = "linear",
): string {
  const ca = toRgba(a);
  const cb = toRgba(b);
  const k = clamp01(t);
  const alpha = ca.a + (cb.a - ca.a) * k;

  // Premultiply so a fully transparent endpoint contributes no colour at all,
  // matching how CSS `color-mix` and every compositor behave.
  const ar = toLinear(ca.r) * ca.a;
  const ag = toLinear(ca.g) * ca.a;
  const ab = toLinear(ca.b) * ca.a;
  const br = toLinear(cb.r) * cb.a;
  const bg = toLinear(cb.g) * cb.a;
  const bb = toLinear(cb.b) * cb.a;

  if (space === "oklab") {
    linearToOklab(ar, ag, ab, labA);
    linearToOklab(br, bg, bb, labB);
    oklabToLinear(
      labA[0] + (labB[0] - labA[0]) * k,
      labA[1] + (labB[1] - labA[1]) * k,
      labA[2] + (labB[2] - labA[2]) * k,
      labOut,
    );
    const inv = alpha > 1e-6 ? 1 / alpha : 0;
    return toCss(fromLinear(labOut[0] * inv), fromLinear(labOut[1] * inv), fromLinear(labOut[2] * inv), alpha);
  }

  const inv = alpha > 1e-6 ? 1 / alpha : 0;
  return toCss(
    fromLinear((ar + (br - ar) * k) * inv),
    fromLinear((ag + (bg - ag) * k) * inv),
    fromLinear((ab + (bb - ab) * k) * inv),
    alpha,
  );
}

/** Same colour, explicit alpha (replaces rather than scales the existing alpha). */
export function withAlpha(color: ColorInput, a: number): string {
  const c = toRgba(color);
  return toCss(c.r, c.g, c.b, clamp01(a));
}

/**
 * Lighten (`amount > 0`) or darken (`amount < 0`) in linear light.
 *
 * Darkening is a straight linear-light multiply by `1 + amount`, which is
 * exactly hue preserving — the same thing a light falloff does physically.
 * Lightening applies an exposure gain of `1 / (1 - amount)` and then blends
 * toward white by `amount²`, so small values read as "more light on the same
 * material" while `shade(c, 1)` still terminates cleanly at white instead of
 * clipping channel-by-channel into a hue shift.
 */
export function shade(color: ColorInput, amount: number): string {
  const c = toRgba(color);
  const k = clamp(amount, -1, 1);
  if (k === 0) return toCss(c.r, c.g, c.b, c.a);

  let lr = toLinear(c.r);
  let lg = toLinear(c.g);
  let lb = toLinear(c.b);

  if (k < 0) {
    const gain = 1 + k;
    lr *= gain;
    lg *= gain;
    lb *= gain;
  } else {
    const gain = 1 / Math.max(1e-3, 1 - k);
    const toWhite = k * k;
    lr = lerp(lr * gain, 1, toWhite);
    lg = lerp(lg * gain, 1, toWhite);
    lb = lerp(lb * gain, 1, toWhite);
  }
  return toCss(fromLinear(lr), fromLinear(lg), fromLinear(lb), c.a);
}

/* ------------------------------------------------------------------ *
 * Deterministic random — xoshiro128**
 * ------------------------------------------------------------------ */

const INV_U32 = 1 / 4294967296;

/** splitmix32 finaliser: full 32-bit avalanche, used for seeding and stream tags. */
function mix32(x: number): number {
  let z = x | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Accepts any finite number (including fractional seeds) and hashes it to 32 bits. */
function normaliseSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0x1a2b3c4d;
  const whole = Math.trunc(seed);
  const frac = seed - whole;
  return (mix32(whole | 0) ^ mix32(Math.round(frac * 0xffffffff) | 0)) >>> 0;
}

function seedState(seed: number): Uint32Array {
  const s = new Uint32Array(4);
  let z = seed | 0;
  for (let i = 0; i < 4; i++) {
    z = (z + 0x9e3779b9) | 0; // golden-ratio stride keeps consecutive seeds apart
    s[i] = mix32(z);
  }
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 0x9e3779b9; // all-zero state is a fixed point
  return s;
}

/**
 * xoshiro128** — period 2^128−1, passes BigCrush, and the `**` scrambler means
 * every output bit is usable (unlike an LCG, whose low bits show obvious
 * short-period structure, or xoshiro+, whose low bits are weak).
 */
function nextU32(s: Uint32Array): number {
  const result = Math.imul(rotl32(Math.imul(s[1], 5), 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl32(s[3], 11);
  return result;
}

// Jump polynomial for xoshiro128**: applying it is equivalent to drawing 2^64
// values, so successive jumps carve the sequence into provably disjoint blocks.
const JUMP = [0x8764000b, 0xf542d2d3, 0x6fa035c3, 0x77f2db5b];

function jumpState(s: Uint32Array): void {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  for (let i = 0; i < 4; i++) {
    for (let bit = 0; bit < 32; bit++) {
      if (JUMP[i] & (1 << bit)) {
        s0 ^= s[0];
        s1 ^= s[1];
        s2 ^= s[2];
        s3 ^= s[3];
      }
      nextU32(s);
    }
  }
  s[0] = s0 >>> 0;
  s[1] = s1 >>> 0;
  s[2] = s2 >>> 0;
  s[3] = s3 >>> 0;
}

function makeRng(state: Uint32Array, rootSeed: number, streamId: number): Rng {
  // Snapshot of the starting state, used as the origin for anonymous forks.
  const origin = Uint32Array.from(state);
  let jumpCursor: Uint32Array | null = null;
  let blocks = 0;

  const nextFloat = (): number => nextU32(state) * INV_U32;

  const rng: Rng = {
    next: nextFloat,
    range(min: number, max: number): number {
      return min + (max - min) * nextFloat();
    },
    int(min: number, max: number): number {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      if (hi <= lo) return lo;
      const span = hi - lo + 1;
      const value = lo + Math.floor(nextFloat() * span);
      return value > hi ? hi : value;
    },
    sign(): number {
      // Top bit: with the ** scrambler it is as good as any, and dodges the
      // float round-trip entirely.
      return (nextU32(state) & 0x80000000) !== 0 ? 1 : -1;
    },
    pick<T>(items: readonly T[]): T {
      const n = items.length;
      return items[n > 0 ? Math.min(n - 1, (nextFloat() * n) | 0) : 0];
    },
    fork(salt?: number): Rng {
      if (salt === undefined) {
        // Anonymous fork: hand out the next 2^64-long block. The parent keeps
        // block 0 and would need 2^64 draws to ever reach block 1, so the
        // streams are disjoint by construction, not merely by luck.
        if (!jumpCursor) jumpCursor = Uint32Array.from(origin);
        blocks++;
        jumpState(jumpCursor);
        return makeRng(Uint32Array.from(jumpCursor), rootSeed, mix32(streamId + blocks * 0x9e3779b9));
      }
      // Salted fork: a pure function of (root seed, stream id, salt). Calling
      // fork(0x51) from two different modules in any order always yields the
      // same stream, which is what keeps one consumer from desyncing another.
      const tag = mix32(rootSeed ^ mix32(streamId ^ mix32(normaliseSeed(salt) ^ 0x2545f491)));
      return makeRng(seedState(tag), rootSeed, tag);
    },
  };
  return rng;
}

/**
 * Deterministic random source. Two `createRng(7)` instances produce byte-identical
 * streams, which is what makes screenshot diffing possible.
 */
export function createRng(seed: number): Rng {
  const root = normaliseSeed(seed);
  return makeRng(seedState(root), root, 0);
}

/* ------------------------------------------------------------------ *
 * Gradient noise — simplex in 2D / 3D / 4D
 * ------------------------------------------------------------------ */

// Gradient sets: the 12 midpoints of a cube's edges (2D/3D) and the 32 midpoints
// of a tesseract's edges (4D). Equal-length vectors mean no directional bias.
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const GRAD4 = new Int8Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
  0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
  1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
  -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
  1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
  -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
  1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
  -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
]);

// Simplex skew/unskew factors: F_n = (sqrt(n+1) - 1) / n, G_n = (1 - 1/sqrt(n+1)) / n.
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;
const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

/**
 * Squared support radius of the surflet attenuation kernel.
 *
 * Perlin's reference implementation uses 0.6 in 3D and 4D. That is a real bug in
 * disguise: at 0.6 the one corner that differs between two adjacent simplices
 * still has a non-zero weight on their shared face, so the field jumps by up to
 * ~5e-3 across every simplex boundary. On screen that bakes into a tile as faint
 * straight creases at a fixed angle. At 0.5 the differing corner sits exactly on
 * the zero of the kernel — and the kernel is quartic, so value *and* gradient
 * vanish there — which makes the field genuinely continuous.
 *
 * The normalisation constants below were then measured against the 0.5 kernel by
 * random search plus hill climbing on |noise|: the raw suprema are 1/70.0 (2D),
 * 1/76.88 (3D) and 1/62.78 (4D), taken here with ~1% headroom so the contract
 * range of [-1, 1] is never breached.
 */
const R2 = 0.5;
const N2_SCALE = 70;
const N3_SCALE = 76;
const N4_SCALE = 62;

// fbm octave rotation: rotating the domain ~28.6° between octaves breaks up the
// axis-aligned pile-up that makes naive fbm look like a plaid weave.
const FBM_ROT_COS = Math.cos(0.5);
const FBM_ROT_SIN = Math.sin(0.5);

/**
 * Real gradient (simplex) noise with a seeded permutation table — not a hash of
 * the coordinates, which is why it stays smooth under magnification and has no
 * visible lattice.
 */
export function createNoise(seed: number): Noise {
  const rng = createRng(seed ^ 0x51ed5eed);
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  const permMod32 = new Uint8Array(512);

  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  // Fisher–Yates with the injected stream: a deterministic, unbiased shuffle.
  for (let i = 255; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  for (let i = 0; i < 512; i++) {
    const v = base[i & 255];
    perm[i] = v;
    permMod12[i] = v % 12;
    permMod32[i] = v % 32;
  }

  function n2(xin: number, yin: number): number {
    // Skew the input onto the triangular lattice, find the containing simplex,
    // then sum three radially attenuated gradient contributions.
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;
    let n = 0;

    let t0 = R2 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const gi = permMod12[ii + perm[jj]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0);
    }
    let t1 = R2 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const gi = permMod12[ii + i1 + perm[jj + j1]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1);
    }
    let t2 = R2 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const gi = permMod12[ii + 1 + perm[jj + 1]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2);
    }
    return N2_SCALE * n;
  }

  function n3(xin: number, yin: number, zin: number): number {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    // Rank the unskewed offsets to pick which of the six tetrahedra we are in.
    let i1: number;
    let j1: number;
    let k1: number;
    let i2: number;
    let j2: number;
    let k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;

    let t0 = R2 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const gi = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0 + GRAD3[gi + 2] * z0);
    }
    let t1 = R2 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const gi = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1 + GRAD3[gi + 2] * z1);
    }
    let t2 = R2 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const gi = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2 + GRAD3[gi + 2] * z2);
    }
    let t3 = R2 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const gi = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[gi] * x3 + GRAD3[gi + 1] * y3 + GRAD3[gi + 2] * z3);
    }
    return N3_SCALE * n;
  }

  function n4(xin: number, yin: number, zin: number, win: number): number {
    const s = (xin + yin + zin + win) * F4;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const l = Math.floor(win + s);
    const t = (i + j + k + l) * G4;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    const w0 = win - (l - t);

    // Rank ordering: six pairwise comparisons give each axis a rank 0–3, which
    // directly yields the four corner offsets without a 64-entry lookup table.
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;

    const i1 = rx >= 3 ? 1 : 0;
    const j1 = ry >= 3 ? 1 : 0;
    const k1 = rz >= 3 ? 1 : 0;
    const l1 = rw >= 3 ? 1 : 0;
    const i2 = rx >= 2 ? 1 : 0;
    const j2 = ry >= 2 ? 1 : 0;
    const k2 = rz >= 2 ? 1 : 0;
    const l2 = rw >= 2 ? 1 : 0;
    const i3 = rx >= 1 ? 1 : 0;
    const j3 = ry >= 1 ? 1 : 0;
    const k3 = rz >= 1 ? 1 : 0;
    const l3 = rw >= 1 ? 1 : 0;

    const x1 = x0 - i1 + G4;
    const y1 = y0 - j1 + G4;
    const z1 = z0 - k1 + G4;
    const w1 = w0 - l1 + G4;
    const x2 = x0 - i2 + 2 * G4;
    const y2 = y0 - j2 + 2 * G4;
    const z2 = z0 - k2 + 2 * G4;
    const w2 = w0 - l2 + 2 * G4;
    const x3 = x0 - i3 + 3 * G4;
    const y3 = y0 - j3 + 3 * G4;
    const z3 = z0 - k3 + 3 * G4;
    const w3 = w0 - l3 + 3 * G4;
    const x4 = x0 - 1 + 4 * G4;
    const y4 = y0 - 1 + 4 * G4;
    const z4 = z0 - 1 + 4 * G4;
    const w4 = w0 - 1 + 4 * G4;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const ll = l & 255;
    let n = 0;

    let t0 = R2 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
    if (t0 > 0) {
      const gi = permMod32[ii + perm[jj + perm[kk + perm[ll]]]] * 4;
      t0 *= t0;
      n += t0 * t0 * (GRAD4[gi] * x0 + GRAD4[gi + 1] * y0 + GRAD4[gi + 2] * z0 + GRAD4[gi + 3] * w0);
    }
    let t1 = R2 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
    if (t1 > 0) {
      const gi = permMod32[ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]]] * 4;
      t1 *= t1;
      n += t1 * t1 * (GRAD4[gi] * x1 + GRAD4[gi + 1] * y1 + GRAD4[gi + 2] * z1 + GRAD4[gi + 3] * w1);
    }
    let t2 = R2 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
    if (t2 > 0) {
      const gi = permMod32[ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]]] * 4;
      t2 *= t2;
      n += t2 * t2 * (GRAD4[gi] * x2 + GRAD4[gi + 1] * y2 + GRAD4[gi + 2] * z2 + GRAD4[gi + 3] * w2);
    }
    let t3 = R2 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
    if (t3 > 0) {
      const gi = permMod32[ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]]] * 4;
      t3 *= t3;
      n += t3 * t3 * (GRAD4[gi] * x3 + GRAD4[gi + 1] * y3 + GRAD4[gi + 2] * z3 + GRAD4[gi + 3] * w3);
    }
    let t4 = R2 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
    if (t4 > 0) {
      const gi = permMod32[ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]]] * 4;
      t4 *= t4;
      n += t4 * t4 * (GRAD4[gi] * x4 + GRAD4[gi + 1] * y4 + GRAD4[gi + 2] * z4 + GRAD4[gi + 3] * w4);
    }
    return N4_SCALE * n;
  }

  function fbm2(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    const count = Math.max(1, Math.min(9, Math.round(octaves)));
    let amplitude = 1;
    let sum = 0;
    let norm = 0;
    let px = x;
    let py = y;
    for (let o = 0; o < count; o++) {
      sum += n2(px, py) * amplitude;
      norm += amplitude;
      amplitude *= gain;
      // Rotate then scale: keeps successive octaves from sharing zero crossings.
      const rx = px * FBM_ROT_COS - py * FBM_ROT_SIN;
      const ry = px * FBM_ROT_SIN + py * FBM_ROT_COS;
      px = rx * lacunarity + 37.1;
      py = ry * lacunarity - 19.7;
    }
    return norm > 0 ? sum / norm : 0;
  }

  function ridged2(x: number, y: number, octaves = 4): number {
    // Ridged multifractal: fold the noise about zero, square the fold to sharpen
    // the crest, and weight each octave by the previous one so detail only
    // appears on existing ridges — the structure that reads as light shafts.
    const count = Math.max(1, Math.min(9, Math.round(octaves)));
    let amplitude = 0.5;
    let frequency = 1;
    let weight = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < count; o++) {
      let signal = 1 - Math.abs(n2(x * frequency + o * 13.3, y * frequency - o * 7.9));
      signal *= signal;
      signal *= weight;
      weight = clamp01(signal * 2);
      sum += signal * amplitude;
      norm += amplitude;
      frequency *= 2;
      amplitude *= 0.5;
    }
    return clamp01(norm > 0 ? sum / norm : 0);
  }

  function tiled2(x: number, y: number, period: number): number {
    // Seamless by construction: map the (x, y) plane onto a Clifford torus in 4D
    // — two orthogonal circles, one per axis — and sample 4D simplex noise there.
    // The flat torus has zero metric distortion, so features keep their shape and
    // the tile matches itself exactly at every edge, for any real period.
    const p = period > 1e-6 ? period : 1;
    // Radius chosen so arc length equals input distance: 2*pi*r / p = 1.
    const r = p / TAU;
    const a = (x / p) * TAU;
    const b = (y / p) * TAU;
    return n4(Math.cos(a) * r, Math.sin(a) * r, Math.cos(b) * r, Math.sin(b) * r);
  }

  return { n2, n3, fbm2, ridged2, tiled2 };
}

/* ------------------------------------------------------------------ *
 * Springs — analytic damped harmonic oscillator
 * ------------------------------------------------------------------ */

/**
 * Damped spring integrated with the **closed-form** solution of
 * `u'' + 2ζω·u' + ω²·u = 0` (u = value − target), which is exact for a constant
 * target and therefore unconditionally stable: a 3-second frame hitch settles
 * the spring instead of detonating it, and no substepping is needed.
 *
 * `damping` is the viscous coefficient c, not the ratio — the damping ratio is
 * `ζ = damping / (2·√(stiffness·mass))`. So `{ stiffness: 180, damping: 22 }`
 * is a snappy ζ ≈ 0.82, and ζ = 1 (no overshoot) is `damping = 2·√(k·m)`.
 */
export function createSpring(config: SpringConfig): Spring {
  const mass = Math.max(1e-4, config.mass ?? 1);
  const stiffness = Math.max(0, config.stiffness);
  const damping = Math.max(0, config.damping);
  const initial = config.initial ?? 0;

  const omega = Math.sqrt(stiffness / mass);
  const zeta = omega > 1e-6 ? damping / (2 * mass * omega) : 0;

  // Integration coefficients for the last dt. Frame times repeat, so caching
  // saves two exp() and two trig calls per spring per frame.
  let cachedDt = -1;
  let posPos = 1;
  let posVel = 0;
  let velPos = 0;
  let velVel = 1;

  function coefficients(dt: number): void {
    if (dt === cachedDt) return;
    cachedDt = dt;

    if (omega < 1e-6) {
      // No restoring force: pure viscous drag, integrated exactly.
      const lambda = damping / mass;
      posPos = 1;
      velPos = 0;
      if (lambda > 1e-6) {
        const e = Math.exp(-lambda * dt);
        posVel = (1 - e) / lambda;
        velVel = e;
      } else {
        posVel = dt;
        velVel = 1;
      }
      return;
    }

    if (zeta > 1 + 1e-4) {
      // Over-damped: two distinct real roots z1, z2 with z1·z2 = ω².
      const za = -omega * zeta;
      const zb = omega * Math.sqrt(zeta * zeta - 1);
      const z1 = za - zb;
      const z2 = za + zb;
      const e1 = Math.exp(z1 * dt);
      const e2 = Math.exp(z2 * dt);
      const invD = 1 / (z1 - z2);
      posPos = (z1 * e2 - z2 * e1) * invD;
      posVel = (e1 - e2) * invD;
      velPos = -omega * omega * posVel;
      velVel = (z1 * e1 - z2 * e2) * invD;
      return;
    }

    if (zeta < 1 - 1e-4) {
      // Under-damped: complex roots −ζω ± i·ωd.
      const decay = Math.exp(-zeta * omega * dt);
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      const sOverWd = s / wd;
      posPos = decay * (c + zeta * omega * sOverWd);
      posVel = decay * sOverWd;
      velPos = -decay * omega * omega * sOverWd;
      velVel = decay * (c - zeta * omega * sOverWd);
      return;
    }

    // Critically damped: repeated root −ω, limit of both branches above.
    const e = Math.exp(-omega * dt);
    posPos = e * (1 + omega * dt);
    posVel = e * dt;
    velPos = -omega * omega * dt * e;
    velVel = e * (1 - omega * dt);
  }

  const spring: Spring = {
    value: initial,
    velocity: 0,
    target: initial,
    set(target: number): void {
      spring.target = target;
    },
    snap(value: number): void {
      spring.value = value;
      spring.target = value;
      spring.velocity = 0;
    },
    impulse(velocity: number): void {
      spring.velocity += velocity;
    },
    update(dt: number): number {
      if (!(dt > 0) || !Number.isFinite(dt)) return spring.value;
      coefficients(dt);
      const u0 = spring.value - spring.target;
      const v0 = spring.velocity;
      spring.value = spring.target + posPos * u0 + posVel * v0;
      spring.velocity = velPos * u0 + velVel * v0;
      // Snap out of the exponential tail so springs genuinely come to rest and
      // consumers can skip work on a settled value.
      const scaleRef = Math.max(1, Math.abs(spring.target));
      if (
        Math.abs(spring.value - spring.target) < 1e-5 * scaleRef &&
        Math.abs(spring.velocity) < 1e-4 * scaleRef
      ) {
        spring.value = spring.target;
        spring.velocity = 0;
      }
      return spring.value;
    },
  };
  return spring;
}

/* ------------------------------------------------------------------ *
 * Camera — trauma shake, directional punch, zoom
 * ------------------------------------------------------------------ */

/**
 * Peak displacement produced by a unit velocity impulse on a spring at rest.
 * Lets `addImpulse`/`addZoom` take the peak they want in real units instead of
 * a hand-tuned magic velocity.
 *
 * Under-damped: x(t) = (v₀/ωd)·e^(−ζωt)·sin(ωd·t). Setting x'(t) = 0 gives
 * tan(ωd·t) = ωd/(ζω), so the peak lands at t = θ/ωd with θ = atan2(ωd, ζω) and
 * measures e^(−ζω·θ/ωd)·sin(θ)/ωd per unit of impulse. (ζ → 0 collapses to the
 * expected 1/ω.) At ζ ≥ 1 the peak of v₀·t·e^(−ωt) sits at t = 1/ω.
 */
function impulsePeak(stiffness: number, damping: number, mass: number): number {
  const w = Math.sqrt(stiffness / mass);
  const z = damping / (2 * Math.sqrt(stiffness * mass));
  if (z >= 1) return 1 / (w * Math.E);
  const wd = w * Math.sqrt(1 - z * z);
  const theta = Math.atan2(wd, z * w);
  return (Math.exp((-z * w * theta) / wd) * Math.sin(theta)) / wd;
}

const PUNCH_K = 420;
const PUNCH_C = 26;
const ZOOM_K = 300;
const ZOOM_C = 20;

/** Maximum shake translation, in logical pixels, at trauma = 1. */
const SHAKE_MAX_OFFSET = 26;
/** Maximum shake roll, in radians, at trauma = 1 (~1.5°). */
const SHAKE_MAX_ROLL = 0.026;
const TRAUMA_DECAY = 1.2;

/**
 * Trauma-model camera (Jonas Gomes / Squirrel Eiserloh): callers add trauma,
 * shake is trauma² so it falls off perceptually rather than linearly, and the
 * displacement comes from continuous gradient noise, not per-frame randoms.
 *
 * White-noise shake reads as a vibrating motor; this samples three decorrelated
 * noise slices whose frequency rises with severity, layers a slow drift under
 * them, and biases the rattle along the last impulse axis, so it reads as an
 * operator being knocked rather than a broken mount.
 *
 * At rest (no trauma, no impulses) the transform is exactly identity, which is
 * how reduced-motion callers opt out: simply stop feeding it trauma.
 */
export function createCamera(): Camera {
  const noise = createNoise(0x0c0ffee);
  const punchX = createSpring({ stiffness: PUNCH_K, damping: PUNCH_C, mass: 1 });
  const punchY = createSpring({ stiffness: PUNCH_K, damping: PUNCH_C, mass: 1 });
  const zoomSpring = createSpring({ stiffness: ZOOM_K, damping: ZOOM_C, mass: 1 });

  const punchGain = 1 / impulsePeak(PUNCH_K, PUNCH_C, 1);
  const zoomGain = 1 / impulsePeak(ZOOM_K, ZOOM_C, 1);

  const offset: Vec2 = { x: 0, y: 0 };
  let rotation = 0;
  let trauma = 0;
  // Phase accumulators, not raw time: integrating phase means the frequency can
  // change with trauma without the waveform jumping.
  let shakePhase = 0;
  let driftPhase = 0;
  // Unit vector of the most recent impulse, used to bias the rattle direction.
  let axisX = 0;
  let axisY = 0;

  const camera: Camera = {
    addTrauma(amount: number): void {
      if (!(amount > 0)) return;
      // Union of independent probabilities: stacked hits saturate toward 1
      // instead of clipping the moment two impacts land in the same frame.
      const a = clamp01(amount);
      trauma = clamp01(1 - (1 - trauma) * (1 - a));
    },
    addImpulse(x: number, y: number): void {
      // x/y are the desired peak offset in logical pixels.
      if (Number.isFinite(x)) punchX.impulse(x * punchGain);
      if (Number.isFinite(y)) punchY.impulse(y * punchGain);
      const l = Math.sqrt(x * x + y * y);
      if (l > 1e-4) {
        axisX = x / l;
        axisY = y / l;
      }
    },
    addZoom(amount: number): void {
      if (Number.isFinite(amount)) zoomSpring.impulse(amount * zoomGain);
    },
    update(dt: number): void {
      // Feed this raw (unscaled) dt: a hit-stop should freeze the world, not the
      // camera reacting to the hit that caused it.
      const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      trauma = Math.max(0, trauma - TRAUMA_DECAY * step);

      punchX.update(step);
      punchY.update(step);
      zoomSpring.update(step);

      const shake = trauma * trauma;
      if (shake > 1e-5) {
        // Rattle speeds up with severity: a big hit cracks, a small one wobbles.
        // Capped so the dominant motion stays near 4–7 Hz — fast enough to read
        // as an impact, slow enough that a 60 Hz sample of it is still a curve
        // rather than per-frame hash.
        const frequency = 5.5 + 9 * shake;
        shakePhase += step * frequency;
        driftPhase += step * 1.6;

        const amp = SHAKE_MAX_OFFSET * shake;
        const jitterX = noise.n2(shakePhase, 0);
        const jitterY = noise.n2(shakePhase * 1.13, 31.7);
        const jitterR = noise.n2(shakePhase * 0.91, 67.3);
        const driftX = noise.n2(driftPhase, 101.5);
        const driftY = noise.n2(driftPhase * 0.87, 149.9);
        const axisJitter = noise.n2(shakePhase * 1.37, 211.3);

        // Weights sum to 1 so the envelope stays inside SHAKE_MAX_OFFSET.
        const sx = jitterX * 0.62 + driftX * 0.2 + axisX * axisJitter * 0.18;
        const sy = jitterY * 0.62 + driftY * 0.2 + axisY * axisJitter * 0.18;

        offset.x = sx * amp;
        // Operators brace vertically far better than horizontally.
        offset.y = sy * amp * 0.72;
        rotation = jitterR * SHAKE_MAX_ROLL * shake;
      } else {
        // Phases are never rewound: each new impact resumes from a different
        // slice of the noise field, so repeated hits never rattle identically.
        offset.x = 0;
        offset.y = 0;
        rotation = 0;
      }

      offset.x += punchX.value;
      offset.y += punchY.value;
      // A lateral punch also rolls the rig slightly — a body-mounted camera
      // pivots around the operator, it does not slide on rails.
      rotation += punchX.value * 0.00035;
    },
    get offset(): Vec2 {
      return offset;
    },
    get rotation(): number {
      return rotation;
    },
    get zoom(): number {
      return 1 + zoomSpring.value;
    },
    get trauma(): number {
      return trauma;
    },
    apply(context: CanvasRenderingContext2D, width: number, height: number): void {
      if (width <= 0 || height <= 0) return;
      const rot = rotation;
      const zoom = 1 + zoomSpring.value;
      // Minimum uniform scale that keeps the rotated, translated frame covering
      // the viewport — without it, shake reveals bare canvas at the edges.
      const c = Math.abs(Math.cos(rot));
      const s = Math.abs(Math.sin(rot));
      const cover =
        Math.max((width * c + height * s) / width, (width * s + height * c) / height) +
        2 * Math.max(Math.abs(offset.x) / width, Math.abs(offset.y) / height);
      // A zoom below 1 is reported on `.zoom` for callers that want parallax,
      // but never applied here: opening gaps at the frame edge is not a look.
      const scale = Math.max(zoom, 1) * cover;

      context.translate(width * 0.5 + offset.x, height * 0.5 + offset.y);
      if (rot !== 0) context.rotate(rot);
      if (scale !== 1) context.scale(scale, scale);
      context.translate(-width * 0.5, -height * 0.5);
    },
    reset(): void {
      trauma = 0;
      rotation = 0;
      offset.x = 0;
      offset.y = 0;
      shakePhase = 0;
      driftPhase = 0;
      axisX = 0;
      axisY = 0;
      punchX.snap(0);
      punchY.snap(0);
      zoomSpring.snap(0);
    },
  };
  return camera;
}

/* ------------------------------------------------------------------ *
 * Clock — hit-stop, slow motion, scaled and unscaled time
 * ------------------------------------------------------------------ */

/** Longest raw frame the simulation will accept, so a tab-return cannot teleport it. */
const MAX_FRAME = 0.1;
/** Longest smear back to full speed at the end of a hit-stop. */
const HITSTOP_TAIL = 0.045;
const SLOW_RAMP_IN = 0.07;
const SLOW_RAMP_OUT = 0.42;

/**
 * The single time authority.
 *
 * Hit-stop and slow motion **compose multiplicatively** rather than overwrite:
 * a hit landing during a slow-motion beat freezes completely and then returns to
 * the slow-motion rate, not to full speed. Hit-stop takes the longest pending
 * freeze (repeated hits do not accumulate into a lock-up); slow motion keeps
 * whichever request deviates furthest from real time and extends to the longest
 * hold, then eases out on its own curve.
 */
export function createClock(): Clock {
  let dt = 0;
  let rawDt = 0;
  let time = 0;
  let rawTime = 0;
  let scale = 1;

  let hitStopRemaining = 0;
  let hitStopTail = HITSTOP_TAIL;

  // Slow motion is a single 0–1 ramp parameter driving a lerp toward the target
  // scale; ramping the parameter (not the scale) makes overlapping requests
  // continuous — a new call simply reverses the ramp from wherever it stands.
  let slowTarget = 1;
  let slowRamp = 0;
  let slowHold = 0;

  const clock: Clock = {
    get dt(): number {
      return dt;
    },
    get rawDt(): number {
      return rawDt;
    },
    get time(): number {
      return time;
    },
    get rawTime(): number {
      return rawTime;
    },
    get scale(): number {
      return scale;
    },
    hitStop(seconds: number): void {
      if (!(seconds > 0) || !Number.isFinite(seconds)) return;
      hitStopRemaining = Math.max(hitStopRemaining, seconds);
      hitStopTail = Math.min(HITSTOP_TAIL, hitStopRemaining * 0.4);
    },
    slowMotion(targetScale: number, seconds: number): void {
      if (!Number.isFinite(targetScale) || !Number.isFinite(seconds)) return;
      const requested = clamp(targetScale, 0.02, 4);
      const hold = Math.max(0, seconds);
      if (slowRamp > 0 || slowHold > 0) {
        // "Most extreme wins", measured in log space so a 0.25× slowdown and a
        // 4× speed-up are treated as equally strong deviations from real time.
        if (Math.abs(Math.log(requested)) > Math.abs(Math.log(slowTarget))) slowTarget = requested;
        slowHold = Math.max(slowHold, hold);
      } else {
        slowTarget = requested;
        slowHold = hold;
      }
    },
    tick(rawDeltaSeconds: number): void {
      const raw = Number.isFinite(rawDeltaSeconds) ? clamp(rawDeltaSeconds, 0, MAX_FRAME) : 0;
      rawDt = raw;
      rawTime += raw;

      // Hit-stop: hard freeze, then a short eased smear back to full rate so the
      // resume lands as a punch rather than a stutter.
      let hitFactor = 1;
      if (hitStopRemaining > 0) {
        hitStopRemaining = Math.max(0, hitStopRemaining - raw);
        hitFactor =
          hitStopRemaining <= 0 || hitStopTail <= 0
            ? 1
            : 1 - smoothstep(0, hitStopTail, hitStopRemaining);
      }

      // Slow motion: linear ramp parameter, eased curve, symmetric in and out.
      if (slowHold > 0) {
        slowHold = Math.max(0, slowHold - raw);
        slowRamp = Math.min(1, slowRamp + raw / SLOW_RAMP_IN);
      } else if (slowRamp > 0) {
        slowRamp = Math.max(0, slowRamp - raw / SLOW_RAMP_OUT);
        if (slowRamp === 0) slowTarget = 1;
      }
      const slowFactor = lerp(1, slowTarget, ease.inOutSine(slowRamp));

      scale = clamp(hitFactor * slowFactor, 0, 4);
      dt = raw * scale;
      time += dt;
    },
  };
  return clock;
}
