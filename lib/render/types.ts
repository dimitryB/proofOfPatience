/**
 * Shared contract for the POP presentation layer.
 *
 * This file is the integration spine: every engine and render module depends on
 * it, and nothing here may be changed without updating every consumer. Modules
 * own their own files and never reach into each other's internals — they talk
 * exclusively through the types below.
 *
 * Art direction: cinematic broadcast realism. A real television studio shot on a
 * cine lens — volumetric key lights, haze, physically plausible materials, lens
 * bloom and chromatic aberration, fine grain. Hemi orange (#ff4600) is the only
 * saturated hue; everything else lives in warm neutrals and deep charcoal.
 */

import type { QuestionKind } from "../pop";

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export interface Vec2 {
  x: number;
  y: number;
}

export type QualityTier = "low" | "medium" | "high" | "ultra";

/** Deterministic random source. Never call Math.random in render code. */
export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** −1 or 1. */
  sign(): number;
  pick<T>(items: readonly T[]): T;
  /** Independent child stream, so one consumer cannot desync another. */
  fork(salt?: number): Rng;
}

export interface Noise {
  /** Simplex-style value noise in [−1, 1]. */
  n2(x: number, y: number): number;
  n3(x: number, y: number, z: number): number;
  /** Fractal brownian motion in roughly [−1, 1]. */
  fbm2(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Ridged multifractal in [0, 1]; good for light shafts and smoke. */
  ridged2(x: number, y: number, octaves?: number): number;
  /** Seamless tiling noise over a period, for baked textures. */
  tiled2(x: number, y: number, period: number): number;
}

/* ------------------------------------------------------------------ *
 * Texture bakery — procedural, baked once, cached forever
 * ------------------------------------------------------------------ */

/**
 * Ids every bakery must be able to produce. Sprites are premultiplied-safe
 * white/alpha art meant to be tinted with globalCompositeOperation; tiles are
 * seamless and safe to use as CanvasPattern with "repeat".
 */
export type TextureId =
  // seamless tiles
  | "noise-fine"
  | "noise-coarse"
  | "grunge"
  | "brushed-metal"
  | "concrete"
  | "acoustic-fabric"
  | "carbon-weave"
  | "dust-motes"
  // sprites (white on transparent, radially or directionally shaped)
  | "spark"
  | "bokeh"
  | "smoke"
  | "streak"
  | "ring"
  | "flare"
  | "star-flare"
  | "shard"
  | "ember"
  | "glow"
  // full-frame overlays
  | "vignette"
  | "lens-scratches"
  | "lens-dirt";

export interface TextureBakery {
  /** Baked canvas for an id. Bakes on first call, then returns the cache. */
  get(id: TextureId): CanvasImageSource;
  /** Cached repeating pattern for a tile id. */
  pattern(context: CanvasRenderingContext2D, id: TextureId, repeat?: string): CanvasPattern;
  /** Pixel size of a baked texture. */
  size(id: TextureId): number;
  /** Bakes everything up front so the first frame never stalls. */
  warm(): void;
}

/* ------------------------------------------------------------------ *
 * Motion helpers
 * ------------------------------------------------------------------ */

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
  initial?: number;
}

export interface Spring {
  value: number;
  velocity: number;
  target: number;
  set(target: number): void;
  /** Jump to a value with no velocity. */
  snap(value: number): void;
  /** Add an instantaneous velocity impulse — used for punchy UI reactions. */
  impulse(velocity: number): void;
  update(dt: number): number;
}

/** Trauma-based camera shake (Jonas Gomes model): shake = trauma². */
export interface Camera {
  /** Adds trauma in [0, 1]; saturates rather than stacking linearly. */
  addTrauma(amount: number): void;
  /** Punch the camera in a direction — used for recoil and impacts. */
  addImpulse(x: number, y: number): void;
  /** Zoom punch, 1 = neutral. */
  addZoom(amount: number): void;
  update(dt: number): void;
  readonly offset: Vec2;
  readonly rotation: number;
  readonly zoom: number;
  readonly trauma: number;
  /** Applies transform to a 2D context around the given pivot. */
  apply(context: CanvasRenderingContext2D, width: number, height: number): void;
  reset(): void;
}

/** Global time authority: hit-stop, slow motion and unscaled time all live here. */
export interface Clock {
  /** Scaled delta the simulation should use. */
  readonly dt: number;
  /** Real delta, for UI and effects that must never freeze. */
  readonly rawDt: number;
  /** Accumulated scaled seconds. */
  readonly time: number;
  /** Accumulated unscaled seconds. */
  readonly rawTime: number;
  /** Current multiplier (hit-stop and slow-mo combined). */
  readonly scale: number;
  /** Freeze frames on impact. Seconds of real time. */
  hitStop(seconds: number): void;
  /** Ramped slow motion: target scale held for a duration, then eased back. */
  slowMotion(scale: number, seconds: number): void;
  tick(rawDeltaSeconds: number): void;
}

