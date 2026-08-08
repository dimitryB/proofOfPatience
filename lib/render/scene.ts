/**
 * Composition root for the POP presentation layer.
 *
 * This is the only file that knows about *all* of the engine and render
 * modules at once. It owns the deterministic random source, the noise field,
 * the texture bakery, the particle pool, the camera, the clock, the audio
 * engine, the post chain and the five render modules, and it wires them
 * together through a single `RenderDeps` bag.
 *
 * Responsibilities, in order of importance:
 *
 *  1. **Adaptation.** The game loop hands over raw-ish game state
 *     (`SceneFrame`); everything the renderers are allowed to see —
 *     `SceneContext`, `QuestionView[]`, `ShotView[]`, `DeskView`,
 *     `OverlayState` — is derived here, never in the React component.
 *  2. **Feel.** Semantic events (`onFire`, `onHit`, `onAnswer`, `onLand`,
 *     `onPopOff`) are translated into hit-stop, camera trauma, directional
 *     impulses, zoom punches, card knockback, particles and audio. The
 *     simulation says *what happened*; this file decides *how it lands*.
 *  3. **Presentation.** The whole scene is drawn into an offscreen 2D canvas at
 *     logical resolution scaled by DPR, then handed to the post chain, which
 *     presents into the visible canvas. When WebGL2 is unavailable the frame is
 *     blitted directly and a cheap 2D vignette + grain keeps the look
 *     deliberate rather than flat.
 *
 * Hard rules honoured here: no `Math.random` (everything draws from the
 * injected `Rng`), no `window`/`document` access at module scope, nothing
 * heavy allocated per frame (every view object, array and params bag is
 * pooled and mutated in place), and `quality` / `reducedMotion` are respected
 * end to end.
 */

import {
  clamp,
  clamp01,
  createCamera,
  createClock,
  createNoise,
  createRng,
  createSpring,
  damp,
  lerp,
  smoothstep,
} from "../engine/core";
import { createAudioEngine, type AudioMixState, type MixerAudioEngine } from "../engine/audio";
import { createParticleSystem } from "../engine/fx";
import {
  createPostChain,
  defaultPostParams,
  flashFalloff,
  type PopPostParams,
} from "../engine/postfx";
import { createTextureBakery } from "../engine/textures";
import { createDeskRenderer } from "./desk";
import { createEffectsRenderer } from "./effects";
import { createOverlayRenderer } from "./overlay";
import { createQuestionRenderer } from "./question";
import { createStudio } from "./studio";
import {
  DESK_X,
  DESK_Y,
  GAME_HEIGHT,
  GAME_WIDTH,
  LETTERS,
  MAX_BACKLOG,
  ROUND_SECONDS,
  STAGE_Y,
  assistedAimAngle,
  difficultyAt,
  expectedLetter,
  patienceTier,
  traceShot,
  type QuestionKind,
} from "../pop";
import type {
  Camera,
  Clock,
  DeskView,
  OverlayState,
  PostChain,
  QualityTier,
  QuestionView,
  ScenePhase,
  SceneContext,
  ShotView,
  SfxId,
} from "./types";

/* ------------------------------------------------------------------ *
 * Public shapes
 * ------------------------------------------------------------------ */

/** A caller card exactly as the simulation stores it. */
export interface SceneQuestionInput {
  id: number;
  kind: QuestionKind;
  label: string;
  /** Simulation-space centre. Visual knockback is added on top, here. */
  x: number;
  y: number;
  width: number;
  height?: number;
  color: string;
  /** Letters already answered. */
  progress: number;
  /** Letters required in total (words × 4). */
  total: number;
  /** Seconds since the card spawned. */
  age: number;
  /** Seconds since the card was last struck; large when never struck. */
  sinceHit: number;
}

/** A letter in flight, as the simulation stores it. */
export interface SceneShotInput {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  letter: string;
  age: number;
}

/**
 * The adapter shape. Everything here is plain game state — no view maths, no
 * renderer vocabulary. `render()` converts it into the render contract.
 */
export interface SceneFrame {
  phase: ScenePhase;
  /** Round seconds elapsed. */
  elapsed: number;
  score: number;
  combo: number;
  backlog: number;
  answered: number;
  /** POP-o-Meter, 0–100. */
  popMeter: number;
  /** Seconds of chat slow-mode left, 0 when inactive. */
  slowSeconds: number;
  /** Host mic aim in radians. */
  aim: number;
  /** Currently loaded letter. */
  ammoLetter: string;
  /**
   * Seconds left on the fire cooldown. Kept on the frame because the adapter is
   * the game's whole story, but deliberately *not* wired to the desk charge
   * ring: at 60 ms it is invisible, and the ring shows POP readiness instead.
   */
  cooldown: number;
  questions: readonly SceneQuestionInput[];
  shots: readonly SceneShotInput[];
  announcement: string;
  /** Seconds since the announcement was raised; a reset re-fires the banner. */
  announcementAge: number;
  difficultyLabel: string;
}

export interface SceneOptions {
  /** The visible canvas. The post chain presents into it. */
  canvas: HTMLCanvasElement;
  seed?: number;
  quality?: QualityTier;
  /** Overrides the `prefers-reduced-motion` media query when set. */
  reducedMotion?: boolean;
  muted?: boolean;
  /** Measure frame cost and step quality down on weak machines. Default true. */
  autoQuality?: boolean;
  /**
   * Hard ceiling on the *presentation* device pixel ratio. Defaults to 2, or 1
   * when a software rasteriser is detected. The offscreen scene canvas is
   * unaffected, so a capped present still receives a supersampled frame.
   */
  maxPresentDpr?: number;
  /**
   * `"auto"` (default) runs the WebGL2 post chain on a real GPU and the 2D
   * fallback on a software rasteriser, where a fifteen-pass chain costs
   * seconds per frame. `"gpu"` forces the chain on, `"off"` forces it off.
   */
  postProcessing?: "auto" | "gpu" | "off";
  /** Restored mixer position. Defaults to everything on at full level. */
  mix?: AudioMixState;
}

export type AnnounceTone = "info" | "good" | "bad" | "alert";

export interface Scene {
  /** Logical CSS size of the canvas and the device pixel ratio to render at. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  /**
   * Advances the time authority by one real frame and returns the *scaled*
   * delta the simulation should consume. Hit-stop and slow motion are applied
   * here, so a fixed-step accumulator fed with this value freezes and ramps
   * with no further work.
   */
  tick(rawDeltaSeconds: number): number;
  /** Draws one frame from the adapter shape. */
  render(frame: SceneFrame): void;

  /* --- semantic events: the simulation says what happened ---------- */
  onFire(x: number, y: number, aim: number, letter: string): void;
  onHit(event: SceneHitEvent): void;
  onReject(x: number, y: number, requiredLetter: string, cardId: number): void;
  onAnswer(event: SceneAnswerEvent): void;
  onLand(x: number, y: number, label: string): void;
  onPopOff(cleared: number, cards: readonly SceneQuestionInput[]): void;
  onImpact(x: number, y: number, force: number): void;
  announce(text: string, tone?: AnnounceTone, seconds?: number): void;
  popup(x: number, y: number, text: string, color?: string, size?: number): void;

  /* --- configuration ----------------------------------------------- */
  setQuality(tier: QualityTier): void;
  setReducedMotion(reduced: boolean): void;
  setMuted(muted: boolean): void;
  unlockAudio(): void;
  dispose(): void;

  readonly quality: QualityTier;
  readonly reducedMotion: boolean;
  /** True when the WebGL2 post chain is presenting; false on the 2D fallback. */
  readonly postProcessing: boolean;
  readonly clock: Clock;
  readonly camera: Camera;
  /**
   * The mixer surface, not the narrow engine: the app drives per-bus
   * switches and levels through it. `createAudioEngine` already returns a
   * `MixerAudioEngine`; narrowing it here would hide the mixer from callers.
   */
  readonly audio: MixerAudioEngine;
}

export interface SceneHitEvent {
  x: number;
  y: number;
  color: string;
  letter: string;
  cardId: number;
  /** Shot travel direction, used for knockback and the camera impulse. */
  dirX: number;
  dirY: number;
  /** True when this letter completed a full SOON on a multi-word card. */
  wordComplete: boolean;
  /** True when this letter completed the whole card. */
  cardComplete: boolean;
  /** Words remaining after this hit; 0 means the card is done. */
  wordsLeft: number;
  /** Total SOONs this card requires; >1 earns the slow-motion payoff beat. */
  words: number;
}