/* ------------------------------------------------------------------ *
 * Particles, ribbons, ropes
 * ------------------------------------------------------------------ */

export type ParticlePreset =
  | "impact-spark"
  | "impact-ring"
  | "letter-debris"
  | "answer-burst"
  | "confetti"
  | "smoke-puff"
  | "dust-kick"
  | "ember"
  | "glass-shard"
  | "paper-shred"
  | "muzzle-flash"
  | "shockwave"
  | "ambient-dust"
  | "crowd-flash"
  | "screen-static";

export interface EmitOptions {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  count?: number;
  /** Primary tint, CSS colour. */
  color?: string;
  /** Secondary tint; particles lerp between the two over life. */
  color2?: string;
  speed?: number;
  speedVariance?: number;
  /** Emission direction in radians. */
  angle?: number;
  /** Full cone width in radians. */
  spread?: number;
  scale?: number;
  life?: number;
  gravity?: number;
  drag?: number;
  /** Draw behind entities instead of in front. */
  behind?: boolean;
  /** Additive blending; default true for sparks, false for debris. */
  additive?: boolean;
}

export interface ParticleSystem {
  emit(preset: ParticlePreset, options: EmitOptions): void;
  update(dt: number): void;
  /** Draws one layer. Call "behind" before entities, "front" after. */
  draw(context: CanvasRenderingContext2D, layer: "behind" | "front"): void;
  clear(): void;
  readonly count: number;
  readonly capacity: number;
}

export interface Ribbon {
  push(x: number, y: number): void;
  update(dt: number): void;
  draw(
    context: CanvasRenderingContext2D,
    options: { width: number; color: string; fade?: number; additive?: boolean },
  ): void;
  clear(): void;
  readonly length: number;
}

/** Verlet rope used for the microphone cable and hanging studio cables. */
export interface Rope {
  readonly points: { x: number; y: number; px: number; py: number; pinned: boolean }[];
  update(dt: number, gravity: number, iterations?: number): void;
  /** Move the free end, e.g. to follow the mic. */
  setEnd(x: number, y: number): void;
  draw(
    context: CanvasRenderingContext2D,
    options: { width: number; color: string; highlight?: string },
  ): void;
}

/* ------------------------------------------------------------------ *
 * Post-processing
 * ------------------------------------------------------------------ */

export interface PostParams {
  /** 0 disables the bloom pass entirely. */
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  /** Lateral chromatic aberration in pixels at the frame edge. */
  chroma: number;
  vignette: number;
  grain: number;
  /** Broadcast scanline visibility, 0–1. */
  scanline: number;
  /** Lens barrel distortion, 0 = rectilinear. */
  barrel: number;
  exposure: number;
  contrast: number;
  saturation: number;
  /** Warm/cool grade shift, −1 cool to 1 warm. */
  temperature: number;
  /** Full-frame flash: colour blended additively by amount. */
  flashAmount: number;
  flashColor: [number, number, number];
  /** Analogue tape/RGB-split glitch, 0–1. Used on damage. */
  glitch: number;
  /** Radial motion blur toward the centre, 0–1. Used on POP OFF. */
  radialBlur: number;
}

export interface PostChain {
  /** False when WebGL2 is unavailable; callers must fall back to a direct blit. */
  readonly available: boolean;
  /** The canvas that must be shown to the user. */
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number, dpr: number): void;
  render(source: CanvasImageSource, params: PostParams, timeSeconds: number): void;
  setQuality(tier: QualityTier): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

export type SfxId =
  | "fire"
  | "hit"
  | "hit-wrong"
  | "answer"
  | "answer-big"
  | "land"
  | "pop"
  | "combo-up"
  | "slowmo-in"
  | "slowmo-out"
  | "warning"
  | "countdown"
  | "ui-hover"
  | "ui-click"
  | "ui-open"
  | "ui-close"
  | "crowd-murmur"
  | "crowd-cheer"
  | "crowd-groan"
  | "round-start"
  | "round-win"
  | "round-lose"
  | "tick";