export interface SceneAnswerEvent {
  x: number;
  y: number;
  color: string;
  value: number;
  combo: number;
  cardId: number;
  words: number;
  /** No wrong letters and no landings since the last answer. */
  perfect: boolean;
  /** Bonus awarded for the perfect chain, 0 when none. */
  perfectBonus: number;
}

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

const HEMI = "#ff4600";
const HEMI_HOT = "#ff2a00";
const BONE = "#efe7e0";

/** Hit-stop lengths in seconds of real time. */
const STOP_LETTER = 0.045;
const STOP_WORD = 0.062;
const STOP_CARD = 0.09;
const STOP_LAND = 0.1;
const STOP_POP = 0.16;

/** Frame-cost budget for the auto-quality governor, in milliseconds. */
const FRAME_BUDGET_MS = 13;
const GOVERNOR_WINDOW = 2;
const GOVERNOR_MAX_STEPS = 2;

/* ------------------------------------------------------------------ *
 * Boot budget
 *
 * Twenty-one procedural textures and twenty-odd offscreen studio layers cannot
 * be built on the frame the player first sees: measured on a software
 * rasteriser that was eleven seconds in one call. So the boot is *pumped* — a
 * few milliseconds of construction per frame, in dependency order (textures
 * first, because the set bakes sample them), while the studio holds a broadcast
 * standby card over the frame and reveals the set group by group behind it.
 *
 * The budget is deliberately below a 60 Hz frame: at 6 ms the rest of the frame
 * still has ~10 ms, and the standby state is cheap to draw, so the boot never
 * costs a dropped frame. The unit caps exist because a screenshot harness (or
 * any environment with a stubbed or coarse `performance.now`) would otherwise
 * see zero elapsed time and drain the whole queue in one call.
 * ------------------------------------------------------------------ */

/** Per-frame wall-clock budget for boot construction, milliseconds. */
const BOOT_BUDGET_MS = 6;
/** Texture bake slices per frame while warming. */
const BOOT_TEXTURES_PER_FRAME = 1;
/** Studio layers baked per frame. */
const BOOT_LAYERS_PER_FRAME = 3;
/**
 * The first frame gets a larger texture slice: the studio's first bakes want
 * the set tiles (foam, aluminium, concrete), and letting them fault in lazily
 * mid-bake would put the stall back exactly where it was removed from.
 */
const BOOT_FIRST_TEXTURES = 3;

const TIER_ORDER: readonly QualityTier[] = ["low", "medium", "high", "ultra"];

/** Render-scale ceiling per tier, applied on top of the caller's DPR. */
const TIER_RENDER_SCALE: Record<QualityTier, number> = {
  low: 1,
  medium: 1.35,
  high: 2,
  ultra: 2,
};

/** Card visual physics. Springs, not tweens: an impact must ring, not glide. */
const KNOCK_SPRING = { stiffness: 210, damping: 15, mass: 1 } as const;
const SQUASH_SPRING = { stiffness: 260, damping: 16, mass: 1 } as const;
const SPIN_SPRING = { stiffness: 150, damping: 13, mass: 1 } as const;

/* ------------------------------------------------------------------ *
 * Per-card visual physics
 * ------------------------------------------------------------------ */

interface CardMotion {
  /** Positional knockback springs, in logical pixels. */
  kickX: ReturnType<typeof createSpring>;
  kickY: ReturnType<typeof createSpring>;
  /** Rotation spring, radians. */
  spin: ReturnType<typeof createSpring>;
  /** Squash spring: 0 at rest, positive = wider/shorter. */
  squash: ReturnType<typeof createSpring>;
  /** Free-running wobble phase, so two cards never sway in lockstep. */
  phase: number;
  /** Smoothed danger, so the red-alert treatment never pops. */
  danger: number;
  /** Danger thresholds already announced, so warnings escalate once each. */
  warned: number;
  /** Frame stamp for eviction. */
  seen: number;
  /** Last known centre and half-width, so an impact can be given a lever arm. */
  lastX: number;
  halfW: number;
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function createScene(options: SceneOptions): Scene {
  const visible = options.canvas;
  const seed = options.seed ?? 0x504f5021;

  /* ---------------- deterministic core ---------------------------- */
  const rng = createRng(seed);
  const noise = createNoise(seed ^ 0x9e3779b9);
  const camera = createCamera();
  const clock = createClock();

  let quality: QualityTier = options.quality ?? "high";
  let reducedMotion = options.reducedMotion ?? detectReducedMotion();
  let disposed = false;

  /*
   * A software rasteriser (SwiftShader, llvmpipe, Mesa's offscreen path, the
   * Windows basic renderer) pays per *presented* pixel far more than a GPU
   * does, and unlike frame cost that price is also paid by the compositor, so
   * the frame-time governor never sees it. Halving the presentation resolution
   * is the single biggest win available there — and because the scene is still
   * drawn into a supersampled offscreen buffer, the downscale actually reads
   * cleaner than rendering natively at 1×.
   */
  const softwareRaster = detectSoftwareRenderer();
  const maxPresentDpr = clamp(options.maxPresentDpr ?? (softwareRaster ? 1 : 2), 0.5, 4);

  /* ---------------- textures, particles --------------------------- */
  const bakery = createTextureBakery({
    rng: rng.fork(0x54455854),
    noise,
    // Every texture is a per-pixel bake, so this multiplier is quadratic in
    // cost. A weak machine asking for "low" is asking not to spend a second on
    // tiles it will then squash under a grade.
    scale: quality === "low" ? 0.7 : quality === "medium" ? 0.85 : quality === "ultra" ? 1.4 : 1,
  });

  const particleBounds = { x: 0, y: 0, width: GAME_WIDTH, height: GAME_HEIGHT };
  const particles = createParticleSystem({
    rng: rng.fork(0x50415254),
    noise,
    bakery,
    capacity: quality === "low" ? 900 : 2400,
    quality: () => quality,
    reducedMotion: () => reducedMotion,
    floorY: STAGE_Y,
    bounds: particleBounds,
  });

  /* ---------------- audio ----------------------------------------- */
  const audio = createAudioEngine({
    rng: rng.fork(0x41554449),
    muted: options.muted === true,
  });
  if (options.mix) {
    // Seed every fader before the first frame, so a returning player never
    // hears the default mix snap to theirs a tick later.
    const m = options.mix;
    audio.setMasterLevel(m.master);
    audio.setMusicLevel(m.musicLevel);
    audio.setSfxLevel(m.sfxLevel);
    audio.setCrowdLevel(m.crowdLevel);
    audio.setMusicEnabled(m.music);
    audio.setSfxEnabled(m.sfx);
    audio.setCrowdEnabled(m.crowd);
  }

  /* ---------------- render modules -------------------------------- */
  const deps = { rng, noise, bakery, particles, camera, audio };
  const studio = createStudio(deps);
  const question = createQuestionRenderer(deps);
  const desk = createDeskRenderer(deps);
  const effects = createEffectsRenderer(deps);
  const overlay = createOverlayRenderer(deps);

  /* ---------------- surfaces -------------------------------------- */
  const offscreen = createCanvas(GAME_WIDTH, GAME_HEIGHT);
  /*
   * `alpha: true` is deliberate and load-bearing.
   *
   * An opaque 2D canvas licenses the rasteriser to render text with LCD
   * subpixel antialiasing, and it does: every glyph on the frame comes back
   * with a hard blue-cyan fringe down its left edge and an amber one down its
   * right. On a card's required-letter badge at 1:1 that is unmistakable, and
   * it was read in review as chromatic aberration applied as a flat per-channel
   * offset. It is not — the post chain's CA is radial and, on that badge, sub
   * one-hundredth of a pixel. It is the font rasteriser painting into RGB
   * subpixels of a display this frame will never be shown on 1:1.
   *
   * A canvas that can carry alpha gets greyscale antialiasing instead, which is
   * the correct choice for a buffer that is going to be resampled, graded,
   * bloomed and grain-matched before anyone sees it. The buffer is still fully
   * opaque in practice — `render` clears it to the room's darkest value before
   * anything draws — so the post chain's upload and the fallback blit are
   * unaffected.
   */
  const offctx = offscreen ? offscreen.getContext("2d", { alpha: true }) : null;

  /*
   * The chain is only *constructed* when it is going to be used: obtaining a
   * WebGL2 context permanently forecloses `getContext("2d")` on the same
   * canvas, so a chain we were never going to run would strand the fallback.
   */
  const wantPost =
    options.postProcessing === "gpu" ||
    (options.postProcessing !== "off" && !softwareRaster);

  const post: PostChain | null = wantPost
    ? createPostChain({
        canvas: visible,
        quality,
        reducedMotion: options.reducedMotion,
        rng: rng.fork(0x504f5354),
        preserveDrawingBuffer: true,
        maxDpr: maxPresentDpr,
      })
    : null;

  const postActive = (): boolean => post !== null && post.available;

  /** Present-side 2D context. Only ever requested on the fallback path. */
  let blitCtx: CanvasRenderingContext2D | null = null;
  let blitTried = false;

  function fallbackContext(): CanvasRenderingContext2D | null {
    if (blitTried) return blitCtx;
    blitTried = true;
    try {
      blitCtx = visible.getContext("2d");
    } catch {
      blitCtx = null;
    }
    return blitCtx;
  }

  /* Cheap bloom for the fallback: threshold into a quarter-size buffer, blur
     it there, then add it back upscaled. Two small canvases, allocated once. */
  const bloomA = createCanvas(2, 2);
  const bloomB = createCanvas(2, 2);
  const bloomACtx = bloomA ? bloomA.getContext("2d") : null;
  const bloomBCtx = bloomB ? bloomB.getContext("2d") : null;

  /* ---------------- sizing ---------------------------------------- */
  let cssWidth = GAME_WIDTH;
  let cssHeight = GAME_HEIGHT;
  let devicePixelRatio = 1;
  let renderScale = 1;

  function applyRenderScale(): void {
    if (!offscreen || !offctx) return;
    // Logical resolution is fixed at the design size; DPR only changes how many
    // device pixels each logical pixel gets. The extra `cssWidth / GAME_WIDTH`
    // term keeps the frame sharp when the stage is laid out wider than 1000px.
    const fit = cssWidth > 0 ? cssWidth / GAME_WIDTH : 1;
    const wanted = fit * (devicePixelRatio > 0 ? devicePixelRatio : 1);
    const next = clamp(Math.round(wanted * 2) / 2, 1, TIER_RENDER_SCALE[quality]);
    const pw = Math.max(2, Math.round(GAME_WIDTH * next));
    const ph = Math.max(2, Math.round(GAME_HEIGHT * next));
    renderScale = next;
    if (offscreen.width !== pw) offscreen.width = pw;
    if (offscreen.height !== ph) offscreen.height = ph;
    // Reasserted every resize: changing the backing store resets the transform.
    offctx.setTransform(next, 0, 0, next, 0, 0);
    offctx.imageSmoothingEnabled = true;
    offctx.imageSmoothingQuality = "high";

    const bw = Math.max(2, Math.round(pw * 0.25));
    const bh = Math.max(2, Math.round(ph * 0.25));
    if (bloomA && bloomA.width !== bw) {
      bloomA.width = bw;
      bloomA.height = bh;
    }
    if (bloomB && bloomB.width !== bw) {
      bloomB.width = bw;
      bloomB.height = bh;
    }
  }

  /** Sizes the visible canvas when no post chain is there to do it. */
  function sizePresentation(): void {
    const dpr = Math.min(devicePixelRatio, maxPresentDpr);
    if (post) {
      post.resize(cssWidth, cssHeight, dpr);
      return;
    }
    const pw = Math.max(2, Math.round(cssWidth * dpr));
    const ph = Math.max(2, Math.round(cssHeight * dpr));
    if (visible.width !== pw) visible.width = pw;
    if (visible.height !== ph) visible.height = ph;
  }

  function resize(width: number, height: number, dpr: number): void {
    if (disposed) return;
    cssWidth = Number.isFinite(width) && width > 0 ? width : GAME_WIDTH;
    cssHeight = Number.isFinite(height) && height > 0 ? height : GAME_HEIGHT;
    devicePixelRatio = Number.isFinite(dpr) && dpr > 0 ? clamp(dpr, 0.5, 4) : 1;
    applyRenderScale();
    sizePresentation();
    studio.resize(GAME_WIDTH, GAME_HEIGHT);
  }

  /* ---------------- pooled view objects --------------------------- */
  /* Nothing below is ever reallocated: the arrays are truncated and refilled,
     and the objects they hold come from a growing pool. */

  const viewPool: QuestionView[] = [];
  const views: QuestionView[] = [];
  const shotPool: ShotView[] = [];
  const shotViews: ShotView[] = [];
  const motions = new Map<number, CardMotion>();

  const deskView: DeskView = {
    x: DESK_X,
    y: DESK_Y,
    aim: -Math.PI / 2,
    recoil: 0,
    letter: LETTERS[0],
    charge: 1,
  };

  const overlayState: OverlayState = {
    announcement: "",
    announcementTone: "info",
    announcementAge: 0,
    score: 0,
    combo: 0,
    comboTier: patienceTier(0),
    timeRemaining: ROUND_SECONDS,
    activeQuestions: 0,
    slowSeconds: 0,
    difficultyLabel: "OPENING CHAT",
  };

  const ctxView: SceneContext = {
    time: 0,
    rawTime: 0,
    dt: 0,
    rawDt: 0,
    phase: "idle",
    elapsed: 0,
    progress: 0,
    intensity: 0,
    combo: 0,
    backlog: 0,
    maxBacklog: MAX_BACKLOG,
    slow: 0,
    flash: 0,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    stageY: STAGE_Y,
    quality,
    reducedMotion,
    mood: 0.5,
  };

  const params: PopPostParams = defaultPostParams();
  const baseParams: PopPostParams = defaultPostParams();

  /* ---------------- live scene state ------------------------------ */
  let frameIndex = 0;
  let lastPhase: ScenePhase = "idle";
  let musicRunning = false;

  /** Event-driven channels, all decaying in raw time. */
  let flashChannel = 0;
  /**
   * Where the current flash is detonating, in normalised frame coordinates,
   * how long its front has been travelling, and how much of it is a flat
   * full-frame lift rather than a blast. See `FlashShape` in `engine/postfx`.
   */
  let flashX = 0.5;
  let flashY = 0.5;
  let flashAge = 0;
  let flashFlat = 1;
  /** Front speed, half-frame-heights per second. */
  let flashSpeed = 0;
  let answerPulse = 0;
  let glitchPulse = 0;
  let radialPulse = 0;
  let recoilChannel = 0;
  let hitPulse = 0;

  /** Smoothed drivers. */
  let intensity = 0;
  let mood = 0.5;
  let slowVis = 0;
  let pressure = 0;

  /** Combo / chain bookkeeping owned by the presentation. */
  let hitChain = 0;
  let lastTier = patienceTier(0);
  let warnCooldown = 0;

  /** Auto-quality governor. */
  const autoQuality = options.autoQuality !== false;
  let govWindow = 0;
  let govCost = 0;
  let govFrames = 0;
  let govSteps = 0;
  let govWarmup = 1.2;

  /** Boot pump state. */
  let texturesPending = bakery.total;
  let bootFrames = 0;
  let bootDone = false;

  /* ---------------- helpers --------------------------------------- */

  const motionScale = (): number => (reducedMotion ? 0.35 : 1);

  function stop(seconds: number): void {
    clock.hitStop(seconds * (reducedMotion ? 0.45 : 1));
  }

  function trauma(amount: number): void {
    camera.addTrauma(amount * motionScale());
  }

  function impulse(x: number, y: number): void {
    const s = motionScale();
    camera.addImpulse(x * s, y * s);
  }

  function play(id: SfxId, gain = 1, rate = 1, pan = 0): void {
    audio.play(id, { gain, rate, pan });
  }

  /**
   * Raise the flash channel *from a place*.
   *
   * `amount` is the peak brightness, `flat` is how much of the result is an
   * undirected full-frame lift (1 for a UI confirmation, 0 for an ultimate),
   * and `speed` is how fast the front leaves the origin in half-frame-heights
   * per second. A stronger blast takes ownership of the origin; a weaker one
   * that lands during it only tops up the amount, so two events can never
   * fight over where the light is coming from.
   */
  function detonate(x: number, y: number, amount: number, flat: number, speed: number): void {
    if (amount >= flashChannel) {
      flashX = clamp01(x / GAME_WIDTH);
      flashY = clamp01(y / GAME_HEIGHT);
      flashFlat = clamp01(flat);
      flashSpeed = speed;
      flashAge = 0;
    }
    flashChannel = Math.max(flashChannel, amount);
  }

  /** Pan a sound by where it happened on stage, −1 … 1. */
  function panAt(x: number): number {
    return clamp((x - GAME_WIDTH * 0.5) / (GAME_WIDTH * 0.5), -1, 1) * 0.65;
  }

  function motionFor(id: number): CardMotion {
    let m = motions.get(id);
    if (!m) {
      m = {
        kickX: createSpring(KNOCK_SPRING),
        kickY: createSpring(KNOCK_SPRING),
        spin: createSpring(SPIN_SPRING),
        squash: createSpring(SQUASH_SPRING),
        phase: rng.range(0, Math.PI * 2),
        danger: 0,
        warned: 0,
        seen: frameIndex,
        lastX: 0,
        halfW: 84,
      };
      motions.set(id, m);
    }
    return m;
  }

  /**
   * Knock a card around. `power` is roughly "how hard", 0–1+.
   *
   * An underdamped spring driven by an impulse `v` peaks at about `0.63·v/ω`,
   * so the constants below are chosen against each spring's ω: a letter reads
   * as ~5 px of knockback, ~3° of roll and a 1.12 / 0.90 squash; a completion
   * is roughly 1.6× that. The card must read as an object taking a hit.
   */
  function strike(id: number, hitX: number, dirX: number, dirY: number, power: number): void {
    const m = motionFor(id);
    const s = reducedMotion ? 0.4 : 1;
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;

    m.kickX.impulse(nx * 168 * power * s);
    m.kickY.impulse(ny * 124 * power * s);

    // Lever arm from the impact point. A hit left of centre lifts the left end,
    // which in a y-down canvas is a positive (clockwise) rotation — hence the
    // sign flip. Aim assist puts most shots near the centre, so a dead-centre
    // hit gets a small arbitrary tilt rather than nothing at all.
    const lever = clamp((hitX - m.lastX) / Math.max(24, m.halfW), -1, 1);
    const bias = Math.abs(lever) > 0.18 ? -lever : rng.sign() * 0.42;
    m.spin.impulse((bias + nx * 0.35) * 6.5 * power * s);
    m.squash.impulse(2.8 * power * s);
  }

  /* ================================================================ *
   * Events — the simulation says what happened, this decides how it lands
   *
   * `desk.onFire` and the four `effects.on*` entry points already own their own
   * camera reaction (a recoil punch, an impact punch along the shot, a hard
   * downward hit on a landing, a pull-back on POP OFF). Everything below is an
   * *accent* on top of that — the parts only the composition root can know:
   * hit-stop lengths, chain-scaled pitch, card knockback, slow-motion beats,
   * ducking, and the post-chain channels. Re-applying the module-owned trauma
   * here would double every shake in the game.
   * ================================================================ */

  function onFire(x: number, y: number, aim: number, letter: string): void {
    deskView.letter = letter;
    deskView.aim = aim;
    recoilChannel = 1;
    // Owns the muzzle flash, the smoke, the cable whip and the recoil punch.
    desk.onFire(deskView);
    play("fire", 0.9, lerp(0.97, 1.06, rng.next()), panAt(x));
  }

  function onHit(event: SceneHitEvent): void {
    hitChain += 1;
    hitPulse = 1;
    effects.onHit(event.x, event.y, event.color, event.letter);
    strike(event.cardId, event.x, event.dirX, event.dirY, event.cardComplete ? 1.15 : 0.72);
    if (event.cardComplete) impulse(event.dirX * 2.2, event.dirY * 2.2);
    stop(event.cardComplete ? STOP_CARD : event.wordComplete ? STOP_WORD : STOP_LETTER);

    // Rising pitch through a chain: twelve semitone-ish steps, then it holds so
    // a long run never turns into a whistle.
    const step = Math.min(hitChain, 12);
    const rate = 1 + step * 0.045;
    play("hit", 0.95, rate, panAt(event.x));

    if (event.wordComplete && !event.cardComplete) {
      play("combo-up", 0.5, 1 + step * 0.03, panAt(event.x));
      camera.addZoom(0.012 * motionScale());
    }

    // The last letter of a multi-SOON card gets a slow-motion beat: the payoff
    // deserves a frame or two of air before the burst.
    if (event.cardComplete && event.wordsLeft === 0 && event.words > 1) {
      if (!reducedMotion) {
        clock.slowMotion(0.32, 0.5);
        play("slowmo-in", 0.5);
      }
    }
  }

  function onReject(x: number, y: number, requiredLetter: string, cardId: number): void {
    hitChain = 0;
    effects.onReject(x, y, requiredLetter);
    strike(cardId, x, 0, -1, 0.32);
    play("hit-wrong", 0.85, 1, panAt(x));
    glitchPulse = Math.max(glitchPulse, 0.28);
  }

  function onAnswer(event: SceneAnswerEvent): void {
    effects.onAnswer(event.x, event.y, event.color, event.value, event.combo);
    answerPulse = 1;
    // The light comes off the card that was answered, not off the whole room.
    detonate(event.x, event.y, event.words > 1 ? 0.55 : 0.36, 0.42, 3.4);
    // The zoom punch on a completed card: the one camera move the scene owns,
    // because it scales with the chain, which no single module can see.
    camera.addZoom((0.026 + Math.min(event.combo, 9) * 0.003) * motionScale());
    stop(STOP_CARD);
    motions.delete(event.cardId);

    const big = event.words > 1 || event.combo >= 6;
    play(big ? "answer-big" : "answer", 1, 1 + Math.min(event.combo, 9) * 0.018, panAt(event.x));
    audio.duck(big ? 0.5 : 0.3, big ? 0.5 : 0.32);
    if (big) play("crowd-cheer", 0.6);

    // Tier flourish: only when the label actually changes, so it stays an event.
    // `effects.onAnswer` already prints the "+value" and "×combo" popups and
    // fires its own milestone callout, so this adds the broadcast line and the
    // audio sting rather than a third floating number.
    const tier = patienceTier(event.combo);
    if (tier !== lastTier && event.combo > 0) {
      lastTier = tier;
      overlay.announce(`${tier} — PATIENCE CHAIN ×${event.combo}`, "good", 2.2);
      play("combo-up", 0.85, 1 + Math.min(event.combo, 9) * 0.03);
      camera.addZoom(0.022 * motionScale());
      // A broadcast tier change is a graphics event, not a physical one: it
      // lifts the whole frame rather than blasting from a point.
      detonate(GAME_WIDTH * 0.5, STAGE_Y * 0.5, 0.45, 1, 0);
    }

    if (event.perfect && event.perfectBonus > 0) {
      effects.popup(event.x, event.y - 78, `PERFECT CHAIN +${event.perfectBonus}`, BONE, 19);
      play("combo-up", 0.6, 1.32);
    }
  }

  function onLand(x: number, y: number, label: string): void {
    hitChain = 0;
    lastTier = patienceTier(0);
    effects.onLand(x, y);
    // Only the scene can tell the set about the impact: `effects` has no handle
    // on the studio, and the lamps, floor scuff and video wall all react here.
    studio.onImpact(x, STAGE_Y, 0.85);
    trauma(0.12);
    stop(STOP_LAND);
    glitchPulse = 1;
    detonate(x, STAGE_Y, 0.22, 0.35, 3.9);
    play("land", 1, 1, panAt(x));
    play("crowd-groan", 0.55);
    audio.duck(0.45, 0.6);
    // The banner itself comes through `OverlayState.announcement`, which the
    // simulation already raised — announcing here too would double it.
    void label;
  }

  function onPopOff(cleared: number, cards: readonly SceneQuestionInput[]): void {
    effects.onPopOff(cleared);
    // The blast starts at the centre of mass of what it is about to clear, so
    // the ultimate reads as originating in the board rather than in the lens.
    // With no cards on the board it falls back to the desk, which is where the
    // player triggered it from.
    let cx = 0;
    let cy = 0;
    for (const card of cards) {
      cx += card.x;
      cy += card.y;
    }
    if (cards.length > 0) {
      cx /= cards.length;
      cy /= cards.length;
    } else {
      cx = DESK_X;
      cy = DESK_Y - 60;
    }
    for (const card of cards) motions.delete(card.id);
    trauma(0.25);
    stop(STOP_POP);
    if (!reducedMotion) clock.slowMotion(0.4, 0.75);
    // Fully directional: an ultimate is the one event in the game that must
    // have an origin, a travelling front and a falloff behind it.
    detonate(cx, cy, 1, 0, 3.1);
    radialPulse = 1;
    answerPulse = 1;
    play("pop", 1);
    play("crowd-cheer", 0.9, 1, 0);
    audio.duck(0.7, 0.9);
  }

  function onImpact(x: number, y: number, force: number): void {
    studio.onImpact(x, y, force);
    trauma(clamp01(force) * 0.3);
  }

  /* ================================================================ *
   * Frame
   * ================================================================ */

  function tick(rawDeltaSeconds: number): number {
    clock.tick(rawDeltaSeconds);
    return clock.dt;
  }

  /** Composite pressure: backlog, board density, proximity to the floor, time. */
  function computeIntensity(frame: SceneFrame, worstDanger: number): number {
    if (frame.phase !== "playing") return frame.phase === "lost" ? 0.75 : 0.12;
    const backlogP = clamp01(frame.backlog / MAX_BACKLOG);
    const densityP = clamp01(frame.questions.length / 7);
    const timeP = clamp01(frame.elapsed / ROUND_SECONDS);
    return clamp01(backlogP * 0.36 + densityP * 0.24 + worstDanger * 0.26 + timeP * 0.14);
  }

  function buildViews(frame: SceneFrame, dt: number): number {
    views.length = 0;
    let worst = 0;
    const ammo = frame.ammoLetter;

    for (let i = 0; i < frame.questions.length; i++) {
      const q = frame.questions[i];
      const m = motionFor(q.id);
      m.seen = frameIndex;
      m.lastX = q.x;
      m.halfW = q.width * 0.5;

      // --- springs -------------------------------------------------
      m.kickX.set(0);
      m.kickY.set(0);
      m.spin.set(0);
      m.squash.set(0);
      m.kickX.update(dt);
      m.kickY.update(dt);
      m.spin.update(dt);
      m.squash.update(dt);
      m.phase += dt * 0.9;

      // --- danger --------------------------------------------------
      const half = (q.height ?? 62) * 0.5;
      const reach = clamp01((q.y + half) / Math.max(1, STAGE_Y));
      const rawDanger = smoothstep(0.6, 0.99, reach);
      m.danger = damp(m.danger, rawDanger, 8, dt);
      if (m.danger > worst) worst = m.danger;

      // Escalating warnings, once per threshold per card, globally throttled so
      // a crowded board cannot turn into an alarm carpet.
      if (frame.phase === "playing" && warnCooldown <= 0) {
        const level = rawDanger > 0.82 ? 2 : rawDanger > 0.5 ? 1 : 0;
        if (level > m.warned) {
          m.warned = level;
          warnCooldown = level === 2 ? 0.28 : 0.5;
          play("warning", level === 2 ? 0.8 : 0.45, level === 2 ? 1.28 : 1, panAt(q.x));
        }
      }

      // --- descent wobble -----------------------------------------
      // Only while falling and only on the visual layer: simulation x/y are
      // untouched, so aiming stays honest.
      const settle = clamp01(q.age / 0.55);
      const wobbleAmp = reducedMotion ? 0 : lerp(0.05, 0.014, settle) + m.danger * 0.02;
      const wobble = noise.n2(m.phase, q.id * 0.37) * wobbleAmp;

      // Squash is volume-preserving-ish and hard-clamped, so however many hits
      // land in one frame the card can never invert or balloon.
      const sq = clamp(m.squash.value * 1.45, -0.26, 0.34);
      const view = viewAt(i);
      view.id = q.id;
      view.kind = q.kind;
      view.label = q.label;
      view.x = q.x + m.kickX.value;
      view.y = q.y + m.kickY.value;
      view.width = q.width;
      view.height = q.height ?? 62;
      view.color = q.color;
      view.progress = q.progress;
      view.total = q.total;
      view.targeted = q.progress < q.total && expectedLetter(q.progress) === ammo;
      view.danger = m.danger;
      view.rotation = clamp(m.spin.value * 0.55, -0.24, 0.24) + wobble;
      view.scaleX = 1 + sq;
      view.scaleY = 1 - sq * 0.85;
      view.age = q.age;
      view.sinceHit = q.sinceHit;
      views.push(view);
    }

    // Evict motion records for cards that are gone. Cheap: the map only ever
    // holds a handful of entries.
    if (motions.size > frame.questions.length + 8) {
      for (const [id, m] of motions) {
        if (m.seen !== frameIndex) motions.delete(id);
      }
    }
    return worst;
  }

  function viewAt(index: number): QuestionView {
    let v = viewPool[index];
    if (!v) {
      v = {
        id: 0,
        kind: "og",
        label: "",
        x: 0,
        y: 0,
        width: 168,
        height: 62,
        color: HEMI,
        progress: 0,
        total: 4,
        targeted: false,
        danger: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        age: 0,
        sinceHit: 99,
      };
      viewPool[index] = v;
    }
    return v;
  }

  function buildShots(frame: SceneFrame): void {
    shotViews.length = 0;
    for (let i = 0; i < frame.shots.length; i++) {
      const s = frame.shots[i];
      let v = shotPool[i];
      if (!v) {
        v = { id: 0, x: 0, y: 0, vx: 0, vy: 0, letter: "S", age: 0 };
        shotPool[i] = v;
      }
      v.id = s.id;
      v.x = s.x;
      v.y = s.y;
      v.vx = s.vx;
      v.vy = s.vy;
      v.letter = s.letter;
      v.age = s.age;
      shotViews.push(v);
    }
  }

  /**
   * The card the lock reticle marks — and it must be the card that gets hit.
   *
   * The old rule was a 0.62 rad cone over *targeted* cards only, which is not a
   * rule the projectile has ever obeyed. It lied three ways at once: it ignored
   * aim assist, so it marked a caller the letter was never going to fly at; it
   * ignored geometry, so a card 35° off the barrel with its strike box nowhere
   * near the line read as locked; and it ignored blockers, so an unrelated
   * caller parked in front of the one you wanted was invisible to the reticle
   * and ate the letter anyway.
   *
   * This instead runs the projectile's own resolution — `predictedTarget` in
   * `lib/pop.ts`, the same aim assist, the same fixed step, the same strike
   * boxes, the same array order, the same first-hit rule that `updateGame`
   * applies — and marks whatever comes back. If the answer is an untargeted
   * card, the reticle marks *that*, and `desk.drawReticle` already draws a
   * non-lock in aluminium rather than a hemi lock, so the player is told they
   * are about to waste a letter.
   */
  function pickTarget(angle: number, frame: SceneFrame): QuestionView | null {
    if (frame.questions.length === 0) return null;
    const id = traceShot(angle, frame.questions, difficultyAt(frame.elapsed).hitPadding);
    if (id < 0) return null;
    for (let i = 0; i < views.length; i++) {
      if (views[i].id === id) return views[i];
    }
    return null;
  }

  /**
   * Post parameters are recomputed from the authored base every frame, never
   * accumulated, so nothing can drift permanently hot.
   */
  function drivePost(frame: SceneFrame): void {
    const p = params;
    const b = baseParams;
    const press = pressure;
    const flash = flashChannel;
    const lost = frame.phase === "lost";
    const won = frame.phase === "won";

    p.bloomStrength =
      b.bloomStrength * (1 + press * 0.42) + answerPulse * 0.55 + flash * 0.4 + hitPulse * 0.1;
    p.bloomThreshold = b.bloomThreshold - press * 0.06 - answerPulse * 0.08;
    p.bloomRadius = b.bloomRadius + press * 0.2 + answerPulse * 0.25;

    // Corner separation only — the profile is gated off across the middle of
    // frame, so this budget is never spent on a UI edge near the centre.
    p.chroma = b.chroma * (1 + press * 0.4) + radialPulse * 1.5 + glitchPulse * 0.8;
    p.barrel = b.barrel + press * 0.022 + radialPulse * 0.03;
    // Attract opens the iris: the title card's DOM scrim passes only the right
    // margin of the picture, and that margin is exactly where a vignette bites.
    const idle = frame.phase === "idle";
    p.vignette = clamp01(
      b.vignette + press * 0.13 + (lost ? 0.12 : 0) - answerPulse * 0.06 - (idle ? 0.16 : 0),
    );
    p.grain = b.grain * (1 + press * 0.35) + glitchPulse * 0.05;
    p.scanline = b.scanline + press * 0.05 + glitchPulse * 0.12;

    // Grade. Mood is the warm/cool axis: a good chain warms the room, backlog
    // pressure cools and hardens it.
    // Victory opens the room up and cools it; defeat closes it down and pushes
    // it hot. These are the two ends of the grade, and they have to be as far
    // apart as the two lighting states the studio builds for them.
    p.exposure =
      b.exposure * (1 + answerPulse * 0.06 + (won ? 0.14 : 0) + (idle ? 0.1 : 0) - press * 0.05) * (lost ? 0.86 : 1);
    p.contrast = b.contrast + press * 0.13 + (lost ? 0.14 : won ? -0.03 : 0);
    // Saturation below 1 is the *point* for everything that is a lit surface:
    // the set is authored warm and the grade holds its neutrals so the one
    // saturated hue in the palette can be seen against them. `chromaGain` is the
    // other half of the same decision — it is what the sources keep while the
    // room is held down, and without it "hold the neutrals" also means "throw
    // the brand away", which is what the last pass did. Pressure brings chroma
    // back on both axes — a hot room is a saturated room — and defeat drains it
    // further than any gameplay frame ever goes.
    p.saturation = b.saturation * (1 + press * 0.16) * (lost ? 0.74 : won ? 1.1 : 1);
    p.chromaGain = (b.chromaGain ?? 1) * (1 + press * 0.12) * (lost ? 0.8 : 1);
    p.chromaKnee = b.chromaKnee ?? 0.55;
    p.temperature = clamp(b.temperature + (mood - 0.5) * 0.34 - press * 0.06 + (lost ? 0.22 : won ? -0.12 : 0), -1, 1);

    p.flashAmount = flash * 1.15;
    // Flash colour rides the same single-hue rule: near-white for a clean
    // answer, hotter orange when the room is under pressure.
    const hot = clamp01(press * 0.6 + (lost ? 0.5 : 0));
    p.flashColor[0] = 1;
    p.flashColor[1] = lerp(0.78, 0.36, hot);
    p.flashColor[2] = lerp(0.62, 0.12, hot);

    /* --- flash shape: an origin, a front and a falloff ------------- */
    p.flashCenterX = flashX;
    p.flashCenterY = flashY;
    // The front leaves the origin the instant the event lands and clears the
    // frame corners in roughly a third of a second. The shell thins as it
    // expands, the way a real blast front does.
    p.flashRadius = clamp(0.05 + flashAge * flashSpeed, 0.05, 6);
    p.flashFront = lerp(0.52, 0.2, clamp01(flashAge * 3.2));
    p.flashUniform = flashFlat;

    p.glitch = reducedMotion ? 0 : clamp01(glitchPulse * 0.8 + (lost ? 0.06 : 0));
    p.radialBlur = clamp01(radialPulse * 0.85 + (reducedMotion ? 0 : slowVis * 0.06));
  }

  /* ---------------- fallback presentation ------------------------- */

  function present(): void {
    if (!offscreen) return;
    if (post && postActive()) {
      post.render(offscreen, params, clock.rawTime);
      return;
    }
    presentFallback(offscreen);
  }

  /**
   * The no-GPU present. The chain's fifteen passes are gone, so this rebuilds
   * the four that carry the look — bloom, grade, vignette, grain — out of
   * canvas 2D primitives that a software rasteriser can actually afford. Bloom
   * is thresholded and blurred at quarter resolution and added back upscaled,
   * which is roughly one and a half full-frame fills rather than fifteen.
   */
  function presentFallback(source: HTMLCanvasElement): void {
    const ctx = fallbackContext();
    if (!ctx) return;
    const w = visible.width;
    const h = visible.height;
    if (w < 2 || h < 2) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = "none";
    ctx.drawImage(source, 0, 0, w, h);

    /* --- bloom ---------------------------------------------------- */
    const bloom = clamp01(params.bloomStrength * 0.62);
    if (bloom > 0.01 && quality !== "low" && bloomA && bloomB && bloomACtx && bloomBCtx) {
      const bw = bloomA.width;
      const bh = bloomA.height;
      // brightness+contrast is a serviceable stand-in for a threshold: it
      // crushes the room to black and leaves the practicals and the hemi
      // orange standing.
      bloomACtx.setTransform(1, 0, 0, 1, 0, 0);
      bloomACtx.globalCompositeOperation = "copy";
      bloomACtx.filter = "brightness(1.75) contrast(3.1) saturate(1.15)";
      bloomACtx.drawImage(source, 0, 0, bw, bh);
      bloomACtx.filter = "none";

      bloomBCtx.setTransform(1, 0, 0, 1, 0, 0);
      bloomBCtx.globalCompositeOperation = "copy";
      bloomBCtx.filter = `blur(${(2.2 + params.bloomRadius * 1.6).toFixed(2)}px)`;
      bloomBCtx.drawImage(bloomA, 0, 0);
      bloomBCtx.filter = "none";

      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = bloom;
      ctx.drawImage(bloomB, 0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    /* --- flash ---------------------------------------------------- */
    // Same shape the GPU composite builds, evaluated through the same curve, so
    // the two presentation paths detonate identically. A radial gradient is
    // allocated only on the handful of frames a flash is actually live — under
    // half a second per event — and never in the steady-state loop.
    if (params.flashAmount > 0.004) {
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = flashCss();
      const flat = clamp01(params.flashUniform ?? 1);
      if (flat > 0.995) {
        ctx.globalAlpha = clamp01(params.flashAmount * 0.42);
        ctx.fillRect(0, 0, w, h);
      } else {
        // Half-frame-heights → device pixels, matching the shader's units.
        const unit = h;
        const cx = (params.flashCenterX ?? 0.5) * w;
        const cy = (params.flashCenterY ?? 0.5) * h;
        const reach = Math.max(w, h) * 1.6;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const weight = flashFalloff((t * reach) / unit, params);
          g.addColorStop(t, withFlashAlpha(clamp01(params.flashAmount * 0.5 * weight)));
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    /* --- grade: chroma and white balance --------------------------- */
    // The chain's grade is white balance → contrast → saturation, and only the
    // last of those is allowed to touch chroma globally. What used to be here
    // did the opposite: a single soft-light pass of #ff7a3c across the whole
    // frame, which is a global hue rotation toward orange. Measured on a
    // neutral input that pass alone put every pixel at HSV saturation 0.19, and
    // it was the largest single contributor to a frame with no neutral left in
    // it. Chroma comes last, so it also catches the bloom and the flash.

    // 1. Chroma. `saturation` is a true luminance-preserving chroma scale — the
    //    same control the GPU path spends — not a tint.
    //
    //    The GPU path spends it as a *curve*: diffuse surfaces are pulled down
    //    and sources are pushed up (`chromaGain`). Canvas 2D has no per-pixel
    //    chroma test to key that off, and faking one with a saturated fill under
    //    the `saturation` blend would raise the neutrals too — which is the
    //    exact failure this whole pass exists to undo. So the fallback spends a
    //    single global number: the authored chroma scale, lifted by a fraction
    //    of the source gain. Softer than the chain, never a tint.
    const gain = clamp(params.chromaGain ?? 1, 0, 4);
    const effective = clamp(params.saturation, 0, 2) * (1 + (gain - 1) * 0.22);
    const desat = clamp01((1 - effective) * 1.7);
    if (desat > 0.004) {
      ctx.globalCompositeOperation = "saturation";
      ctx.globalAlpha = desat;
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // 2. White balance. A multiply is a per-channel gain, which is exactly what
    //    a white-balance move is. It is spent subtractively — warm pulls blue
    //    down rather than pushing red up — so the grade can never invent hue
    //    that was not photographed, and the level it costs comes straight back
    //    from the exposure lift below.
    const temp = clamp(params.temperature, -1, 1);
    const trim = Math.round(clamp01(Math.abs(temp)) * 30);
    if (trim > 0) {
      const near = 255 - Math.round(trim * 0.34);
      const far = 255 - trim;
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = temp >= 0 ? `rgb(255,${near},${far})` : `rgb(${far},${near},255)`;
      ctx.fillRect(0, 0, w, h);
    }

    // 3. Level. A neutral soft-light pass carries exposure and the shoulder of
    //    the contrast control: above mid it lifts, below mid it drops, and
    //    there is no hue anywhere in it. A CSS `contrast()` filter was measured
    //    against this and rejected — it pivots on 0.5, which on a frame whose
    //    mean sits at a quarter of full scale crushes a quarter of the picture
    //    into the bottom three per cent of the range, where every remaining
    //    warm code reads as a fully saturated pixel.
    const ev = clamp(params.exposure, 0.5, 2) - 1 + (clamp(params.contrast, 0.5, 2) - 1) * 0.25;
    if (Math.abs(ev) > 0.004) {
      ctx.globalCompositeOperation = "soft-light";
      ctx.globalAlpha = clamp01(Math.abs(ev) * 2.4);
      ctx.fillStyle = ev > 0 ? "#ffffff" : "#000000";
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = "source-over";

    /* --- vignette ------------------------------------------------- */
    ctx.globalAlpha = clamp01(params.vignette * 1.05);
    ctx.drawImage(bakery.get("vignette"), 0, 0, w, h);
    ctx.globalAlpha = 1;

    /* --- grain ---------------------------------------------------- */
    if (params.grain > 0.001) {
      const size = bakery.size("noise-fine");
      const ox = reducedMotion ? 0 : Math.floor(rng.range(0, size));
      const oy = reducedMotion ? 0 : Math.floor(rng.range(0, size));
      ctx.save();
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha = clamp01(params.grain * 2.4);
      ctx.translate(-ox, -oy);
      ctx.fillStyle = bakery.pattern(ctx, "noise-fine", "repeat");
      ctx.fillRect(0, 0, w + size, h + size);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  function flashCss(): string {
    const c = params.flashColor;
    const to255 = (v: number): number => Math.round(clamp01(v) * 255);
    return `rgb(${to255(c[0])},${to255(c[1])},${to255(c[2])})`;
  }

  /** The flash colour at a given weight, for the fallback's radial stops. */
  function withFlashAlpha(alpha: number): string {
    const c = params.flashColor;
    const to255 = (v: number): number => Math.round(clamp01(v) * 255);
    return `rgba(${to255(c[0])},${to255(c[1])},${to255(c[2])},${alpha.toFixed(3)})`;
  }

  /* ---------------- boot pump ------------------------------------- */

  /**
   * One slice of construction, run at the top of every frame until the set is
   * live. Textures come first and complete before the studio starts: the layer
   * bakes fill with tile patterns, so warming in the other order would just
   * move the stall inside a layer bake instead of removing it.
   */
  function pumpBoot(): void {
    if (bootDone) return;
    bootFrames += 1;
    if (texturesPending > 0) {
      texturesPending = bakery.warmStep(
        BOOT_BUDGET_MS,
        bootFrames <= 1 ? BOOT_FIRST_TEXTURES : BOOT_TEXTURES_PER_FRAME,
      );
      // The studio still gets a slice on the same frame once the tiles it needs
      // are down, so the two phases overlap rather than queueing end to end.
      if (texturesPending > 0) return;
    }
    if (studio.bootStep(BOOT_BUDGET_MS, BOOT_LAYERS_PER_FRAME)) {
      bootDone = true;
      // Frame cost during the boot is construction, not rendering. Judging the
      // machine on it would step the tier down on hardware that is perfectly
      // capable, so the governor's window only opens once the set is live.
      govWarmup = Math.max(govWarmup, 0.8);
      govWindow = 0;
      govCost = 0;
      govFrames = 0;
    }
  }

  /* ---------------- auto quality ---------------------------------- */

  function governQuality(costMs: number, rawDt: number): void {
    if (!autoQuality || govSteps >= GOVERNOR_MAX_STEPS) return;
    // A frame that spent its time building the set says nothing about how fast
    // this machine renders one.
    if (!bootDone) return;
    if (govWarmup > 0) {
      govWarmup -= rawDt;
      return;
    }
    govCost += costMs;
    govFrames += 1;
    govWindow += rawDt;
    if (govWindow < GOVERNOR_WINDOW || govFrames < 20) return;

    const average = govCost / govFrames;
    govWindow = 0;
    govCost = 0;
    govFrames = 0;
    if (average <= FRAME_BUDGET_MS) return;

    const index = TIER_ORDER.indexOf(quality);
    if (index <= 0) {
      govSteps = GOVERNOR_MAX_STEPS;
      return;
    }
    govSteps += 1;
    // Strictly monotonic: the governor only ever steps down, so it can never
    // oscillate between two tiers on a machine sitting exactly at the budget.
    setQuality(TIER_ORDER[index - 1]);
    // Give the new tier a full window to settle before judging it again.
    govWarmup = 1;
  }

  /* ---------------- render ---------------------------------------- */

  function render(frame: SceneFrame): void {
    if (disposed || !offscreen || !offctx) return;
    const started = now();
    frameIndex += 1;
    pumpBoot();

    const dt = clamp(clock.dt, 0, 0.1);
    const rawDt = clamp(clock.rawDt, 0, 0.1);

    /* --- phase transitions --------------------------------------- */
    if (frame.phase !== lastPhase) {
      if (frame.phase === "playing") {
        camera.reset();
        particles.clear();
        motions.clear();
        hitChain = 0;
        lastTier = patienceTier(0);
        detonate(GAME_WIDTH * 0.5, STAGE_Y * 0.5, 0.5, 1, 0);
        play("round-start", 1);
        audio.startMusic();
        musicRunning = true;
      } else if (frame.phase === "won" || frame.phase === "lost") {
        play(frame.phase === "won" ? "round-win" : "round-lose", 1);
        if (frame.phase === "won") play("crowd-cheer", 0.9);
        audio.stopMusic();
        musicRunning = false;
        detonate(GAME_WIDTH * 0.5, STAGE_Y * 0.55, frame.phase === "won" ? 0.7 : 0.4, 1, 0);
        trauma(frame.phase === "won" ? 0.3 : 0.5);
        stop(0.12);
      }
      lastPhase = frame.phase;
    }

    /* --- decays (raw time: effects must not freeze in hit-stop) --- */
    flashChannel = Math.max(0, flashChannel - rawDt * 2.6);
    flashAge += rawDt;
    answerPulse = Math.max(0, answerPulse - rawDt * 3.4);
    glitchPulse = Math.max(0, glitchPulse - rawDt * 4.2);
    radialPulse = Math.max(0, radialPulse - rawDt * 1.9);
    hitPulse = Math.max(0, hitPulse - rawDt * 6);
    recoilChannel = Math.max(0, recoilChannel - rawDt * 5.5);
    warnCooldown = Math.max(0, warnCooldown - rawDt);

    /* --- camera before everything reads it ----------------------- */
    camera.update(rawDt);

    /* --- adaptation ---------------------------------------------- */
    const worstDanger = buildViews(frame, dt);
    buildShots(frame);

    const targetIntensity = computeIntensity(frame, worstDanger);
    intensity = damp(intensity, targetIntensity, 3.2, rawDt);
    pressure = clamp01(intensity);

    const comboWarm = clamp01(frame.combo / 8) * 0.32;
    const targetMood =
      frame.phase === "lost"
        ? 0.1
        : frame.phase === "won"
          ? 0.9
          : clamp01(0.46 + comboWarm - pressure * 0.3 + (frame.popMeter / 100) * 0.12);
    mood = damp(mood, targetMood, 1.6, rawDt);
    slowVis = damp(slowVis, frame.slowSeconds > 0 ? 1 : 0, 5, rawDt);

    const s = ctxView;
    s.time = clock.time;
    s.rawTime = clock.rawTime;
    s.dt = dt;
    s.rawDt = rawDt;
    s.phase = frame.phase;
    s.elapsed = frame.elapsed;
    s.progress = clamp01(frame.elapsed / ROUND_SECONDS);
    s.intensity = pressure;
    s.combo = frame.combo;
    s.backlog = frame.backlog;
    s.maxBacklog = MAX_BACKLOG;
    s.slow = clamp01(Math.max(slowVis, 1 - clock.scale));
    s.flash = clamp01(flashChannel);
    s.width = GAME_WIDTH;
    s.height = GAME_HEIGHT;
    s.stageY = STAGE_Y;
    s.quality = quality;
    s.reducedMotion = reducedMotion;
    s.mood = mood;

    // The barrel points where the letter actually goes. Aim assist snaps the
    // shot by up to 0.52 rad at the moment of firing; drawing the rig along the
    // raw pointer angle meant the rail, the reticle and the projectile could all
    // disagree by thirty degrees. One angle, resolved once, used by all three.
    const firingAngle = assistedAimAngle(frame.aim, frame.ammoLetter, frame.questions);
    deskView.x = DESK_X;
    deskView.y = DESK_Y;
    deskView.aim = firingAngle;
    deskView.recoil = clamp01(recoilChannel);
    deskView.letter = frame.ammoLetter;
    // Readiness of the *ultimate*, not of the 60 ms fire cooldown.
    //
    // The cooldown refills in under four frames, so the mic's charge collar was
    // a closed ring in every frame ever captured and told the player nothing —
    // confirmed on the pre-fix capture, where the collar is a full glowing ring
    // at a 0 % POP meter. The POP meter is the one readiness worth watching,
    // and `DeskView.charge` is the only channel the render contract offers the
    // play field to show it: neither `SceneContext` nor `OverlayState` carries a
    // POP value, and `types.ts` is not ours to change. desk.ts already treats
    // `charge > 0.995` as *armed* and lights a pulse for it, which is ultimate
    // language, not cooldown language.
    //
    // NOTE FOR desk.ts: `charge` is over-coupled there. Besides the collar and
    // the readout backlight it also feeds `drawAimGuide`'s
    // `energy = 0.42 + 0.58 * charge` and `drawReticle`'s
    // `conf = aimQuality * (0.55 + 0.45 * charge)`. With an honest POP meter
    // that means the aim rail loses 58 % of its contrast and the badge reads
    // STBY on a correctly-locked caller whenever the meter is empty — measured
    // on frame 03, where the rail's dashed centre line disappears entirely.
    // Neither the rail nor the lock has anything to do with the ultimate's
    // charge: the rail wants "am I in a round", which is already `scene.phase`,
    // and the lock wants `target.targeted` and the aim error, both of which it
    // already has. Dropping `charge` out of those two expressions decouples
    // them, and is a change that belongs in desk.ts.
    deskView.charge = clamp01(frame.popMeter / 100);

    overlayState.announcement = frame.announcement;
    overlayState.announcementTone =
      frame.phase === "lost" ? "bad" : pressure > 0.7 ? "alert" : frame.combo >= 3 ? "good" : "info";
    overlayState.announcementAge = frame.announcementAge;
    overlayState.score = frame.score;
    overlayState.combo = frame.combo;
    overlayState.comboTier = patienceTier(frame.combo);
    overlayState.timeRemaining = Math.max(0, ROUND_SECONDS - frame.elapsed);
    overlayState.activeQuestions = frame.questions.length;
    overlayState.slowSeconds = frame.slowSeconds;
    overlayState.difficultyLabel = frame.difficultyLabel;

    /* --- adaptive audio ------------------------------------------ */
    audio.setIntensity(clamp01(pressure * 0.75 + clamp01(frame.combo / 10) * 0.25));
    if (musicRunning && frame.phase !== "playing") {
      audio.stopMusic();
      musicRunning = false;
    }

    /* --- module updates ------------------------------------------ */
    particles.update(dt);
    studio.update(s);
    question.update(views, s);
    desk.update(deskView, s);
    effects.update(s);
    overlay.update(s);

    /* --- draw: EXACTLY the documented render order ---------------- */
    const ctx = offctx;
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    // The buffer can carry alpha (see the context creation above), so the frame
    // is explicitly floored to the room's darkest value rather than relying on
    // an opaque backing store. `studio.drawBackground` covers this immediately
    // on any frame where the set is live; this is what holds the frame opaque
    // during the boot, before the first layer lands.
    ctx.fillStyle = "#080604";
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const target = pickTarget(firingAngle, frame);

    ctx.save();
    camera.apply(ctx, GAME_WIDTH, GAME_HEIGHT);
    studio.drawBackground(ctx, s);
    particles.draw(ctx, "behind");
    desk.drawAimGuide(ctx, deskView, s, target);
    question.drawShadows(ctx, views, s);
    question.draw(ctx, views, s);
    effects.drawShots(ctx, shotViews, s);
    desk.draw(ctx, deskView, s);
    particles.draw(ctx, "front");
    effects.drawOverlayEffects(ctx, s);
    studio.drawForeground(ctx, s);
    ctx.restore();

    // Broadcast furniture is composited in the truck, not bolted to the studio
    // wall: it sits outside the camera transform so shake never rattles it.
    overlay.draw(ctx, s, overlayState);

    // ...and the standby card sits above even that, because a plant that has
    // not taken the studio to air is not inserting the show's graphics either.
    studio.drawStandby(ctx, s);

    /* --- post ----------------------------------------------------- */
    drivePost(frame);
    present();

    governQuality(now() - started, rawDt);
  }

  /* ---------------- configuration --------------------------------- */

  function setQuality(tier: QualityTier): void {
    if (disposed || tier === quality || !TIER_ORDER.includes(tier)) return;
    quality = tier;
    ctxView.quality = tier;
    post?.setQuality(tier);
    applyRenderScale();
    sizePresentation();
  }

  function setReducedMotion(reduced: boolean): void {
    reducedMotion = reduced;
    ctxView.reducedMotion = reduced;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      audio.stopMusic();
    } catch {
      /* an unbuilt audio graph has nothing to stop */
    }
    audio.dispose();
    post?.dispose();
    particles.clear();
    motions.clear();
    views.length = 0;
    shotViews.length = 0;
    blitCtx = null;
  }

  /* ---------------- boot ------------------------------------------ */
  applyRenderScale();
  sizePresentation();
  studio.resize(GAME_WIDTH, GAME_HEIGHT);
  // Deliberately *not* `bakery.warm()`: that was a second of straight-line work
  // between the component mounting and the first frame appearing, which is a
  // black screen the player has to sit through. `pumpBoot` spreads it instead.

  return {
    resize,
    tick,
    render,
    onFire,
    onHit,
    onReject,
    onAnswer,
    onLand,
    onPopOff,
    onImpact,
    announce(text: string, tone: AnnounceTone = "info", seconds = 2.6): void {
      overlay.announce(text, tone, seconds);
    },
    popup(x: number, y: number, text: string, color?: string, size?: number): void {
      effects.popup(x, y, text, color, size);
    },
    setQuality,
    setReducedMotion,
    setMuted(muted: boolean): void {
      audio.setMuted(muted);
    },
    unlockAudio(): void {
      audio.unlock();
      if (lastPhase === "playing" && !musicRunning) {
        audio.startMusic();
        musicRunning = true;
      }
    },
    dispose,
    get quality(): QualityTier {
      return quality;
    },
    get reducedMotion(): boolean {
      return reducedMotion;
    },
    get postProcessing(): boolean {
      return postActive();
    },
    get clock(): Clock {
      return clock;
    },
    get camera(): Camera {
      return camera;
    },
    get audio(): MixerAudioEngine {
      return audio;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Lazy browser access — nothing here runs during server rendering
 * ------------------------------------------------------------------ */

function createCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  } catch {
    return null;
  }
}

/**
 * True when WebGL is missing or is being serviced by a software rasteriser.
 * Probed on a throwaway 1×1 canvas so the real surface is never poisoned, and
 * the probe context is released immediately.
 */
function detectSoftwareRenderer(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const gl =
      (probe.getContext("webgl2") as WebGLRenderingContext | null) ??
      (probe.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return true;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const name = typeof raw === "string" ? raw.toLowerCase() : "";
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|generic renderer/.test(
      name,
    );
  } catch {
    return false;
  }
}

function detectReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return 0;
}

/** Re-exported so the game loop and the QA bridge share one hue vocabulary. */
export const SCENE_COLORS = { hemi: HEMI, hemiHot: HEMI_HOT, bone: BONE } as const;