export interface AudioEngine {
  /** Must be called from a user gesture before anything is audible. */
  unlock(): void;
  play(id: SfxId, options?: { gain?: number; rate?: number; pan?: number; delay?: number }): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  /** Adaptive score intensity, 0–1. Drives layer count and filter cutoff. */
  setIntensity(value: number): void;
  startMusic(): void;
  stopMusic(): void;
  /** Sidechain duck for emphasis moments. */
  duck(amount: number, seconds: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ *
 * Scene contract — what renderers may read
 * ------------------------------------------------------------------ */

export type ScenePhase = "idle" | "playing" | "won" | "lost";

/** Everything a render module is allowed to know about the game this frame. */
export interface SceneContext {
  /** Scaled seconds since the scene was created. */
  time: number;
  /** Unscaled seconds; use for effects that must not freeze during hit-stop. */
  rawTime: number;
  dt: number;
  rawDt: number;
  phase: ScenePhase;
  /** Round seconds elapsed. */
  elapsed: number;
  /** Round progress 0–1. */
  progress: number;
  /** Composite pressure 0–1 from backlog, density and time. Drives lighting. */
  intensity: number;
  combo: number;
  backlog: number;
  maxBacklog: number;
  /** 0 = normal speed, 1 = fully slowed chat. */
  slow: number;
  /** 0–1 white/orange flash. */
  flash: number;
  width: number;
  height: number;
  /** Y coordinate of the studio floor line. */
  stageY: number;
  quality: QualityTier;
  reducedMotion: boolean;
  /** Ambient key light colour temperature drift, 0–1. */
  mood: number;
}

/** A caller card as the renderer sees it. */
export interface QuestionView {
  id: number;
  kind: QuestionKind;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  /** Letters already answered on this card. */
  progress: number;
  /** Total letters required. */
  total: number;
  /** True when the card's next letter matches loaded ammo. */
  targeted: boolean;
  /** 0–1, how close to the floor. Drives red-alert treatment. */
  danger: number;
  /** Card rotation in radians from its own physics. */
  rotation: number;
  /** Non-uniform squash from impacts: 1 = rest. */
  scaleX: number;
  scaleY: number;
  /** Seconds since spawn, for entry animation. */
  age: number;
  /** Seconds since last hit; drives the flash decay. */
  sinceHit: number;
}

export interface ShotView {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  letter: string;
  age: number;
}

export interface DeskView {
  x: number;
  y: number;
  /** Aim angle in radians. */
  aim: number;
  /** 0–1 recoil amount, decays after firing. */
  recoil: number;
  /** Currently loaded letter. */
  letter: string;
  /** 0–1 charge/readiness of the fire control. */
  charge: number;
}

/* ------------------------------------------------------------------ *
 * Render modules
 * ------------------------------------------------------------------ */

/** Injected once at boot and shared by every render module. */
export interface RenderDeps {
  rng: Rng;
  noise: Noise;
  bakery: TextureBakery;
  particles: ParticleSystem;
  camera: Camera;
  audio: AudioEngine;
}

export interface StudioRenderer {
  resize(width: number, height: number): void;
  update(scene: SceneContext): void;
  /** Set, lighting, haze, crowd — everything behind the play field. */
  drawBackground(context: CanvasRenderingContext2D, scene: SceneContext): void;
  /** Foreground haze, light shafts, floor contact shadows, lens dirt. */
  drawForeground(context: CanvasRenderingContext2D, scene: SceneContext): void;
  /** Called when a question hits the floor, so the set can react. */
  onImpact(x: number, y: number, force: number): void;
}

export interface QuestionRenderer {
  update(questions: readonly QuestionView[], scene: SceneContext): void;
  draw(context: CanvasRenderingContext2D, questions: readonly QuestionView[], scene: SceneContext): void;
  /** Contact shadow pass, drawn before the cards. */
  drawShadows(context: CanvasRenderingContext2D, questions: readonly QuestionView[], scene: SceneContext): void;
}

export interface DeskRenderer {
  update(desk: DeskView, scene: SceneContext): void;
  draw(context: CanvasRenderingContext2D, desk: DeskView, scene: SceneContext): void;
  /** Aim guide and reticle, drawn under the cards. */
  drawAimGuide(
    context: CanvasRenderingContext2D,
    desk: DeskView,
    scene: SceneContext,
    target: QuestionView | null,
  ): void;
  onFire(desk: DeskView): void;
}

export interface EffectsRenderer {
  update(scene: SceneContext): void;
  drawShots(context: CanvasRenderingContext2D, shots: readonly ShotView[], scene: SceneContext): void;
  /** Rings, shockwaves and score popups above everything else. */
  drawOverlayEffects(context: CanvasRenderingContext2D, scene: SceneContext): void;
  /** Correct-letter impact. */
  onHit(x: number, y: number, color: string, letter: string): void;
  /** Wrong-letter impact. */
  onReject(x: number, y: number, requiredLetter: string): void;
  /** A card was fully answered. */
  onAnswer(x: number, y: number, color: string, value: number, combo: number): void;
  /** A card reached the floor. */
  onLand(x: number, y: number): void;
  onPopOff(cleared: number): void;
  /** Floating score/label popup. */
  popup(x: number, y: number, text: string, color?: string, size?: number): void;
}

export interface OverlayRenderer {
  update(scene: SceneContext): void;
  /** Broadcast furniture drawn inside the canvas: lower third, ticker, timers. */
  draw(context: CanvasRenderingContext2D, scene: SceneContext, state: OverlayState): void;
  announce(text: string, tone?: "info" | "good" | "bad" | "alert", seconds?: number): void;
}

export interface OverlayState {
  announcement: string;
  announcementTone: "info" | "good" | "bad" | "alert";
  announcementAge: number;
  score: number;
  combo: number;
  comboTier: string;
  timeRemaining: number;
  activeQuestions: number;
  slowSeconds: number;
  difficultyLabel: string;
}
