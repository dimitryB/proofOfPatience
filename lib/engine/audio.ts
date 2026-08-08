/**
 * POP — synthesised broadcast-arcade audio.
 *
 * There are no audio files in this project. Every click, thump, chord, crowd
 * and bar of score is generated from oscillators, filtered noise and baked
 * buffers at runtime, through a mix chain built the way a broadcast desk is
 * built: sources into buses, buses into a glue compressor, glue into a safety
 * limiter, and a single send-based reverb so that everything is heard *in one
 * room* instead of each sound carrying its own private ambience.
 *
 * Signal flow (built once, on the first `unlock()`):
 *
 *   sfx voices ──► sfxBus ──► sfxUser ─┐
 *                    │                 │
 *                    └► voiceSend ──┐  │
 *   crowd voices ► crowdBus ► crowdUser ┤
 *                    │                 │
 *   music voices ─► layers ─► musicFilter ─► musicBus ─► musicDuck ─► musicUser ─┐
 *                    │                 │                                        │
 *                    └► musicSend ──┐  │                                        │
 *                                   ▼  ▼                                        ▼
 *                    bus room sends ─► preDelay ─► convolver ─► reverbReturn ─► sumBus
 *                                                                              │
 *                       sumBus ─► dcCut ─► glue ─► limiter ─► master ─► out
 *
 * The three `*User` gains are the player's mixer (see `MixerAudioEngine`).
 * They sit *after* each bus so the shipped trims, the music fade-in and the
 * sidechain keep their own automation and the mixer only multiplies; every
 * change to them ramps, and switching a bus off also stops its scheduling.
 *
 * Constraints this file honours (see docs/ENGINE_ARCHITECTURE.md):
 *  - no `Math.random`: an injected `Rng` (or a private deterministic stream)
 *    drives every stochastic choice, so a recorded session is reproducible;
 *  - no `window`/`document`/Node built-ins at module scope — the app server
 *    renders, so the AudioContext constructor is looked up lazily and the whole
 *    engine degrades to a silent no-op when the API is missing;
 *  - nothing heavy is built per sound: impulse response, noise beds, applause,
 *    saturation curves and periodic waves are baked once and shared;
 *  - voices are pooled, priority-limited and retrigger-gated, so machine-gun
 *    fire thins instead of stacking into mud or slamming the limiter;
 *  - the music scheduler is lookahead-based off `currentTime`, never
 *    `setInterval`-per-note, so the groove cannot drift.
 */

import type { AudioEngine, Rng, SfxId } from "../render/types";

/* ------------------------------------------------------------------ *
 * Tuning constants
 * ------------------------------------------------------------------ */

/** Master trim. Leaves ~1.5 dB of headroom under the limiter at full tilt. */
const MASTER_LEVEL = 0.82;
/** Static level of the music bus once faded in. SFX always win the mix. */
const MUSIC_LEVEL = 0.46;
/** Hard ceiling on simultaneous SFX voices. Music is budgeted separately. */
const MAX_VOICES = 26;
/** Minimum scheduling window ahead of the clock; the pump widens it if woken late. */
const LOOKAHEAD = 0.14;
/** Scheduler wake interval. Comfortably below the lookahead window. */
const PUMP_MS = 25;
/** Everything is scheduled a hair in the future so envelopes start cleanly. */
const SCHEDULE_AHEAD = 0.006;
/** Score tempo. A 16th step is 0.15625 s; the loop is four bars = 10 s. */
const BPM = 96;
const STEP_SECONDS = 60 / BPM / 4;
/** Reverb impulse length. Long enough for a studio, short enough to be cheap. */
const IR_SECONDS = 1.35;
/** Pre-delay in front of the convolver: the room answers a beat after the hit. */
const IR_PREDELAY = 0.014;

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Equal-temperament ratio for a semitone offset. */
function semi(steps: number): number {
  return Math.pow(2, steps / 12);
}

/** Frequency of a semitone offset from A2 (110 Hz), the key centre of the score. */
function noteA2(steps: number): number {
  return 110 * semi(steps);
}

/**
 * Private deterministic stream (mulberry32). Used when the caller does not
 * inject an `Rng`; identical shape so the two are interchangeable.
 */
function localRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length) % items.length],
    fork: (salt = 1) => localRng((state ^ Math.imul(salt | 1, 0x9e3779b9)) >>> 0),
  };
  return rng;
}

function isRng(value: unknown): value is Rng {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Rng).next === "function" &&
    typeof (value as Rng).range === "function"
  );
}

/** Lazy, guarded constructor lookup. Never touched at module scope. */
type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Exactly what `WaveShaperNode.curve` accepts, across TypeScript versions. */
type ShaperCurve = NonNullable<WaveShaperNode["curve"]>;

function findAudioContextCtor(): AudioContextCtor | null {
  if (typeof globalThis === "undefined") return null;
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/* ------------------------------------------------------------------ *
 * Public options
 * ------------------------------------------------------------------ */

export interface AudioEngineOptions {
  /** Deterministic stream. Forked internally, so the caller never desyncs. */
  rng?: Rng;
  /** Seed for the private stream when no `rng` is injected. */
  seed?: number;
  /** Master trim, 0–1. Defaults to a broadcast-safe 0.82. */
  volume?: number;
  /** Start muted (the engine still builds and schedules, it is just silent). */
  muted?: boolean;
  /**
   * Opening mixer position. Anything omitted keeps its default (on, at 1),
   * so passing nothing is exactly today's mix. Applied before the graph
   * exists, which is why a restored setting never fades in from the default.
   */
  mix?: Partial<AudioMixState>;
}

/* ------------------------------------------------------------------ *
 * Per-bus mixer — the surface `lib/render/types.ts` does not declare
 * ------------------------------------------------------------------ */

/**
 * The player's mixer position.
 *
 * Three switchable buses, each with its own fader, under one master trim.
 * Levels are 0–1 *relative to the shipped mix*: 1 means "as designed", which
 * is why every default is 1 and an untouched engine sounds exactly as it did
 * before this surface existed.
 */
export interface AudioMixState {
  /** Master output trim, 0–1, multiplied into the engine's own headroom trim. */
  master: number;
  /** Adaptive score on/off. Off also stops the note scheduler. */
  music: boolean;
  musicLevel: number;
  /** Gameplay and UI effects on/off. Off skips voice construction entirely. */
  sfx: boolean;
  sfxLevel: number;
  /** Audience bus: the murmur bed, cheers and groans. */
  crowd: boolean;
  crowdLevel: number;
}

/**
 * `AudioEngine` plus per-bus control.
 *
 * `AudioEngine` lives in `lib/render/types.ts`, which is the frozen integration
 * contract and may not be edited, so the mixer is added here as a structural
 * extension: `createAudioEngine` returns this, every existing consumer keeps
 * seeing a plain `AudioEngine`, and the settings UI asks for the wider type.
 *
 * Every setter ramps. Nothing in here writes a gain step onto a live bus.
 */
export interface MixerAudioEngine extends AudioEngine {
  setMasterLevel(level: number): void;
  setMusicEnabled(on: boolean): void;
  setMusicLevel(level: number): void;
  setSfxEnabled(on: boolean): void;
  setSfxLevel(level: number): void;
  setCrowdEnabled(on: boolean): void;
  setCrowdLevel(level: number): void;
  /** Current position of every fader and switch. A fresh snapshot per read. */
  readonly mix: AudioMixState;
}

/** Everything on, at the shipped levels. */
export const DEFAULT_MIX: AudioMixState = {
  master: 1,
  music: true,
  musicLevel: 1,
  sfx: true,
  sfxLevel: 1,
  crowd: true,
  crowdLevel: 1,
};

/**
 * Sounds that belong to the audience rather than to the show.
 *
 * `crowd-murmur` is absent because it is not a one-shot at all: it is a
 * persistent bed with its own start/stop path (see `setMurmur`).
 */
const CROWD_SFX: ReadonlySet<SfxId> = new Set<SfxId>(["crowd-cheer", "crowd-groan"]);

/** Fade times. Long enough that no bus change is a step, short enough to feel like a switch. */
const BUS_FADE = 0.28;
const LEVEL_FADE = 0.14;

/* ------------------------------------------------------------------ *
 * Internal shapes
 * ------------------------------------------------------------------ */

/** Per-sound mix policy: level, room, and how the limiter treats it. */
interface SfxProfile {
  /** Peak voice gain before the bus. */
  gain: number;
  /** 0 = expendable UI chatter, 9 = never steal this. */
  priority: number;
  /** Maximum simultaneous copies of this id. */
  poly: number;
  /** Minimum seconds between retriggers; protects against event storms. */
  gap: number;
  /** Voice-level reverb send. */
  send: number;
  /** Automatic music sidechain: [amount, seconds]. */
  duck?: readonly [number, number];
}

interface FilterOptions {
  type: BiquadFilterType;
  freq: number;
  /** Sweep target; `time` is how long the sweep takes. */
  to?: number;
  time?: number;
  q?: number;
  qTo?: number;
  gainDb?: number;
}

interface ToneOptions {
  type?: OscillatorType;
  wave?: PeriodicWave;
  freq: number;
  /** Pitch glide target. */
  to?: number;
  glide?: number;
  curve?: "exp" | "lin";
  detune?: number;
  level: number;
  attack?: number;
  decay: number;
  /** Sustain as a fraction of peak; 0 means a pure percussive decay. */
  sustain?: number;
  hold?: number;
  release?: number;
  delay?: number;
  filter?: FilterOptions;
  filter2?: FilterOptions;
  /** Soft-clip index: 0 none, 1 warm, 2 hard. */
  drive?: 0 | 1 | 2;
  /** Extra reverb send for this layer only, added to the voice send. */
  send?: number;
  pan?: number;
  vibrato?: { rate: number; cents: number };
  tremolo?: { rate: number; depth: number };
}

type NoiseSource = "white" | "pink" | "applause";

interface NoiseOptions {
  source?: NoiseSource;
  level: number;
  attack?: number;
  decay: number;
  sustain?: number;
  hold?: number;
  release?: number;
  delay?: number;
  filter?: FilterOptions;
  filter2?: FilterOptions;
  /** Playback rate sweep — shifts the noise spectrum like a tape slowdown. */
  rate?: number;
  rateTo?: number;
  drive?: 0 | 1 | 2;
  send?: number;
  pan?: number;
  /** Read offset into the shared buffer, so repeats do not phase-lock. */
  offset?: number;
}

/** Everything a sound builder is handed for one trigger. */
interface Emit {
  /** Absolute start time. */
  t: number;
  /** Voice output node (pre pan/bus). */
  out: AudioNode;
  /** Convolver input — layers add extra room by connecting here. */
  room: AudioNode;
  /** Pitch multiplier from `options.rate` plus any internal streak pitching. */
  rate: number;
  /** Envelope scale derived from `rate`; a tape-style, mild coupling. */
  timeScale: number;
  /** Extends the voice lifetime so the limiter knows when it is really done. */
  keep(until: number): void;
  /**
   * Registers a source so voice stealing can stop it. `ends` lets the voice
   * track which source finishes last, and therefore which one may release it.
   */
  own(node: AudioScheduledSourceNode, ends: number): void;
  /**
   * Registers a node that connects *outside* the voice's own subgraph — in
   * practice the reverb sends. Everything else dies when the voice output is
   * disconnected, but a node feeding the convolver stays reachable from the
   * destination, so it has to be released explicitly.
   */
  escape(node: AudioNode): void;
}

interface Voice {
  id: SfxId;
  priority: number;
  started: number;
  ends: number;
  out: GainNode;
  sources: AudioScheduledSourceNode[];
  /** Nodes connected to the shared reverb input; see `Emit.escape`. */
  escapes: AudioNode[];
  /** The source scheduled to stop last; its `onended` frees the voice. */
  lastSource: AudioScheduledSourceNode | null;
  lastSourceEnds: number;
  stolen: boolean;
}

/* ------------------------------------------------------------------ *
 * Mix policy table
 * ------------------------------------------------------------------ */

const PROFILES: Record<SfxId, SfxProfile> = {
  fire: { gain: 0.34, priority: 5, poly: 4, gap: 0.026, send: 0.1 },
  hit: { gain: 0.42, priority: 6, poly: 4, gap: 0.02, send: 0.22 },
  "hit-wrong": { gain: 0.4, priority: 6, poly: 3, gap: 0.04, send: 0.2 },
  answer: { gain: 0.4, priority: 7, poly: 3, gap: 0.03, send: 0.42, duck: [0.16, 0.35] },
  "answer-big": { gain: 0.5, priority: 8, poly: 2, gap: 0.08, send: 0.52, duck: [0.34, 0.9] },
  land: { gain: 0.48, priority: 7, poly: 3, gap: 0.05, send: 0.5, duck: [0.2, 0.4] },
  pop: { gain: 0.72, priority: 9, poly: 1, gap: 0.4, send: 0.66, duck: [0.55, 1.8] },
  "combo-up": { gain: 0.3, priority: 5, poly: 3, gap: 0.03, send: 0.3 },
  "slowmo-in": { gain: 0.36, priority: 8, poly: 1, gap: 0.2, send: 0.42, duck: [0.26, 0.9] },
  "slowmo-out": { gain: 0.32, priority: 8, poly: 1, gap: 0.2, send: 0.3 },
  warning: { gain: 0.3, priority: 8, poly: 1, gap: 0.5, send: 0.26, duck: [0.2, 0.6] },
  countdown: { gain: 0.28, priority: 7, poly: 2, gap: 0.05, send: 0.14 },
  tick: { gain: 0.17, priority: 3, poly: 2, gap: 0.03, send: 0.05 },
  "ui-hover": { gain: 0.11, priority: 1, poly: 2, gap: 0.035, send: 0.06 },
  "ui-click": { gain: 0.2, priority: 4, poly: 3, gap: 0.02, send: 0.1 },
  "ui-open": { gain: 0.2, priority: 4, poly: 2, gap: 0.05, send: 0.24 },
  "ui-close": { gain: 0.19, priority: 4, poly: 2, gap: 0.05, send: 0.2 },
  "crowd-murmur": { gain: 0.34, priority: 2, poly: 1, gap: 0.2, send: 0.4 },
  "crowd-cheer": { gain: 0.46, priority: 7, poly: 1, gap: 0.5, send: 0.7, duck: [0.28, 1.4] },
  "crowd-groan": { gain: 0.42, priority: 6, poly: 1, gap: 0.5, send: 0.6, duck: [0.2, 1] },
  "round-start": { gain: 0.5, priority: 9, poly: 1, gap: 0.4, send: 0.44, duck: [0.34, 1] },
  "round-win": { gain: 0.54, priority: 9, poly: 1, gap: 0.5, send: 0.58, duck: [0.45, 1.8] },
  "round-lose": { gain: 0.5, priority: 9, poly: 1, gap: 0.5, send: 0.55, duck: [0.45, 1.8] },
};

/* ------------------------------------------------------------------ *
 * Score patterns
 * ------------------------------------------------------------------ */

/**
 * Four-bar loop in A minor: i – VI – III – VII (Am – F – C – G). Values are
 * semitone offsets from A2, so `noteA2()` turns them into frequencies.
 */
const CHORDS: readonly (readonly number[])[] = [
  [0, 3, 7, 12], // Am : A C E A
  [-4, 0, 3, 8], // F  : F A C F
  [3, 7, 10, 15], // C  : C E G C
  [-2, 2, 5, 10], // G  : G B D G
];
const BASS_ROOTS: readonly number[] = [0, -4, 3, -2];

/** 16-step masks; density rises with intensity. 1 = play. */
const BASS_MASKS: readonly string[] = [
  "1000000010000000",
  "1000001010000010",
  "1001001010010010",
];
const KICK_MASK = "1000000010000000";
const KICK_MASK_HOT = "1000001010000010";

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

/**
 * Creates the audio engine. Safe to call during server rendering: nothing
 * touches the Web Audio API until `unlock()` runs inside a user gesture.
 *
 * Contract note — the ownership table specifies `createAudioEngine`, without
 * pinning the argument list. Sibling factories take an options bag containing
 * the shared `Rng`, so that is the primary shape here; a bare `Rng` is also
 * accepted because it is the other obvious call site spelling, and being wrong
 * about it would cost the caller a compile error for no reason.
 */
export function createAudioEngine(options?: AudioEngineOptions | Rng): MixerAudioEngine {
  const opts: AudioEngineOptions = isRng(options) ? { rng: options } : (options ?? {});
  // One draw from the injected stream at construction, then a private child, so
  // audio jitter can never advance the renderer's stream.
  const rng: Rng = opts.rng ? opts.rng.fork(0x41554449) : localRng(opts.seed ?? 0x504f5021);
  /** The engine's own headroom trim. The player's master fader scales this. */
  const masterTrim = clamp(opts.volume ?? MASTER_LEVEL, 0, 1);

  let ctx: AudioContext | null = null;
  let disposed = false;
  let muted = opts.muted === true;

  /* ---------- mixer position ---------- */
  const startMix = opts.mix ?? {};
  let masterUser = clamp01(startMix.master ?? DEFAULT_MIX.master);
  let musicOn = startMix.music ?? DEFAULT_MIX.music;
  let musicUserLevel = clamp01(startMix.musicLevel ?? DEFAULT_MIX.musicLevel);
  let sfxOn = startMix.sfx ?? DEFAULT_MIX.sfx;
  let sfxUserLevel = clamp01(startMix.sfxLevel ?? DEFAULT_MIX.sfxLevel);
  let crowdOn = startMix.crowd ?? DEFAULT_MIX.crowd;
  let crowdUserLevel = clamp01(startMix.crowdLevel ?? DEFAULT_MIX.crowdLevel);

  /* ---------- graph ---------- */
  let master: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  /** Player fader for the SFX bus. Separate from `sfxBus` so the shipped trim survives. */
  let sfxUser: GainNode | null = null;
  /** Audience bus. Same trim as the SFX bus, so splitting it out changed no level. */
  let crowdBus: GainNode | null = null;
  let crowdUser: GainNode | null = null;
  let musicUser: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let musicDuck: GainNode | null = null;
  /**
   * Per-bus reverb sends. The room is shared, but the amount each bus puts
   * into it has to follow that bus's switch and fader — otherwise a muted bus
   * keeps ringing through the convolver, which is the one place "off" would
   * audibly not mean off.
   */
  let sfxRoom: GainNode | null = null;
  let crowdRoom: GainNode | null = null;
  let musicRoom: GainNode | null = null;
  let musicFilter: BiquadFilterNode | null = null;
  let reverbIn: DelayNode | null = null;
  /** Kept so the impulse response can be installed after the gesture returns. */
  let convolver: ConvolverNode | null = null;
  let hasPanner = false;

  /** Music layer sub-buses; each fades independently with intensity. */
  let layerPad: GainNode | null = null;
  let layerBass: GainNode | null = null;
  let layerPerc: GainNode | null = null;
  let layerArp: GainNode | null = null;
  let layerTension: GainNode | null = null;

  /* ---------- baked assets ---------- */
  let whiteBuffer: AudioBuffer | null = null;
  let pinkBuffer: AudioBuffer | null = null;
  let applauseBuffer: AudioBuffer | null = null;
  let waveChime: PeriodicWave | null = null;
  let waveOrgan: PeriodicWave | null = null;
  let waveBuzz: PeriodicWave | null = null;
  let waveVoice: PeriodicWave | null = null;
  // Typed off the DOM signature: newer TypeScript makes the typed arrays
  // generic over their backing buffer, and `Float32Array` alone widens to
  // `ArrayBufferLike`, which the `curve` setter rejects.
  const driveCurves: (ShaperCurve | null)[] = [null, null, null];

  /* ---------- runtime state ---------- */
  const voices: Voice[] = [];
  const lastPlayed = new Map<SfxId, number>();
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPumpTime = 0;
  /** Smoothed observed wake interval; drives the adaptive scheduler window. */
  let pumpWake = PUMP_MS / 1000;

  let musicWanted = false;
  let musicPlaying = false;
  let musicStep = 0;
  let nextStepTime = 0;
  let intensityTarget = 0.2;
  let intensity = 0.2;
  const appliedLayer = { pad: -1, bass: -1, perc: -1, arp: -1, tension: -1, cutoff: -1 };
  /** Tempo/pitch multiplier for slow motion; 1 = normal. */
  let musicRate = 1;
  let musicRateTarget = 1;

  /** What the game asked for, 0–1, before the audience switch is applied. */
  let murmurWanted = 0;
  /** What the bed is actually driven to: `murmurWanted` gated by the switch. */
  let murmurLevel = 0;
  let murmurAlive = false;
  let murmurSource: AudioBufferSourceNode | null = null;
  let murmurGain: GainNode | null = null;
  let murmurBlipBus: GainNode | null = null;
  const murmurNodes: AudioScheduledSourceNode[] = [];
  let nextBlipTime = 0;

  /** Consecutive-event pitch ladders. */
  let fireStreak = 0;
  let lastFireAt = -99;
  let hitStreak = 0;
  let lastHitAt = -99;
  let comboRung = 0;
  let lastComboAt = -99;

  /* ------------------------------------------------------------------ *
   * Mixer targets
   *
   * Each bus gain is a pure function of the mixer position, so a switch and a
   * fader can never disagree about where a bus should sit: everything writes
   * state and then re-derives.
   * ------------------------------------------------------------------ */

  function masterTarget(): number {
    return muted ? 0 : masterTrim * masterUser;
  }

  function musicTarget(): number {
    return musicOn ? musicUserLevel : 0;
  }

  function sfxTarget(): number {
    return sfxOn ? sfxUserLevel : 0;
  }

  function crowdTarget(): number {
    return crowdOn ? crowdUserLevel : 0;
  }

  /**
   * Moves a gain to a target without a step. A hard write to `.value` on a bus
   * carrying signal is a click — a discontinuity in the waveform — so every
   * mixer change goes through here.
   *
   * Toward silence the ramp is exponential and then pinned to a true zero:
   * a linear fade to zero sounds like it holds and then drops, and an
   * exponential ramp can never reach zero on its own.
   */
  function rampTo(param: AudioParam | null, target: number, seconds: number): void {
    const context = live();
    if (!param || !context) return;
    const t = context.currentTime;
    const s = Math.max(0.02, seconds);
    param.cancelScheduledValues(t);
    param.setValueAtTime(Math.max(0.0001, param.value), t);
    if (target <= 0.0002) {
      param.exponentialRampToValueAtTime(0.0001, t + s);
      param.setValueAtTime(0, t + s + 0.005);
    } else {
      param.linearRampToValueAtTime(target, t + s);
    }
  }

  /* ------------------------------------------------------------------ *
   * Baking
   * ------------------------------------------------------------------ */

  /** Soft clip: tanh normalised so ±1 maps to ±1, with natural makeup gain. */
  function curve(index: 1 | 2): ShaperCurve {
    const cached = driveCurves[index];
    if (cached) return cached;
    const amount = index === 1 ? 2.2 : 5.5;
    const n = 1024;
    const table: ShaperCurve = new Float32Array(n);
    const denom = Math.tanh(amount);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * 2 - 1;
      table[i] = Math.tanh(amount * x) / denom;
    }
    driveCurves[index] = table;
    return table;
  }

  /**
   * Seeds an inline xorshift32 from the injected stream.
   *
   * Bulk buffer fills run to ~800k samples; going through the `Rng` interface
   * for each one costs tens of milliseconds inside the unlock gesture, where a
   * hitch is visible. Three shifts per sample is not. Determinism is preserved
   * because the seed itself is drawn from `rng`.
   *
   * Use as: `s = step(s)` then `s / 2147483648 - 1` for a sample in [−1, 1).
   */
  function noiseSeed(salt: number): number {
    return (rng.fork(salt).int(1, 0x7ffffffe) | 1) >>> 0;
  }

  function step(state: number): number {
    let s = state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  }

  /**
   * A random read offset that is always inside the buffer. Playing from a
   * different point each time is what stops repeated noise layers from sounding
   * like the same recorded click; the margin keeps a non-looping source from
   * starting so close to the end that it plays silence.
   */
  function readOffset(buffer: AudioBuffer | null): number {
    if (!buffer) return 0;
    return rng.next() * buffer.duration * 0.9;
  }

  function white(context: AudioContext): AudioBuffer {
    if (whiteBuffer) return whiteBuffer;
    // Looping, and only ever used for transients and short tails, so a short
    // buffer is plenty — and this one is baked inside the unlock gesture.
    const length = Math.floor(context.sampleRate * 1.2);
    const buffer = context.createBuffer(2, length, context.sampleRate);
    for (let c = 0; c < 2; c += 1) {
      const data = buffer.getChannelData(c);
      let s = noiseSeed(0x5748 + c);
      for (let i = 0; i < length; i += 1) {
        s = step(s);
        data[i] = s / 2147483648 - 1;
      }
    }
    whiteBuffer = buffer;
    return buffer;
  }

  /**
   * Pink noise (Paul Kellet's refined filter bank) baked as a *seamless* loop:
   * the tail is crossfaded into the head so the murmur bed can run for the whole
   * round without a seam tick every pass.
   */
  function pink(context: AudioContext): AudioBuffer {
    if (pinkBuffer) return pinkBuffer;
    const sr = context.sampleRate;
    const loop = Math.floor(sr * 4);
    const fade = Math.floor(sr * 0.35);
    const total = loop + fade;
    const buffer = context.createBuffer(2, loop, sr);
    const raw = new Float32Array(total);
    for (let c = 0; c < 2; c += 1) {
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      let s = noiseSeed(0x504b + c);
      for (let i = 0; i < total; i += 1) {
        s = step(s);
        const w = s / 2147483648 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.108;
        b6 = w * 0.115926;
      }
      const data = buffer.getChannelData(c);
      data.set(raw.subarray(0, loop));
      // Equal-power-ish linear crossfade of the overrun into the head.
      for (let i = 0; i < fade; i += 1) {
        const k = i / fade;
        data[i] = raw[i] * k + raw[loop + i] * (1 - k);
      }
    }
    pinkBuffer = buffer;
    return buffer;
  }

  /**
   * Applause. A crowd clapping is a *point process*, not a noise floor: a few
   * hundred short transients whose density decays, each one a broadband tick
   * plus a resonant ring from the cupped palms. Baked once; the cheer just
   * plays it through a shaping filter.
   */
  function applause(context: AudioContext): AudioBuffer {
    if (applauseBuffer) return applauseBuffer;
    const sr = context.sampleRate;
    const duration = 2.8;
    const length = Math.floor(sr * duration);
    const buffer = context.createBuffer(2, length, sr);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    // Clap *placement* is low-count and stays on the readable Rng; the samples
    // inside each clap are bulk work and use the inline generator.
    const stream = rng.fork(0x4150);
    let noiseState = noiseSeed(0x4151);
    const clapLength = Math.floor(sr * 0.03);
    let t = 0;
    while (t < duration) {
      // Density: a fast ramp in, a long thinning tail. Gap is the inverse.
      const shape = Math.min(1, t / 0.18) * Math.exp(-t / 1.25);
      const gap = stream.range(0.006, 0.028) / Math.max(0.08, shape);
      t += gap;
      if (t >= duration) break;
      const start = Math.floor(t * sr);
      const amp = stream.range(0.3, 1) * (0.35 + 0.65 * shape);
      const ringHz = stream.range(900, 2400);
      const panR = stream.next();
      const gainL = Math.sqrt(1 - panR) * amp;
      const gainR = Math.sqrt(panR) * amp;
      for (let k = 0; k < clapLength && start + k < length; k += 1) {
        const age = k / sr;
        noiseState = step(noiseState);
        const crack = (noiseState / 2147483648 - 1) * Math.exp(-age / 0.0032);
        const ring = Math.sin(TAU * ringHz * age) * Math.exp(-age / 0.0095) * 0.35;
        const sample = crack + ring;
        left[start + k] += sample * gainL;
        right[start + k] += sample * gainR;
      }
    }
    // Normalise so the cheer's envelope is the only thing shaping the level.
    let peak = 1e-6;
    for (let i = 0; i < length; i += 1) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    const norm = 0.85 / peak;
    for (let i = 0; i < length; i += 1) {
      left[i] *= norm;
      right[i] *= norm;
    }
    applauseBuffer = buffer;
    return buffer;
  }

  /**
   * Generated impulse response for the studio.
   *
   * Three ingredients, which is what separates a room from a delay:
   *  1. discrete early reflections — the walls and the LED wall behind the host,
   *     offset per channel so the image is wide instead of dead centre;
   *  2. a diffuse tail — noise under `(1 - e^{-t/τa}) · e^{-t/τd}`, i.e. a short
   *     build-up followed by exponential decay (RT60 ≈ τd·ln 1000 ≈ 1.3 s);
   *  3. frequency-dependent damping — a one-pole lowpass whose coefficient
   *     shrinks over the tail, so highs die before lows exactly as air and soft
   *     furnishings make them, plus a one-pole highpass to keep the tail from
   *     muddying the sub range.
   * The two channels use independent streams and slightly different decay
   * constants, which decorrelates them and gives the reverb real width.
   */
  function impulse(context: AudioContext): AudioBuffer {
    const sr = context.sampleRate;
    const length = Math.floor(sr * IR_SECONDS);
    const buffer = context.createBuffer(2, length, sr);
    const stream = rng.fork(0x4952);
    const earlyTimes = [0.0071, 0.0113, 0.0169, 0.0231, 0.0304, 0.0417, 0.0538, 0.0672];

    for (let c = 0; c < 2; c += 1) {
      const data = buffer.getChannelData(c);
      const tauDecay = c === 0 ? 0.19 : 0.203;
      const skew = c === 0 ? 1 : 1.031;
      let lp = 0;
      let hpPrev = 0;
      let lpPrev = 0;
      let s = noiseSeed(0x4952 + c);
      for (let i = 0; i < length; i += 1) {
        const t = i / sr;
        const build = 1 - Math.exp(-t / 0.011);
        const env = build * Math.exp(-t / tauDecay);
        s = step(s);
        const x = s / 2147483648 - 1;
        // Damping coefficient falls from bright to dark across the tail.
        const coef = 0.62 - 0.52 * (t / IR_SECONDS);
        lp += coef * (x - lp);
        const hp = 0.995 * (hpPrev + lp - lpPrev);
        hpPrev = hp;
        lpPrev = lp;
        data[i] = hp * env;
      }
      for (let e = 0; e < earlyTimes.length; e += 1) {
        const index = Math.floor(earlyTimes[e] * skew * sr);
        if (index >= length) continue;
        const sign = e % 2 === 0 ? 1 : -1;
        data[index] += sign * 0.62 * Math.pow(0.78, e) * stream.range(0.8, 1.2);
      }
    }
    // Fixed output level rather than convolver auto-normalisation, so the send
    // amount in each profile means the same thing on every device.
    let peak = 1e-6;
    for (let c = 0; c < 2; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
    }
    const norm = 0.42 / peak;
    for (let c = 0; c < 2; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i += 1) data[i] *= norm;
    }
    return buffer;
  }

  /** Harmonic recipes for the recurring timbres. Index 0 is DC and stays 0. */
  function periodic(context: AudioContext, partials: readonly number[]): PeriodicWave {
    const real = new Float32Array(partials.length + 1);
    const imag = new Float32Array(partials.length + 1);
    for (let i = 0; i < partials.length; i += 1) imag[i + 1] = partials[i];
    return context.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  /* ------------------------------------------------------------------ *
   * Graph construction
   * ------------------------------------------------------------------ */

  function build(context: AudioContext): void {
    hasPanner = typeof context.createStereoPanner === "function";

    master = context.createGain();
    master.gain.value = masterTarget();
    master.connect(context.destination);

    // Safety limiter: brick-ish, fast, only ever catching peaks.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.11;
    limiter.connect(master);

    // Broadcast glue: gentle, wide knee, slow enough to breathe with the music.
    const glue = context.createDynamicsCompressor();
    glue.threshold.value = -17;
    glue.knee.value = 14;
    glue.ratio.value = 2.8;
    glue.attack.value = 0.013;
    glue.release.value = 0.24;
    glue.connect(limiter);

    // Subsonic cut — impacts carry a lot of sub that only eats headroom.
    const dcCut = context.createBiquadFilter();
    dcCut.type = "highpass";
    dcCut.frequency.value = 28;
    dcCut.Q.value = 0.6;
    dcCut.connect(glue);

    const sumBus = context.createGain();
    sumBus.gain.value = 1;
    sumBus.connect(dcCut);

    // Player faders sit between each bus and the sum, so the shipped trims,
    // the sidechain and the music fade-in all keep their own automation and
    // the mixer only ever multiplies. Built at their target value rather than
    // ramped to it: at this point the graph is silent, so there is nothing to
    // click, and a restored setting is correct from the first sample.
    sfxUser = context.createGain();
    sfxUser.gain.value = sfxTarget();
    sfxUser.connect(sumBus);

    sfxBus = context.createGain();
    sfxBus.gain.value = 0.92;
    sfxBus.connect(sfxUser);

    crowdUser = context.createGain();
    crowdUser.gain.value = crowdTarget();
    crowdUser.connect(sumBus);

    // The audience used to share the SFX bus; the trim is copied verbatim so
    // splitting it out is inaudible at the default mix.
    crowdBus = context.createGain();
    crowdBus.gain.value = 0.92;
    crowdBus.connect(crowdUser);

    musicUser = context.createGain();
    musicUser.gain.value = musicTarget();
    musicUser.connect(sumBus);

    musicDuck = context.createGain();
    musicDuck.gain.value = 1;
    musicDuck.connect(musicUser);

    musicBus = context.createGain();
    musicBus.gain.value = 0;
    musicBus.connect(musicDuck);

    musicFilter = context.createBiquadFilter();
    musicFilter.type = "lowpass";
    musicFilter.frequency.value = 500;
    musicFilter.Q.value = 0.9;
    musicFilter.connect(musicBus);

    layerPad = context.createGain();
    layerBass = context.createGain();
    layerPerc = context.createGain();
    layerArp = context.createGain();
    layerTension = context.createGain();
    layerPad.gain.value = 0.9;
    layerBass.gain.value = 0.6;
    layerPerc.gain.value = 0;
    layerArp.gain.value = 0;
    layerTension.gain.value = 0;
    layerPad.connect(musicFilter);
    layerBass.connect(musicFilter);
    layerPerc.connect(musicFilter);
    layerArp.connect(musicFilter);
    layerTension.connect(musicFilter);

    // Send-based room. Everything shares one convolver; distance is a send
    // amount, never a second reverb. The impulse response is installed by the
    // staged warm a macrotask later, so the gesture itself stays cheap; until
    // then the send path is simply silent.
    convolver = context.createConvolver();
    convolver.normalize = false;
    const reverbTone = context.createBiquadFilter();
    reverbTone.type = "highpass";
    reverbTone.frequency.value = 180;
    reverbTone.Q.value = 0.5;
    const reverbReturn = context.createGain();
    reverbReturn.gain.value = 0.9;
    convolver.connect(reverbTone);
    reverbTone.connect(reverbReturn);
    reverbReturn.connect(sumBus);

    reverbIn = context.createDelay(0.2);
    reverbIn.delayTime.value = IR_PREDELAY;
    reverbIn.connect(convolver);

    // One send gain per bus in front of the shared room, each carrying that
    // bus's mixer position. Voices send here rather than straight into the
    // pre-delay, so switching a bus off takes its reverb with it — on the same
    // ramp, so the room decays rather than snapping.
    sfxRoom = context.createGain();
    sfxRoom.gain.value = sfxTarget();
    sfxRoom.connect(reverbIn);

    crowdRoom = context.createGain();
    crowdRoom.gain.value = crowdTarget();
    crowdRoom.connect(reverbIn);

    // A little of the score in the room keeps it in the same space as the SFX.
    // Tapped pre-duck, as before, so the sidechain still ducks only the dry.
    const musicSend = context.createGain();
    musicSend.gain.value = 0.16;
    musicFilter.connect(musicSend);
    musicRoom = context.createGain();
    musicRoom.gain.value = musicTarget();
    musicSend.connect(musicRoom);
    musicRoom.connect(reverbIn);

    waveChime = periodic(context, [1, 0.32, 0.11, 0.05, 0.02]);
    waveOrgan = periodic(context, [1, 0.34, 0.12, 0.06, 0.03, 0.015]);
    waveBuzz = periodic(context, [1, 0, 0.55, 0, 0.34, 0, 0.22, 0, 0.15, 0, 0.1]);
    waveVoice = periodic(context, [1, 0.62, 0.44, 0.3, 0.22, 0.16, 0.11, 0.08, 0.05]);
    white(context);
  }

  /** The live context, or null when the engine is locked, absent or disposed. */
  function live(): AudioContext | null {
    return disposed ? null : ctx;
  }

  /* ------------------------------------------------------------------ *
   * Layer helpers — used by every sound builder
   * ------------------------------------------------------------------ */

  /**
   * Standard AD / ADSR on a gain param. Returns the absolute end time.
   * Exponential segments never reach zero, so every envelope is closed with an
   * explicit `setValueAtTime(0)` — otherwise a stolen voice can hum forever.
   */
  function envelope(
    param: AudioParam,
    t: number,
    peak: number,
    attack: number,
    decay: number,
    sustain = 0,
    hold = 0,
    release = 0,
  ): number {
    const a = Math.max(0.0008, attack);
    const level = Math.max(0.0002, peak);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(level, t + a);
    const decayEnd = t + a + Math.max(0.004, decay);
    if (sustain > 0) {
      const sustainLevel = Math.max(0.0002, level * sustain);
      param.exponentialRampToValueAtTime(sustainLevel, decayEnd);
      const holdEnd = decayEnd + Math.max(0, hold);
      param.setValueAtTime(sustainLevel, holdEnd);
      const end = holdEnd + Math.max(0.008, release);
      param.exponentialRampToValueAtTime(0.0001, end);
      param.setValueAtTime(0, end);
      return end;
    }
    param.exponentialRampToValueAtTime(0.0001, decayEnd);
    param.setValueAtTime(0, decayEnd);
    return decayEnd;
  }

  function applyFilter(
    context: AudioContext,
    spec: FilterOptions,
    t: number,
    scale: number,
    rate: number,
  ): BiquadFilterNode {
    const filter = context.createBiquadFilter();
    filter.type = spec.type;
    // Pitch-following filters keep a sound's character when it is transposed.
    const follow = spec.type === "lowpass" || spec.type === "bandpass" || spec.type === "highpass";
    const scaleHz = follow ? Math.min(2, Math.max(0.5, rate)) : 1;
    const start = clamp(spec.freq * scaleHz, 10, 20000);
    filter.frequency.setValueAtTime(start, t);
    if (spec.to !== undefined) {
      const end = clamp(spec.to * scaleHz, 10, 20000);
      filter.frequency.exponentialRampToValueAtTime(end, t + Math.max(0.004, (spec.time ?? 0.1) * scale));
    }
    filter.Q.setValueAtTime(spec.q ?? 0.7071, t);
    if (spec.qTo !== undefined) {
      filter.Q.linearRampToValueAtTime(spec.qTo, t + Math.max(0.004, (spec.time ?? 0.1) * scale));
    }
    if (spec.gainDb !== undefined) filter.gain.setValueAtTime(spec.gainDb, t);
    return filter;
  }

  /**
   * Wires a layer's tail: filters → envelope gain → [drive] → [pan] → voice out,
   * with an optional extra tap into the room. Returns the node that must be fed.
   */
  function layerChain(
    context: AudioContext,
    e: Emit,
    gain: GainNode,
    t: number,
    filter?: FilterOptions,
    filter2?: FilterOptions,
    drive?: 0 | 1 | 2,
    pan?: number,
    send?: number,
  ): AudioNode {
    let tail: AudioNode = gain;
    if (drive) {
      const pre = context.createGain();
      pre.gain.value = 1.9;
      const shaper = context.createWaveShaper();
      shaper.curve = curve(drive);
      shaper.oversample = "2x";
      gain.connect(pre);
      pre.connect(shaper);
      tail = shaper;
    }
    if (pan !== undefined && hasPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      tail.connect(panner);
      tail = panner;
    }
    tail.connect(e.out);
    if (send !== undefined && send > 0) {
      const sendGain = context.createGain();
      sendGain.gain.value = send;
      tail.connect(sendGain);
      sendGain.connect(e.room);
      e.escape(sendGain);
    }
    // Head of the chain: the caller feeds whichever filter comes first.
    let head: AudioNode = gain;
    if (filter2) {
      const f2 = applyFilter(context, filter2, t, e.timeScale, e.rate);
      f2.connect(head);
      head = f2;
    }
    if (filter) {
      const f1 = applyFilter(context, filter, t, e.timeScale, e.rate);
      f1.connect(head);
      head = f1;
    }
    return head;
  }

  /** One oscillator layer with envelope, glide, optional filtering and drive. */
  function tone(e: Emit, o: ToneOptions): void {
    if (!ctx) return;
    const context = ctx;
    const scale = e.timeScale;
    const t = e.t + (o.delay ?? 0) * scale;
    const osc = context.createOscillator();
    if (o.wave) osc.setPeriodicWave(o.wave);
    else osc.type = o.type ?? "sine";
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    const f0 = clamp(o.freq * e.rate, 8, 20000);
    osc.frequency.setValueAtTime(f0, t);
    if (o.to !== undefined) {
      const f1 = clamp(o.to * e.rate, 8, 20000);
      const glide = Math.max(0.004, (o.glide ?? 0.08) * scale);
      if ((o.curve ?? "exp") === "exp") osc.frequency.exponentialRampToValueAtTime(f1, t + glide);
      else osc.frequency.linearRampToValueAtTime(f1, t + glide);
    }
    const gain = context.createGain();
    const level = o.drive ? o.level * 0.55 : o.level;
    const end = envelope(
      gain.gain,
      t,
      level,
      (o.attack ?? 0.002) * scale,
      o.decay * scale,
      o.sustain ?? 0,
      (o.hold ?? 0) * scale,
      (o.release ?? 0) * scale,
    );
    const head = layerChain(context, e, gain, t, o.filter, o.filter2, o.drive, o.pan, o.send);
    osc.connect(head);

    if (o.vibrato) {
      // Pitch wobble: LFO → gain(depth in cents) → oscillator.detune.
      const lfo = context.createOscillator();
      lfo.frequency.value = o.vibrato.rate;
      const depth = context.createGain();
      depth.gain.value = o.vibrato.cents;
      lfo.connect(depth);
      depth.connect(osc.detune);
      lfo.start(t);
      lfo.stop(end + 0.02);
      e.own(lfo, end + 0.02);
    }
    if (o.tremolo) {
      // Amplitude wobble rides on top of the envelope via a second gain stage.
      const lfo = context.createOscillator();
      lfo.frequency.value = o.tremolo.rate;
      const depth = context.createGain();
      depth.gain.value = o.tremolo.depth * level;
      lfo.connect(depth);
      depth.connect(gain.gain);
      lfo.start(t);
      lfo.stop(end + 0.02);
      e.own(lfo, end + 0.02);
    }

    osc.start(t);
    osc.stop(end + 0.02);
    e.own(osc, end + 0.02);
    e.keep(end);
  }

  /** One noise layer. Shares the baked buffers; only the nodes are per-voice. */
  function noise(e: Emit, o: NoiseOptions): void {
    if (!ctx) return;
    const context = ctx;
    const scale = e.timeScale;
    const t = e.t + (o.delay ?? 0) * scale;
    const source = context.createBufferSource();
    const kind = o.source ?? "white";
    source.buffer =
      kind === "pink" ? pink(context) : kind === "applause" ? applause(context) : white(context);
    // White is inaudibly discontinuous at the seam and pink is baked seamless,
    // so both loop freely — that way a long envelope can never outrun the
    // buffer and cut off. Applause is a designed one-shot and must not repeat.
    source.loop = kind !== "applause";
    const rate = o.rate ?? 1;
    source.playbackRate.setValueAtTime(clamp(rate, 0.06, 8), t);
    if (o.rateTo !== undefined) {
      source.playbackRate.exponentialRampToValueAtTime(
        clamp(o.rateTo, 0.06, 8),
        t + Math.max(0.01, o.decay * scale),
      );
    }
    const gain = context.createGain();
    const level = o.drive ? o.level * 0.55 : o.level;
    const end = envelope(
      gain.gain,
      t,
      level,
      (o.attack ?? 0.001) * scale,
      o.decay * scale,
      o.sustain ?? 0,
      (o.hold ?? 0) * scale,
      (o.release ?? 0) * scale,
    );
    const head = layerChain(context, e, gain, t, o.filter, o.filter2, o.drive, o.pan, o.send);
    source.connect(head);
    // Offsetting the read head stops repeated triggers from phase-locking into
    // an audible "same click" and keeps stacked layers decorrelated. Applause
    // is a composed one-shot, so it always plays from the top.
    const offset = kind === "applause" ? 0 : (o.offset ?? readOffset(source.buffer));
    source.start(t, offset);
    source.stop(end + 0.02);
    e.own(source, end + 0.02);
    e.keep(end);
  }

  /* ------------------------------------------------------------------ *
   * Sound design — one builder per SfxId
   * ------------------------------------------------------------------ */

  /** Transient click + body thump + air. Climbs in pitch while held down. */
  function sfxFire(e: Emit): void {
    noise(e, {
      level: 0.5,
      attack: 0.0006,
      decay: 0.018,
      filter: { type: "highpass", freq: 2300, q: 0.7 },
      send: 0.05,
    });
    tone(e, { type: "sine", freq: 1750, to: 880, glide: 0.022, level: 0.15, decay: 0.032 });
    tone(e, {
      type: "triangle",
      freq: 262,
      to: 92,
      glide: 0.075,
      level: 0.62,
      attack: 0.001,
      decay: 0.11,
      drive: 1,
      filter: { type: "lowpass", freq: 1900, to: 720, time: 0.09, q: 0.9 },
    });
    tone(e, { type: "sine", freq: 128, to: 58, glide: 0.09, level: 0.3, attack: 0.002, decay: 0.13 });
    noise(e, {
      level: 0.2,
      attack: 0.002,
      decay: 0.09,
      filter: { type: "bandpass", freq: 2600, to: 1150, time: 0.085, q: 0.8 },
      send: 0.14,
    });
  }

  /** Mechanical latch: broadband clack, bar-like partials, a short room tail. */
  function sfxHit(e: Emit): void {
    noise(e, {
      level: 0.55,
      attack: 0.0005,
      decay: 0.026,
      filter: { type: "bandpass", freq: 2350, q: 5.5 },
      send: 0.16,
    });
    noise(e, { level: 0.2, attack: 0.0004, decay: 0.011, filter: { type: "highpass", freq: 5200 } });
    tone(e, {
      type: "square",
      freq: 430,
      to: 300,
      glide: 0.04,
      level: 0.2,
      decay: 0.05,
      drive: 1,
      filter: { type: "lowpass", freq: 2600, q: 0.8 },
    });
    // Inharmonic ratios 1 : 1.47 : 2.09 read as struck metal, not as a chord.
    tone(e, { type: "sine", freq: 3180, level: 0.075, decay: 0.16, send: 0.2 });
    tone(e, { type: "sine", freq: 4675, level: 0.05, decay: 0.11, detune: 7 });
    tone(e, { type: "sine", freq: 6646, level: 0.026, decay: 0.07 });
    tone(e, { type: "sine", freq: 168, to: 122, glide: 0.05, level: 0.22, decay: 0.09 });
  }

  /** Damped thud, downward bend, a buzz that says "no" without a buzzer. */
  function sfxHitWrong(e: Emit): void {
    tone(e, {
      type: "triangle",
      freq: 196,
      to: 78,
      glide: 0.19,
      level: 0.52,
      decay: 0.24,
      drive: 1,
      filter: { type: "lowpass", freq: 640, to: 260, time: 0.2, q: 1.1 },
    });
    tone(e, {
      wave: waveBuzz ?? undefined,
      freq: 61,
      to: 47,
      glide: 0.26,
      level: 0.16,
      decay: 0.3,
      vibrato: { rate: 19, cents: 45 },
      filter: { type: "bandpass", freq: 300, to: 175, time: 0.28, q: 3.2 },
    });
    noise(e, {
      level: 0.3,
      attack: 0.001,
      decay: 0.16,
      drive: 1,
      filter: { type: "lowpass", freq: 480, q: 0.9 },
      send: 0.12,
    });
    noise(e, {
      level: 0.1,
      decay: 0.05,
      filter: { type: "bandpass", freq: 1500, to: 700, time: 0.05, q: 2.2 },
    });
  }

  /**
   * Resolving chime: C major stacked over the score's A minor centre, so the
   * reward lands *in key* with whatever the music is doing.
   */
  function chime(e: Emit, base: number, big: boolean, delay: number): void {
    const partials: readonly number[] = big ? [1, 1.26, 1.4983, 2, 2.52, 4] : [1, 1.26, 1.4983, 2, 3];
    const tail = big ? 1.75 : 0.95;
    for (let i = 0; i < partials.length; i += 1) {
      const ratio = partials[i];
      tone(e, {
        wave: i === 0 ? (waveChime ?? undefined) : undefined,
        type: "sine",
        freq: base * ratio,
        level: (big ? 0.3 : 0.26) / (1 + i * 0.72),
        attack: 0.004 + i * 0.002,
        decay: tail / (1 + i * 0.5),
        detune: i === 0 ? 0 : (i % 2 === 0 ? 5 : -5),
        delay,
        send: 0.12,
        filter:
          i === 0
            ? { type: "lowpass", freq: 1400, to: 5200, time: 0.18, q: 1.1 }
            : undefined,
      });
    }
    // Mallet contact, and a sub that gives the chime a body on small speakers.
    noise(e, {
      level: 0.16,
      decay: 0.01,
      delay,
      filter: { type: "highpass", freq: 3000 },
    });
    tone(e, {
      type: "sine",
      freq: base / 4,
      level: big ? 0.3 : 0.2,
      attack: 0.006,
      decay: big ? 0.9 : 0.42,
      delay,
    });
  }

  function sfxAnswer(e: Emit): void {
    chime(e, 523.25, false, 0);
  }

  /** The big variant: riser into the chord, an octave on top, a long tail. */
  function sfxAnswerBig(e: Emit): void {
    noise(e, {
      level: 0.18,
      attack: 0.26,
      decay: 0.07,
      filter: { type: "bandpass", freq: 700, to: 4400, time: 0.3, q: 1.6 },
      send: 0.3,
    });
    tone(e, {
      type: "sawtooth",
      freq: 220,
      to: 880,
      glide: 0.3,
      level: 0.1,
      attack: 0.25,
      decay: 0.06,
      filter: { type: "lowpass", freq: 900, to: 4200, time: 0.3, q: 4 },
    });
    chime(e, 523.25, true, 0.3);
    // Shimmer: two very quiet detuned partials with a slow beat against each
    // other, which is what makes a synthetic chord sound expensive.
    tone(e, {
      type: "sine",
      freq: 2093,
      level: 0.03,
      attack: 0.12,
      decay: 1.6,
      detune: 9,
      delay: 0.3,
      send: 0.4,
    });
    tone(e, {
      type: "sine",
      freq: 2093,
      level: 0.03,
      attack: 0.15,
      decay: 1.5,
      detune: -11,
      delay: 0.32,
      send: 0.4,
    });
  }

  /** Low impact, body, rattling debris, room slam. */
  function sfxLand(e: Emit): void {
    tone(e, { type: "sine", freq: 132, to: 38, glide: 0.22, level: 0.8, decay: 0.42, drive: 1 });
    tone(e, { type: "sine", freq: 62, to: 34, glide: 0.3, level: 0.34, decay: 0.5 });
    noise(e, {
      level: 0.45,
      decay: 0.2,
      drive: 1,
      filter: { type: "lowpass", freq: 950, to: 260, time: 0.2, q: 1.2 },
      send: 0.25,
    });
    noise(e, { level: 0.18, decay: 0.06, filter: { type: "highpass", freq: 1800 } });
    // Debris: short bandpassed ticks scattered across half a second, thinning
    // out and drifting down in pitch, like something settling.
    for (let i = 0; i < 7; i += 1) {
      const delay = 0.04 + rng.range(0.01, 0.09) + i * 0.045;
      noise(e, {
        level: 0.13 * Math.pow(0.78, i),
        decay: rng.range(0.018, 0.05),
        delay,
        pan: rng.range(-0.5, 0.5),
        filter: { type: "bandpass", freq: rng.range(1100, 3400), q: rng.range(3, 7) },
        send: 0.2,
      });
    }
    noise(e, {
      level: 0.26,
      decay: 0.05,
      filter: { type: "bandpass", freq: 520, q: 0.6 },
      send: 0.9,
    });
  }

  /** The set piece: riser, impact, sweep-down tail. */
  function sfxPop(e: Emit): void {
    const riseTime = 1.05;
    for (let i = 0; i < 2; i += 1) {
      tone(e, {
        type: "sawtooth",
        freq: 110,
        to: 1900,
        glide: riseTime,
        curve: "exp",
        detune: i === 0 ? -12 : 12,
        level: 0.15,
        attack: riseTime * 0.95,
        decay: 0.06,
        filter: { type: "bandpass", freq: 300, to: 3000, time: riseTime, q: 6 },
        send: 0.25,
      });
    }
    noise(e, {
      level: 0.24,
      attack: riseTime * 0.92,
      decay: 0.05,
      filter: { type: "highpass", freq: 300, to: 6200, time: riseTime },
      send: 0.3,
    });
    tone(e, { type: "sine", freq: 55, to: 110, glide: riseTime, level: 0.22, attack: 0.6, decay: 0.4 });

    // Impact.
    tone(e, {
      type: "sine",
      freq: 150,
      to: 34,
      glide: 0.35,
      level: 0.95,
      decay: 0.6,
      drive: 2,
      delay: riseTime,
    });
    noise(e, {
      level: 0.55,
      decay: 0.32,
      drive: 2,
      delay: riseTime,
      filter: { type: "lowpass", freq: 3200, to: 300, time: 0.3, q: 1.4 },
      send: 0.55,
    });
    noise(e, {
      level: 0.3,
      decay: 0.02,
      delay: riseTime,
      filter: { type: "highpass", freq: 4000 },
    });
    // Clang cluster — inharmonic, so it reads as a struck plate not a note.
    const clang = [620, 911, 1372, 2107];
    for (let i = 0; i < clang.length; i += 1) {
      tone(e, {
        type: "sine",
        freq: clang[i],
        level: 0.085 / (1 + i * 0.35),
        decay: 0.9 - i * 0.16,
        detune: i % 2 === 0 ? 6 : -8,
        delay: riseTime,
        send: 0.45,
      });
    }
    // Sweep-down tail.
    tone(e, {
      type: "sawtooth",
      freq: 1800,
      to: 80,
      glide: 1.15,
      level: 0.15,
      attack: 0.01,
      decay: 1.3,
      delay: riseTime + 0.02,
      filter: { type: "lowpass", freq: 4200, to: 300, time: 1.2, q: 3 },
      send: 0.7,
    });
  }

  /** Pentatonic pluck; the rung climbs while the caller keeps landing answers. */
  function sfxComboUp(e: Emit): void {
    const ladder = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
    const step = ladder[Math.min(comboRung, ladder.length - 1)];
    const f = 392 * semi(step);
    tone(e, {
      wave: waveChime ?? undefined,
      freq: f,
      level: 0.3,
      attack: 0.003,
      decay: 0.28,
      filter: { type: "lowpass", freq: 6200, to: 1800, time: 0.25, q: 1 },
      send: 0.15,
    });
    tone(e, { type: "sine", freq: f * 1.5, level: 0.12, attack: 0.003, decay: 0.2, detune: 4 });
    tone(e, { type: "sine", freq: f * 2, level: 0.06, attack: 0.004, decay: 0.14 });
    noise(e, { level: 0.1, decay: 0.028, filter: { type: "bandpass", freq: 3400, q: 2.5 } });
  }

  /** Filter closes, pitch sags, air pulls back. The world thickens. */
  function sfxSlowmoIn(e: Emit): void {
    const drone = [220, 221.1, 110];
    for (let i = 0; i < drone.length; i += 1) {
      tone(e, {
        type: "sawtooth",
        freq: drone[i],
        to: drone[i] * 0.72,
        glide: 0.6,
        level: i === 2 ? 0.1 : 0.075,
        attack: 0.05,
        decay: 0.55,
        detune: i === 1 ? 9 : 0,
        filter: { type: "lowpass", freq: 7000, to: 380, time: 0.6, q: 3.5 },
        send: 0.4,
      });
    }
    noise(e, {
      level: 0.22,
      attack: 0.02,
      decay: 0.6,
      filter: { type: "highpass", freq: 4200, to: 500, time: 0.55, q: 1.2 },
      send: 0.35,
    });
    // Pre-roll swell: amplitude rises into the moment, then cuts.
    noise(e, {
      level: 0.15,
      attack: 0.45,
      decay: 0.06,
      filter: { type: "bandpass", freq: 900, q: 1 },
      send: 0.5,
    });
    tone(e, { type: "sine", freq: 180, to: 46, glide: 0.5, level: 0.22, decay: 0.55, drive: 1 });
  }

  /** Release: the room opens back up and the pitch recovers. */
  function sfxSlowmoOut(e: Emit): void {
    const drone = [158, 159.4];
    for (let i = 0; i < drone.length; i += 1) {
      tone(e, {
        type: "sawtooth",
        freq: drone[i],
        to: drone[i] * 1.65,
        glide: 0.35,
        level: 0.08,
        attack: 0.02,
        decay: 0.4,
        detune: i === 1 ? -8 : 0,
        filter: { type: "lowpass", freq: 420, to: 9000, time: 0.4, q: 3 },
        send: 0.3,
      });
    }
    noise(e, {
      level: 0.2,
      attack: 0.03,
      decay: 0.35,
      filter: { type: "highpass", freq: 400, to: 6000, time: 0.35, q: 1 },
      send: 0.3,
    });
    tone(e, { type: "sine", freq: 880, to: 1320, glide: 0.08, level: 0.1, attack: 0.004, decay: 0.14 });
  }

  /** Two-tone studio alert: G5 then D5, stated twice, softened at the top. */
  function sfxWarning(e: Emit): void {
    const pattern: readonly (readonly [number, number, number])[] = [
      [784, 0, 1],
      [587.33, 0.28, 1],
      [784, 0.56, 0.72],
      [587.33, 0.84, 0.72],
    ];
    for (let i = 0; i < pattern.length; i += 1) {
      const [freq, delay, level] = pattern[i];
      tone(e, {
        wave: waveOrgan ?? undefined,
        freq,
        level: 0.22 * level,
        attack: 0.012,
        decay: 0.05,
        sustain: 0.8,
        hold: 0.12,
        release: 0.1,
        delay,
        tremolo: { rate: 6.5, depth: 0.08 },
        filter: { type: "lowpass", freq: 3200, q: 0.8 },
        send: 0.2,
      });
      // Weight under each tone so it reads on a laptop speaker.
      tone(e, {
        type: "sine",
        freq: freq / 4,
        level: 0.1 * level,
        attack: 0.01,
        decay: 0.04,
        sustain: 0.7,
        hold: 0.1,
        release: 0.09,
        delay,
      });
    }
  }

  /** A hardware clock tick with a little more ceremony. */
  function sfxCountdown(e: Emit): void {
    noise(e, { level: 0.35, decay: 0.012, filter: { type: "bandpass", freq: 2700, q: 4.5 } });
    tone(e, { type: "sine", freq: 1046, to: 940, glide: 0.03, level: 0.2, decay: 0.055 });
    tone(e, { type: "triangle", freq: 262, level: 0.12, decay: 0.04 });
  }

  /** The quiet metronome under the clock. */
  function sfxTick(e: Emit): void {
    noise(e, { level: 0.22, decay: 0.006, filter: { type: "highpass", freq: 4200 } });
    tone(e, { type: "sine", freq: 2100, level: 0.09, decay: 0.02 });
  }

  function sfxUiHover(e: Emit): void {
    noise(e, { level: 0.12, decay: 0.008, filter: { type: "bandpass", freq: 5200, q: 3 } });
    tone(e, { type: "sine", freq: 3120, level: 0.045, decay: 0.02 });
  }

  function sfxUiClick(e: Emit): void {
    noise(e, { level: 0.3, decay: 0.01, filter: { type: "highpass", freq: 3000 } });
    tone(e, { type: "sine", freq: 1560, to: 1180, glide: 0.03, level: 0.11, decay: 0.045 });
    tone(e, {
      type: "triangle",
      freq: 420,
      level: 0.1,
      decay: 0.035,
      filter: { type: "highpass", freq: 260 },
    });
  }

  function sfxUiOpen(e: Emit): void {
    noise(e, {
      level: 0.16,
      attack: 0.012,
      decay: 0.22,
      filter: { type: "highpass", freq: 600, to: 3600, time: 0.22, q: 1.1 },
      send: 0.2,
    });
    tone(e, { type: "triangle", freq: 523.25, to: 783.99, glide: 0.13, level: 0.1, decay: 0.2 });
    tone(e, { type: "sine", freq: 1046.5, to: 1568, glide: 0.13, level: 0.05, decay: 0.16 });
  }

  function sfxUiClose(e: Emit): void {
    noise(e, {
      level: 0.14,
      attack: 0.008,
      decay: 0.18,
      filter: { type: "lowpass", freq: 3600, to: 700, time: 0.18, q: 1.1 },
      send: 0.14,
    });
    tone(e, { type: "triangle", freq: 783.99, to: 523.25, glide: 0.11, level: 0.09, decay: 0.16 });
    tone(e, { type: "sine", freq: 392, level: 0.07, decay: 0.09, filter: { type: "lowpass", freq: 900 } });
  }

  /**
   * A cheer, built the way a real one sounds: a bed of applause transients, a
   * broadband swell, and a handful of *voiced* layers — sawtooth larynxes run
   * through vowel formant pairs — that enter at slightly different times. The
   * stagger is what stops it reading as one synthetic whoosh.
   */
  function sfxCrowdCheer(e: Emit): void {
    noise(e, {
      source: "applause",
      level: 0.44,
      attack: 0.22,
      decay: 0.28,
      sustain: 0.72,
      hold: 0.5,
      release: 1.4,
      filter: { type: "highpass", freq: 700, q: 0.7 },
      filter2: { type: "lowpass", freq: 6500, q: 0.6 },
      send: 0.5,
    });
    noise(e, {
      source: "pink",
      level: 0.24,
      attack: 0.3,
      decay: 1.7,
      filter: { type: "bandpass", freq: 500, to: 1500, time: 0.5, q: 0.8 },
      send: 0.6,
    });
    // Vowel pairs: [F1, F2] for "ah", "eh", "oh", "ae", "iy".
    const vowels: readonly (readonly [number, number])[] = [
      [730, 1090],
      [530, 1840],
      [570, 840],
      [660, 1720],
      [400, 1900],
    ];
    for (let i = 0; i < vowels.length; i += 1) {
      const [f1, f2] = vowels[i];
      const pitch = rng.range(128, 258);
      const start = rng.range(0, 0.22);
      tone(e, {
        wave: waveVoice ?? undefined,
        freq: pitch,
        to: pitch * rng.range(1.04, 1.16),
        glide: 0.5,
        level: 0.09,
        attack: rng.range(0.1, 0.28),
        decay: 0.25,
        sustain: 0.6,
        hold: rng.range(0.3, 0.7),
        release: rng.range(0.7, 1.3),
        delay: start,
        vibrato: { rate: rng.range(4.5, 7.5), cents: rng.range(12, 34) },
        pan: rng.range(-0.75, 0.75),
        filter: { type: "bandpass", freq: f1, q: 6 },
        filter2: { type: "bandpass", freq: f2, q: 8 },
        send: 0.55,
      });
    }
    // Breath: the aggregate "sss" of a few hundred people.
    noise(e, {
      source: "pink",
      level: 0.1,
      attack: 0.25,
      decay: 1.4,
      filter: { type: "bandpass", freq: 2600, q: 1.1 },
      send: 0.5,
    });
    // Two whistles, late and off to the sides.
    for (let i = 0; i < 2; i += 1) {
      tone(e, {
        type: "sine",
        freq: rng.range(2050, 2650),
        to: rng.range(2400, 3100),
        glide: 0.2,
        level: 0.035,
        attack: 0.04,
        decay: 0.08,
        sustain: 0.7,
        hold: 0.12,
        release: 0.2,
        delay: rng.range(0.35, 0.95),
        pan: i === 0 ? -0.8 : 0.8,
        vibrato: { rate: 6, cents: 40 },
        send: 0.6,
      });
    }
    bumpMurmur(2.1, 0.3, 1.6);
  }

  /** The disappointed "ohhh": pitch slides down, vowel darkens to [o]. */
  function sfxCrowdGroan(e: Emit): void {
    for (let i = 0; i < 5; i += 1) {
      const pitch = rng.range(142, 232);
      tone(e, {
        wave: waveVoice ?? undefined,
        freq: pitch,
        to: pitch * 0.86,
        glide: 1.1,
        level: 0.1,
        attack: rng.range(0.18, 0.34),
        decay: 0.3,
        sustain: 0.62,
        hold: rng.range(0.3, 0.55),
        release: rng.range(0.7, 1.1),
        delay: rng.range(0, 0.18),
        vibrato: { rate: rng.range(4, 6.5), cents: rng.range(10, 26) },
        pan: rng.range(-0.7, 0.7),
        filter: { type: "bandpass", freq: rng.range(480, 600), to: rng.range(330, 420), time: 1.1, q: 6 },
        filter2: { type: "bandpass", freq: rng.range(780, 900), to: rng.range(650, 740), time: 1.1, q: 7 },
        send: 0.5,
      });
    }
    noise(e, {
      source: "pink",
      level: 0.15,
      attack: 0.25,
      decay: 1.3,
      filter: { type: "lowpass", freq: 1400, to: 600, time: 1.2, q: 0.9 },
      send: 0.55,
    });
    tone(e, { type: "sine", freq: 96, to: 74, glide: 1, level: 0.14, attack: 0.2, decay: 1.1 });
    bumpMurmur(1.5, 0.4, 1.8);
  }

  /** "We are live": tom, riser, a rising three-note motif, an accent. */
  function sfxRoundStart(e: Emit): void {
    tone(e, { type: "sine", freq: 180, to: 70, glide: 0.18, level: 0.55, decay: 0.3, drive: 1 });
    noise(e, {
      level: 0.2,
      attack: 0.45,
      decay: 0.09,
      filter: { type: "highpass", freq: 800, to: 5200, time: 0.5, q: 1.1 },
      send: 0.4,
    });
    const motif = [220, 261.63, 329.63];
    for (let i = 0; i < motif.length; i += 1) {
      tone(e, {
        type: "sawtooth",
        freq: motif[i],
        level: 0.16,
        attack: 0.004,
        decay: 0.28,
        delay: i * 0.16,
        detune: -6,
        filter: { type: "lowpass", freq: 900, to: 4200, time: 0.1, q: 4 },
        send: 0.3,
      });
      tone(e, {
        type: "sawtooth",
        freq: motif[i],
        level: 0.12,
        attack: 0.004,
        decay: 0.24,
        delay: i * 0.16,
        detune: 7,
        filter: { type: "lowpass", freq: 1100, to: 3600, time: 0.1, q: 3 },
      });
    }
    tone(e, { type: "sine", freq: 90, to: 45, glide: 0.2, level: 0.45, decay: 0.5, delay: 0.5, drive: 1 });
    noise(e, {
      level: 0.3,
      decay: 0.12,
      delay: 0.5,
      filter: { type: "lowpass", freq: 1200, q: 0.9 },
      send: 0.6,
    });
    tone(e, {
      wave: waveChime ?? undefined,
      freq: 659.25,
      level: 0.18,
      attack: 0.004,
      decay: 1.2,
      delay: 0.5,
      send: 0.4,
    });
    tone(e, { type: "sine", freq: 987.77, level: 0.09, attack: 0.005, decay: 0.9, delay: 0.52, send: 0.4 });
  }

  /** Win: an arpeggio that lands on a held C add9. */
  function sfxRoundWin(e: Emit): void {
    const arp = [523.25, 659.25, 783.99, 987.77, 1174.66];
    for (let i = 0; i < arp.length; i += 1) {
      tone(e, {
        wave: waveChime ?? undefined,
        freq: arp[i],
        level: 0.16,
        attack: 0.004,
        decay: 0.5 + i * 0.12,
        delay: i * 0.07,
        send: 0.3,
      });
    }
    const held = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < held.length; i += 1) {
      tone(e, {
        type: "triangle",
        freq: held[i],
        level: 0.11 / (1 + i * 0.4),
        attack: 0.05,
        decay: 0.3,
        sustain: 0.65,
        hold: 0.7,
        release: 1.3,
        delay: 0.36,
        detune: i % 2 === 0 ? 5 : -6,
        send: 0.4,
      });
    }
    tone(e, { type: "sine", freq: 130.81, level: 0.34, attack: 0.01, decay: 1.6, delay: 0.36 });
    tone(e, {
      type: "sine",
      freq: 2093,
      level: 0.028,
      attack: 0.3,
      decay: 1.8,
      delay: 0.4,
      tremolo: { rate: 5.5, depth: 0.4 },
      send: 0.6,
    });
    noise(e, {
      level: 0.2,
      attack: 0.02,
      decay: 0.5,
      delay: 0.36,
      filter: { type: "highpass", freq: 2600, q: 0.8 },
      send: 0.5,
    });
  }

  /** Lose: three steps down the minor scale over a sagging pad. Serious, not comic. */
  function sfxRoundLose(e: Emit): void {
    const motif = [220, 196, 174.61];
    for (let i = 0; i < motif.length; i += 1) {
      tone(e, {
        type: "sawtooth",
        freq: motif[i],
        level: 0.14,
        attack: 0.02,
        decay: 0.35,
        sustain: 0.5,
        hold: 0.15,
        release: 0.5,
        delay: i * 0.26,
        detune: -7,
        filter: { type: "lowpass", freq: 2600, to: 620, time: 1.4, q: 2.4 },
        send: 0.4,
      });
      tone(e, {
        type: "sawtooth",
        freq: motif[i] / 2,
        level: 0.1,
        attack: 0.02,
        decay: 0.4,
        sustain: 0.5,
        hold: 0.2,
        release: 0.6,
        delay: i * 0.26,
        detune: 9,
        filter: { type: "lowpass", freq: 1400, to: 400, time: 1.4, q: 1.8 },
      });
    }
    tone(e, { type: "sine", freq: 110, to: 41, glide: 1.1, level: 0.42, decay: 1.5, drive: 1 });
    noise(e, {
      level: 0.3,
      decay: 0.35,
      drive: 1,
      filter: { type: "lowpass", freq: 900, to: 220, time: 0.4, q: 1.1 },
      send: 0.6,
    });
    noise(e, {
      source: "pink",
      level: 0.1,
      attack: 0.4,
      decay: 1.6,
      filter: { type: "lowpass", freq: 1800, to: 400, time: 1.6, q: 0.8 },
      send: 0.5,
    });
  }

  const BUILDERS: Record<SfxId, (e: Emit) => void> = {
    fire: sfxFire,
    hit: sfxHit,
    "hit-wrong": sfxHitWrong,
    answer: sfxAnswer,
    "answer-big": sfxAnswerBig,
    land: sfxLand,
    pop: sfxPop,
    "combo-up": sfxComboUp,
    "slowmo-in": sfxSlowmoIn,
    "slowmo-out": sfxSlowmoOut,
    warning: sfxWarning,
    countdown: sfxCountdown,
    tick: sfxTick,
    "ui-hover": sfxUiHover,
    "ui-click": sfxUiClick,
    "ui-open": sfxUiOpen,
    "ui-close": sfxUiClose,
    "crowd-murmur": () => undefined, // handled as a persistent bed, see setMurmur
    "crowd-cheer": sfxCrowdCheer,
    "crowd-groan": sfxCrowdGroan,
    "round-start": sfxRoundStart,
    "round-win": sfxRoundWin,
    "round-lose": sfxRoundLose,
  };

  /* ------------------------------------------------------------------ *
   * Voice pool
   * ------------------------------------------------------------------ */

  function releaseVoice(voice: Voice): void {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    // Cutting the output makes the whole voice subgraph unreachable from the
    // destination, so the engine can collect it; the sends have to go too,
    // because they hang off the shared reverb input rather than off the voice.
    voice.out.disconnect();
    for (let i = 0; i < voice.escapes.length; i += 1) voice.escapes[i].disconnect();
    voice.escapes.length = 0;
    voice.sources.length = 0;
    voice.lastSource = null;
  }

  /** Fast fade then stop: stealing a voice must never click. */
  function stealVoice(voice: Voice, at: number): void {
    if (voice.stolen) return;
    voice.stolen = true;
    const g = voice.out.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(Math.max(0.0001, g.value), at);
    g.exponentialRampToValueAtTime(0.0001, at + 0.03);
    g.setValueAtTime(0, at + 0.031);
    for (let i = 0; i < voice.sources.length; i += 1) {
      try {
        voice.sources[i].stop(at + 0.035);
      } catch {
        // Already stopped: harmless.
      }
    }
    voice.ends = at + 0.04;
  }

  function sweepVoices(now: number): void {
    for (let i = voices.length - 1; i >= 0; i -= 1) {
      if (voices[i].ends <= now - 0.05) releaseVoice(voices[i]);
    }
  }

  /**
   * Makes room for a new voice. Same-id polyphony is trimmed first (the oldest
   * copy of a repeated sound is the least missed), then the global cap steals
   * the lowest-priority oldest voice. A new sound only loses to strictly higher
   * priority, so a "pop" never gets dropped for UI chatter.
   */
  function reserve(id: SfxId, profile: SfxProfile, now: number): boolean {
    let sameId = 0;
    let oldestSame: Voice | null = null;
    for (let i = 0; i < voices.length; i += 1) {
      const v = voices[i];
      if (v.id !== id || v.stolen) continue;
      sameId += 1;
      if (!oldestSame || v.started < oldestSame.started) oldestSame = v;
    }
    if (sameId >= profile.poly && oldestSame) stealVoice(oldestSame, now);

    let active = 0;
    for (let i = 0; i < voices.length; i += 1) if (!voices[i].stolen) active += 1;
    if (active < MAX_VOICES) return true;

    let victim: Voice | null = null;
    for (let i = 0; i < voices.length; i += 1) {
      const v = voices[i];
      if (v.stolen || v.priority > profile.priority) continue;
      if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.started < victim.started)) {
        victim = v;
      }
    }
    if (!victim) return false;
    stealVoice(victim, now);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Crowd murmur bed
   * ------------------------------------------------------------------ */

  /**
   * A room full of people is broadband noise shaped by three resonances around
   * the speech band, each breathing on its own slow LFO, with individual voices
   * surfacing out of it (see `scheduleBlips`). Static noise never reads as a
   * crowd; independently modulated bands do.
   */
  function startMurmur(context: AudioContext): void {
    if (murmurAlive || !crowdBus || !crowdRoom) return;
    const t = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = pink(context);
    source.loop = true;
    source.playbackRate.value = 0.85;

    const out = context.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.connect(crowdBus);
    const send = context.createGain();
    send.gain.value = 0.45;
    out.connect(send);
    send.connect(crowdRoom);

    // Slight lowpass "distance", itself slowly modulated so the bed breathes.
    const distance = context.createBiquadFilter();
    distance.type = "lowpass";
    distance.frequency.value = 2400;
    distance.Q.value = 0.6;
    distance.connect(out);
    const distanceLfo = context.createOscillator();
    distanceLfo.frequency.value = 0.043;
    const distanceDepth = context.createGain();
    distanceDepth.gain.value = 700;
    distanceLfo.connect(distanceDepth);
    distanceDepth.connect(distance.frequency);
    distanceLfo.start(t);
    murmurNodes.push(distanceLfo);

    const bands: readonly (readonly [number, number, number, number])[] = [
      [300, 1.4, 0.07, 0.5],
      [720, 2.0, 0.113, 0.4],
      [1650, 2.6, 0.171, 0.28],
    ];
    for (let i = 0; i < bands.length; i += 1) {
      const [freq, q, lfoHz, level] = bands[i];
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = freq;
      band.Q.value = q;
      const bandGain = context.createGain();
      bandGain.gain.value = level;
      band.connect(bandGain);
      bandGain.connect(distance);
      source.connect(band);
      const lfo = context.createOscillator();
      lfo.frequency.value = lfoHz;
      lfo.type = "sine";
      const depth = context.createGain();
      depth.gain.value = level * 0.55;
      lfo.connect(depth);
      depth.connect(bandGain.gain);
      // Deterministic phase offsets, so the three bands never pump together.
      lfo.start(t + rng.range(0, 3));
      murmurNodes.push(lfo);
    }

    const blipBus = context.createGain();
    blipBus.gain.value = 1;
    blipBus.connect(out);

    source.start(t);
    murmurSource = source;
    murmurGain = out;
    murmurBlipBus = blipBus;
    murmurAlive = true;
    nextBlipTime = context.currentTime + 0.2;
    applyMurmurLevel(context.currentTime, 1.4);
  }

  function applyMurmurLevel(at: number, seconds: number): void {
    if (!murmurGain) return;
    const g = murmurGain.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(Math.max(0.0001, g.value), at);
    g.linearRampToValueAtTime(Math.max(0.0001, murmurLevel), at + Math.max(0.05, seconds));
  }

  /** Temporary lift of the bed under a cheer or a groan. */
  function bumpMurmur(multiplier: number, attack: number, release: number): void {
    const context = live();
    if (!context || !murmurGain || !murmurAlive || murmurLevel <= 0.0002) return;
    const t = context.currentTime;
    const g = murmurGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.linearRampToValueAtTime(murmurLevel * multiplier, t + attack);
    g.setTargetAtTime(murmurLevel, t + attack, Math.max(0.1, release * 0.4));
  }

  /**
   * Re-derives the bed's level from the game's request and the audience
   * switch, and starts or retires the bed to match.
   *
   * `retire` is the difference between the game asking for a quiet room —
   * where the nodes stay up because the crowd is coming back in a moment — and
   * the player switching the audience off, where a looping buffer source, four
   * oscillators and a filter bank would burn CPU producing silence for the
   * rest of the session.
   */
  function applyMurmurTarget(seconds: number, retire: boolean): void {
    murmurLevel = crowdOn ? murmurWanted * PROFILES["crowd-murmur"].gain : 0;
    const context = live();
    // Before unlock this is remembered only: the level is state, and the bed
    // starts itself at unlock if the room was meant to be occupied.
    if (!context) return;
    if (murmurLevel > 0.0002) {
      startMurmur(context);
      applyMurmurLevel(context.currentTime, seconds);
      ensurePump();
    } else if (murmurAlive) {
      // Either path fades first — `stopMurmur` ramps out before it stops its
      // sources, so retiring the bed is not a cut.
      if (retire) stopMurmur();
      else applyMurmurLevel(context.currentTime, seconds);
    }
  }

  function setMurmur(level: number): void {
    murmurWanted = clamp(level, 0, 1);
    applyMurmurTarget(murmurWanted > 0 ? 1.4 : 0.9, false);
  }

  /**
   * Fades the bed out and stops its sources. `murmurWanted` is deliberately
   * left alone: it is the game's request, and switching the audience back on
   * has to restore the room the game asked for, not silence.
   */
  function stopMurmur(): void {
    if (!murmurAlive) return;
    murmurAlive = false;
    murmurLevel = 0;
    const t = ctx ? ctx.currentTime : 0;
    if (murmurGain) {
      murmurGain.gain.cancelScheduledValues(t);
      murmurGain.gain.setValueAtTime(Math.max(0.0001, murmurGain.gain.value), t);
      murmurGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    }
    const stopAt = t + 0.45;
    if (murmurSource) {
      try {
        murmurSource.stop(stopAt);
      } catch {
        // Already stopped.
      }
    }
    for (let i = 0; i < murmurNodes.length; i += 1) {
      try {
        murmurNodes[i].stop(stopAt);
      } catch {
        // Already stopped.
      }
    }
    murmurNodes.length = 0;
    murmurSource = null;
    murmurGain = null;
    murmurBlipBus = null;
  }

  /**
   * Individual voices surfacing out of the murmur: a short voiced burst through
   * a vowel formant pair, quiet and panned. Scheduled from the pump so they
   * follow the audio clock rather than a timer.
   */
  function scheduleBlips(now: number, lookahead: number): void {
    if (!ctx || !murmurBlipBus || !crowdRoom || murmurLevel <= 0.0002) return;
    const context = ctx;
    while (nextBlipTime < now + lookahead) {
      const t = Math.max(nextBlipTime, now + SCHEDULE_AHEAD);
      const pitch = rng.range(115, 265);
      const duration = rng.range(0.12, 0.36);
      const f1 = rng.range(380, 760);
      const f2 = rng.range(840, 1950);
      const osc = context.createOscillator();
      if (waveVoice) osc.setPeriodicWave(waveVoice);
      else osc.type = "sawtooth";
      osc.frequency.setValueAtTime(pitch, t);
      osc.frequency.linearRampToValueAtTime(pitch * rng.range(0.9, 1.12), t + duration);
      const band1 = context.createBiquadFilter();
      band1.type = "bandpass";
      band1.frequency.value = f1;
      band1.Q.value = 7;
      const band2 = context.createBiquadFilter();
      band2.type = "bandpass";
      band2.frequency.value = f2;
      band2.Q.value = 9;
      const gain = context.createGain();
      const end = envelope(gain.gain, t, rng.range(0.05, 0.13), 0.05, duration * 0.4, 0.5, duration * 0.4, 0.16);
      osc.connect(band1);
      band1.connect(band2);
      band2.connect(gain);
      if (hasPanner) {
        const panner = context.createStereoPanner();
        panner.pan.value = rng.range(-0.9, 0.9);
        gain.connect(panner);
        panner.connect(murmurBlipBus);
      } else {
        gain.connect(murmurBlipBus);
      }
      const send = context.createGain();
      send.gain.value = 0.5;
      gain.connect(send);
      send.connect(crowdRoom);
      osc.start(t);
      osc.stop(end + 0.02);
      osc.onended = () => {
        gain.disconnect();
        send.disconnect();
      };
      nextBlipTime = t + rng.range(0.24, 0.85);
    }
  }

  /* ------------------------------------------------------------------ *
   * Adaptive score
   * ------------------------------------------------------------------ */

  /**
   * Routes a music note to its layer and tears itself down when it ends.
   * Music voices deliberately bypass the SFX limiter: the score is scheduled,
   * bounded and quiet, so it must never be able to steal a gameplay sound.
   */
  function musicVoice(
    layer: GainNode,
    source: AudioScheduledSourceNode,
    gain: GainNode,
    head: AudioNode,
    start: number,
    end: number,
  ): void {
    source.connect(head);
    gain.connect(layer);
    source.start(start);
    source.stop(end + 0.02);
    source.onended = () => gain.disconnect();
  }

  function musicKick(t: number, level: number): void {
    if (!ctx || !layerPerc) return;
    const context = ctx;
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(148, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    const gain = context.createGain();
    const end = envelope(gain.gain, t, level, 0.001, 0.24);
    const click = context.createBufferSource();
    click.buffer = white(context);
    const clickFilter = context.createBiquadFilter();
    clickFilter.type = "highpass";
    clickFilter.frequency.value = 1800;
    const clickGain = context.createGain();
    const clickEnd = envelope(clickGain.gain, t, level * 0.18, 0.0005, 0.012);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(layerPerc);
    click.start(t, readOffset(click.buffer));
    click.stop(clickEnd + 0.02);
    click.onended = () => clickGain.disconnect();
    musicVoice(layerPerc, osc, gain, gain, t, end);
  }

  function musicHat(t: number, level: number, open: boolean): void {
    if (!ctx || !layerPerc) return;
    const context = ctx;
    const source = context.createBufferSource();
    source.buffer = white(context);
    // Reading the noise faster tilts it brighter, which is what a hat is. The
    // small per-hit spread stops five minutes of 8ths from sounding stamped.
    source.playbackRate.value = rng.range(1.5, 1.76);
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = (open ? 6200 : 7800) * rng.range(0.96, 1.05);
    filter.Q.value = 0.8;
    const gain = context.createGain();
    const end = envelope(gain.gain, t, level * rng.range(0.88, 1.12), 0.0006, open ? 0.14 : 0.028);
    filter.connect(gain);
    musicVoice(layerPerc, source, gain, filter, t, end);
  }

  function musicSnare(t: number, level: number): void {
    if (!ctx || !layerPerc) return;
    const context = ctx;
    const source = context.createBufferSource();
    source.buffer = white(context);
    source.playbackRate.value = rng.range(0.94, 1.07);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1900 * rng.range(0.95, 1.06);
    band.Q.value = 1.1;
    const gain = context.createGain();
    const end = envelope(gain.gain, t, level * rng.range(0.92, 1.08), 0.001, 0.11);
    band.connect(gain);
    musicVoice(layerPerc, source, gain, band, t, end);
    // Body: a short pitched thump under the noise, the way a real drum has one.
    const body = context.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(210, t);
    body.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const bodyGain = context.createGain();
    const bodyEnd = envelope(bodyGain.gain, t, level * 0.5, 0.001, 0.07);
    musicVoice(layerPerc, body, bodyGain, bodyGain, t, bodyEnd);
  }

  function musicBass(t: number, freq: number, duration: number, level: number, grit: number): void {
    if (!ctx || !layerBass) return;
    const context = ctx;
    const sub = context.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(freq, t);
    const subGain = context.createGain();
    const end = envelope(subGain.gain, t, level, 0.006, duration * 0.35, 0.55, duration * 0.4, 0.08);
    musicVoice(layerBass, sub, subGain, subGain, t, end);
    if (grit > 0.01) {
      // A saw an octave up through a closing lowpass gives the bass its teeth
      // as the round tightens, without changing the note or the level.
      const saw = context.createOscillator();
      saw.type = "sawtooth";
      saw.frequency.setValueAtTime(freq * 2, t);
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(320 + grit * 2200, t);
      filter.frequency.exponentialRampToValueAtTime(240 + grit * 600, t + duration * 0.6);
      filter.Q.value = 3.5;
      const sawGain = context.createGain();
      const sawEnd = envelope(sawGain.gain, t, level * 0.34 * grit, 0.004, duration * 0.5, 0.4, duration * 0.2, 0.06);
      filter.connect(sawGain);
      musicVoice(layerBass, saw, sawGain, filter, t, sawEnd);
    }
  }

  function musicArp(t: number, freq: number, level: number, bright: number): void {
    if (!ctx || !layerArp) return;
    const context = ctx;
    const osc = context.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.setValueAtTime(-5, t);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    // Per-note filter envelope: the pluck is the filter, not the amplitude.
    filter.frequency.setValueAtTime(700 + bright * 5200, t);
    filter.frequency.exponentialRampToValueAtTime(420 + bright * 900, t + 0.12);
    filter.Q.value = 6;
    const gain = context.createGain();
    const end = envelope(gain.gain, t, level, 0.003, 0.1);
    filter.connect(gain);
    musicVoice(layerArp, osc, gain, filter, t, end);
  }

  function musicPad(t: number, freqs: readonly number[], level: number, bright: number): void {
    if (!ctx || !layerPad) return;
    const context = ctx;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(700 + bright * 1600, t);
    filter.Q.value = 0.8;
    const gain = context.createGain();
    const end = envelope(gain.gain, t, level, 0.85, 0.4, 0.72, 1, 1.5);
    filter.connect(gain);
    gain.connect(layerPad);
    for (let i = 0; i < freqs.length; i += 1) {
      for (let d = 0; d < 2; d += 1) {
        const osc = context.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(freqs[i], t);
        osc.detune.setValueAtTime(d === 0 ? -7 : 7, t);
        osc.connect(filter);
        osc.start(t);
        osc.stop(end + 0.05);
        if (i === 0 && d === 0) osc.onended = () => gain.disconnect();
      }
    }
  }

  function musicStab(t: number, freqs: readonly number[], level: number): void {
    if (!ctx || !layerTension) return;
    const context = ctx;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1400, t);
    filter.frequency.exponentialRampToValueAtTime(700, t + 0.08);
    filter.Q.value = 5;
    const gain = context.createGain();
    const end = envelope(gain.gain, t, level, 0.002, 0.07);
    filter.connect(gain);
    gain.connect(layerTension);
    for (let i = 0; i < freqs.length; i += 1) {
      const osc = context.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(freqs[i], t);
      osc.connect(filter);
      osc.start(t);
      osc.stop(end + 0.02);
      if (i === 0) osc.onended = () => gain.disconnect();
    }
  }

  /** One 16th step of the loop. Everything reads `intensity` to decide density. */
  function scheduleStep(step: number, t: number): void {
    const bar = Math.floor(step / 16) % 4;
    const beat = step % 16;
    const chord = CHORDS[bar];
    const i = intensity;

    // Bass — root motion, denser as pressure rises.
    const mask = BASS_MASKS[i < 0.32 ? 0 : i < 0.66 ? 1 : 2];
    if (mask.charCodeAt(beat) === 49) {
      const root = BASS_ROOTS[bar];
      const octave = beat === 0 || beat === 8 ? -12 : 0;
      musicBass(t, noteA2(root + octave), beat === 0 ? 0.44 : 0.26, 0.5, clamp01((i - 0.35) / 0.5));
    }

    // Percussion.
    if (i > 0.1) {
      const kickMask = i > 0.62 ? KICK_MASK_HOT : KICK_MASK;
      if (kickMask.charCodeAt(beat) === 49) musicKick(t, beat % 8 === 0 ? 0.85 : 0.5);
      if (beat % 2 === 0) musicHat(t, beat % 4 === 0 ? 0.13 : 0.085, false);
      else if (i > 0.55) musicHat(t, 0.055, false);
      if (i > 0.58 && beat === 14) musicHat(t, 0.1, true);
      if (i > 0.3 && (beat === 4 || beat === 12)) musicSnare(t, 0.22 + i * 0.16);
      // End-of-loop fill: three accelerating hits into the downbeat.
      if (i > 0.55 && bar === 3 && beat >= 13) musicSnare(t, 0.14 + (beat - 12) * 0.07);
    }

    // Arpeggio — every other 16th until it earns full density.
    if (i > 0.26 && (i > 0.6 || beat % 2 === 0)) {
      const index = (step * 3 + bar) % chord.length;
      const octave = beat % 8 === 0 ? 24 : 12;
      musicArp(t, noteA2(chord[index] + octave), 0.16, clamp01((i - 0.26) / 0.6));
    }

    // Pad — retriggered on the bar so voices overlap and sound legato.
    if (beat === 0) {
      musicPad(t, [noteA2(chord[0]), noteA2(chord[1]), noteA2(chord[2] + 12)], 0.1, clamp01(i));
    }

    // Tension layer — offbeat stabs, only when it is genuinely tight.
    if (i > 0.62 && beat % 4 === 2) {
      musicStab(t, [noteA2(chord[2] + 12), noteA2(chord[0] + 24)], 0.12);
    }
  }

  /**
   * Layer gains and filter cutoff as a function of the smoothed intensity.
   *
   * The crossfades are deliberately staggered rather than parallel: the pad
   * *recedes* as the arp and tension layers arrive, so the arrangement gets
   * tighter and more rhythmic under pressure instead of merely louder.
   *
   * Every write is change-gated. `setIntensity` may be called once per frame,
   * and appending six automation events at 60 Hz would grow the timeline for
   * no audible benefit.
   */
  function applyIntensity(now: number): void {
    if (!musicFilter || !layerPad || !layerBass || !layerPerc || !layerArp || !layerTension) return;
    const i = intensity;
    const setGain = (param: AudioParam, value: number, key: "pad" | "bass" | "perc" | "arp" | "tension") => {
      if (appliedLayer[key] >= 0 && Math.abs(value - appliedLayer[key]) < 0.01) return;
      appliedLayer[key] = value;
      param.setTargetAtTime(value, now, 0.28);
    };
    setGain(layerPad.gain, 0.95 - 0.42 * i, "pad");
    setGain(layerBass.gain, 0.55 + 0.5 * i, "bass");
    setGain(layerPerc.gain, clamp01((i - 0.08) / 0.35), "perc");
    setGain(layerArp.gain, clamp01((i - 0.24) / 0.4), "arp");
    setGain(layerTension.gain, clamp01((i - 0.6) / 0.35), "tension");

    // Log sweep: 380 Hz nearly closed, ~12.9 kHz wide open. Slow motion squares
    // in on top of it, so the score sags with the world instead of ignoring it.
    const cutoff = clamp(380 * Math.pow(34, i) * musicRate * musicRate, 180, 15000);
    // Relative gate: a 3 % move in cutoff is inaudible, and this param spans
    // two decades so an absolute threshold would be wrong at one end or other.
    if (appliedLayer.cutoff < 0 || Math.abs(cutoff / appliedLayer.cutoff - 1) > 0.03) {
      appliedLayer.cutoff = cutoff;
      musicFilter.frequency.setTargetAtTime(cutoff, now, 0.3);
    }
  }

  /* ------------------------------------------------------------------ *
   * Scheduler pump
   * ------------------------------------------------------------------ */

  /**
   * The pump only exists to schedule things; when nothing needs scheduling it
   * stops entirely rather than idling at 40 Hz. A faded-out murmur bed does not
   * count: its fade is already on the audio thread's automation timeline, and
   * `setMurmur` restarts the pump if the crowd comes back.
   */
  function needsPump(): boolean {
    if (disposed || ctx === null) return false;
    return musicPlaying || voices.length > 0 || (murmurAlive && murmurLevel > 0.0002);
  }

  function ensurePump(): void {
    if (pumpTimer !== null || !needsPump()) return;
    pumpTimer = setTimeout(pump, PUMP_MS);
  }

  function pump(): void {
    pumpTimer = null;
    if (!ctx || disposed) return;
    const context = ctx;
    const now = context.currentTime;
    const raw = Math.max(0, now - lastPumpTime);
    const dt = Math.min(raw, 0.5);
    lastPumpTime = now;

    // Adaptive lookahead. A hidden tab throttles timers to about 1 Hz while the
    // audio clock keeps running, so a fixed 140 ms window would leave the score
    // full of holes the moment the player switches tabs. Rise instantly to the
    // observed wake interval, fall back slowly once wakes are frequent again.
    pumpWake = Math.max(raw, pumpWake * 0.85);
    const lookahead = clamp(pumpWake * 2.5 + 0.08, LOOKAHEAD, 1.8);

    // Exponential approach; frame-rate independent and never overshoots.
    intensity += (intensityTarget - intensity) * (1 - Math.exp(-dt / 0.5));
    musicRate += (musicRateTarget - musicRate) * (1 - Math.exp(-dt / 0.35));

    sweepVoices(now);

    if (musicPlaying) {
      applyIntensity(now);
      const stepSeconds = STEP_SECONDS / Math.max(0.25, musicRate);
      // If the clock has jumped far past the schedule — a suspended context, a
      // long stall — do not machine-gun the backlog into one instant. Skip the
      // missed steps and re-enter on a bar line so the groove stays coherent.
      if (nextStepTime < now - lookahead) {
        musicStep += Math.ceil((now - nextStepTime) / stepSeconds);
        musicStep += (16 - (musicStep % 16)) % 16;
        nextStepTime = now + 0.05;
      }
      while (nextStepTime < now + lookahead) {
        scheduleStep(musicStep, Math.max(nextStepTime, now + SCHEDULE_AHEAD));
        musicStep += 1;
        nextStepTime += stepSeconds;
      }
    }

    if (murmurAlive) {
      if (nextBlipTime < now - 1) nextBlipTime = now + 0.1;
      scheduleBlips(now, lookahead);
    }

    if (needsPump()) pumpTimer = setTimeout(pump, PUMP_MS);
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  /**
   * Stages the expensive bakes across separate macrotasks, just after the
   * unlock gesture returns.
   *
   * The gesture handler itself only pays for the graph and the white noise, so
   * the click that starts the round never blocks. Each stage after that is a
   * few milliseconds of its own task rather than one long block, and all of it
   * is done long before anything needs a room or a crowd. Baking lazily instead
   * would move the same cost to the worst possible moment: mid-round, the first
   * time the audience cheers.
   */
  function warm(): void {
    const stages: ((context: AudioContext) => void)[] = [
      (context) => {
        if (convolver) convolver.buffer = impulse(context);
      },
      (context) => void pink(context),
      (context) => void applause(context),
    ];
    let index = 0;
    const runStage = () => {
      const context = live();
      if (!context || index >= stages.length) return;
      stages[index](context);
      index += 1;
      if (index < stages.length) setTimeout(runStage, 0);
    };
    setTimeout(runStage, 0);
  }

  function unlock(): void {
    if (disposed) return;
    if (!ctx) {
      const Ctor = findAudioContextCtor();
      if (!Ctor) return;
      let created: AudioContext;
      try {
        created = new Ctor({ latencyHint: "interactive" });
      } catch {
        return;
      }
      ctx = created;
      lastPumpTime = created.currentTime;
      build(created);
      // Anything requested before the gesture now takes effect.
      if (musicWanted) startMusic();
      if (murmurLevel > 0.0002) {
        startMurmur(created);
        applyMurmurLevel(created.currentTime, 1.2);
        ensurePump();
      }
      warm();
    }
    if (ctx.state === "suspended") {
      ctx.resume().then(undefined, () => undefined);
    }
  }

  function duck(amount: number, seconds: number): void {
    const context = live();
    if (!context || !musicDuck) return;
    const t = context.currentTime;
    const depth = clamp01(amount);
    const g = musicDuck.gain;
    const attack = 0.018;
    const hold = clamp(seconds * 0.2, 0.02, 0.35);
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.linearRampToValueAtTime(Math.max(0.02, 1 - depth), t + attack);
    // Exponential release, the way a real sidechain lets go.
    g.setTargetAtTime(1, t + attack + hold, Math.max(0.06, seconds * 0.32));
  }

  function play(id: SfxId, options?: { gain?: number; rate?: number; pan?: number; delay?: number }): void {
    const profile = PROFILES[id];
    if (!profile) return;
    if (id === "crowd-murmur") {
      // The bed is a persistent, level-controlled loop rather than a one-shot:
      // play() with a gain sets its level, and gain 0 fades it out.
      setMurmur(options?.gain ?? 1);
      return;
    }
    const crowdSound = CROWD_SFX.has(id);
    const context = live();
    const bus = crowdSound ? crowdBus : sfxBus;
    const room = crowdSound ? crowdRoom : sfxRoom;
    if (!context || !bus || !room) return;
    // Muted is silent by definition, so do not pay to build a voice nobody can
    // hear. The murmur bed above is exempt: its level is state, not a trigger,
    // and it has to be correct the moment sound comes back.
    if (muted) return;
    // Same argument per bus: a switched-off bus is silent, so the voice, its
    // oscillators and its reverb send are all work with no output. This is
    // also what keeps a muted bus from consuming the shared voice budget.
    if (crowdSound ? !crowdOn : !sfxOn) return;
    const now = context.currentTime;

    const last = lastPlayed.get(id);
    if (last !== undefined && now - last < profile.gap) return;
    lastPlayed.set(id, now);

    // Streak pitching: consecutive shots and hits climb, then reset when the
    // player stops. This is what makes rapid fire feel like a mechanism.
    let ratePitch = 1;
    if (id === "fire") {
      fireStreak = now - lastFireAt < 0.7 ? Math.min(fireStreak + 1, 8) : 0;
      lastFireAt = now;
      ratePitch = (1 + fireStreak * 0.028) * rng.range(0.985, 1.015);
    } else if (id === "hit") {
      hitStreak = now - lastHitAt < 1.2 ? Math.min(hitStreak + 1, 8) : 0;
      lastHitAt = now;
      ratePitch = (1 + hitStreak * 0.016) * rng.range(0.98, 1.02);
    } else if (id === "combo-up") {
      // The ladder climbs while answers keep landing and resets once the run
      // breaks, so a streak walks up the scale without the caller tracking it.
      comboRung = now - lastComboAt < 2.5 ? Math.min(comboRung + 1, 10) : 0;
      lastComboAt = now;
    } else if (id === "slowmo-in") {
      // Slow motion is a world state, not just a sound: drag the score's tempo
      // and cutoff down with it, then let them recover on the way out.
      musicRateTarget = 0.86;
    } else if (id === "slowmo-out") {
      musicRateTarget = 1;
    }

    if (!reserve(id, profile, now)) return;

    const rate = clamp((options?.rate ?? 1) * ratePitch, 0.25, 4);
    const level = clamp(profile.gain * (options?.gain ?? 1), 0, 4);
    const start = now + Math.max(0, options?.delay ?? 0) + SCHEDULE_AHEAD;

    const out = context.createGain();
    out.gain.setValueAtTime(level, start - SCHEDULE_AHEAD * 0.5);
    let tail: AudioNode = out;
    const pan = options?.pan ?? 0;
    if (pan !== 0 && hasPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner);
      tail = panner;
    }
    tail.connect(bus);
    const escapes: AudioNode[] = [];
    if (profile.send > 0) {
      const send = context.createGain();
      send.gain.value = profile.send;
      tail.connect(send);
      send.connect(room);
      escapes.push(send);
    }

    const voice: Voice = {
      id,
      priority: profile.priority,
      started: start,
      ends: start + 0.2,
      out,
      sources: [],
      escapes,
      lastSource: null,
      lastSourceEnds: 0,
      stolen: false,
    };
    voices.push(voice);

    const emit: Emit = {
      t: start,
      out,
      room,
      rate,
      // Mild tape-style coupling: a transposed sound also shortens, but by the
      // square root, so a pitched-up UI click does not become inaudible.
      timeScale: clamp(1 / Math.sqrt(rate), 0.55, 1.7),
      keep(until: number) {
        if (until > voice.ends) voice.ends = until;
      },
      own(node: AudioScheduledSourceNode, ends: number) {
        voice.sources.push(node);
        // Track the source that stops last — layers are built in design order,
        // not in duration order, so "the last one created" is not the answer.
        if (!voice.lastSource || ends > voice.lastSourceEnds) {
          voice.lastSource = node;
          voice.lastSourceEnds = ends;
        }
      },
      escape(node: AudioNode) {
        voice.escapes.push(node);
      },
    };

    BUILDERS[id](emit);

    // The last source to stop frees the voice. `sweepVoices` is the safety net
    // for suspended contexts, where `onended` may never fire at all.
    if (voice.lastSource) voice.lastSource.onended = () => releaseVoice(voice);
    else voice.ends = start;

    if (profile.duck) duck(profile.duck[0], profile.duck[1]);
    ensurePump();
  }

  function setMuted(next: boolean): void {
    muted = next;
    if (!master) return;
    // Ramped, never hard-cut: a step on the master is an audible click.
    rampTo(master.gain, masterTarget(), next ? 0.18 : 0.25);
  }

  function setMasterLevel(level: number): void {
    masterUser = clamp01(level);
    if (!master) return;
    // A fader is dragged, so this runs at pointer rate; a short linear ramp
    // both removes the zipper noise and keeps up with the hand.
    rampTo(master.gain, masterTarget(), LEVEL_FADE);
  }

  function setIntensity(value: number): void {
    intensityTarget = clamp01(value);
    // Before unlock there is no pump to smooth towards the target, so track it
    // directly; the score then starts at the right weight rather than fading up
    // from calm the moment the player touches the page.
    if (!live()) intensity = intensityTarget;
  }

  /**
   * Runs the score. Split from `startMusic` so that the game's intent
   * (`musicWanted`) and the player's setting (`musicOn`) stay independent:
   * switching music back on mid-round has to resume it, and the round ending
   * while music is switched off must not leave it armed.
   */
  function beginMusic(): void {
    const context = live();
    if (!context || !musicBus || musicPlaying || !musicOn) return;
    const t = context.currentTime;
    musicPlaying = true;
    musicStep = 0;
    nextStepTime = t + 0.12;
    lastPumpTime = t;
    const g = musicBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.linearRampToValueAtTime(MUSIC_LEVEL, t + 1.2);
    applyIntensity(t);
    ensurePump();
  }

  /**
   * Stops the scheduler and fades what is already on the timeline.
   *
   * Clearing `musicPlaying` is the part that matters for cost: `pump` schedules
   * notes only while it is set, and `needsPump` drops the timer entirely once
   * nothing else needs it, so a switched-off score builds no oscillators at
   * all. Up to one lookahead window of notes is already scheduled, which is
   * exactly what the fade is for.
   */
  function endMusic(seconds: number): void {
    if (!musicPlaying) return;
    musicPlaying = false;
    if (!musicBus) return;
    rampTo(musicBus.gain, 0, seconds);
  }

  function startMusic(): void {
    musicWanted = true;
    beginMusic();
  }

  function stopMusic(): void {
    musicWanted = false;
    endMusic(0.9);
  }

  function setMusicEnabled(on: boolean): void {
    if (on === musicOn) return;
    musicOn = on;
    rampTo(musicUser ? musicUser.gain : null, musicTarget(), BUS_FADE);
    rampTo(musicRoom ? musicRoom.gain : null, musicTarget(), BUS_FADE);
    // Only resume what the game actually asked for. Switching music on from
    // the attract screen must arm the bus, not start a score over a menu.
    if (on) {
      if (musicWanted) beginMusic();
    } else {
      endMusic(BUS_FADE);
    }
  }

  function setMusicLevel(level: number): void {
    musicUserLevel = clamp01(level);
    rampTo(musicUser ? musicUser.gain : null, musicTarget(), LEVEL_FADE);
    rampTo(musicRoom ? musicRoom.gain : null, musicTarget(), LEVEL_FADE);
  }

  function setSfxEnabled(on: boolean): void {
    if (on === sfxOn) return;
    sfxOn = on;
    // Voices already in flight ride the fader down; new ones are never built.
    rampTo(sfxUser ? sfxUser.gain : null, sfxTarget(), BUS_FADE);
    rampTo(sfxRoom ? sfxRoom.gain : null, sfxTarget(), BUS_FADE);
  }

  function setSfxLevel(level: number): void {
    sfxUserLevel = clamp01(level);
    rampTo(sfxUser ? sfxUser.gain : null, sfxTarget(), LEVEL_FADE);
    rampTo(sfxRoom ? sfxRoom.gain : null, sfxTarget(), LEVEL_FADE);
  }

  function setCrowdEnabled(on: boolean): void {
    if (on === crowdOn) return;
    crowdOn = on;
    rampTo(crowdUser ? crowdUser.gain : null, crowdTarget(), BUS_FADE);
    rampTo(crowdRoom ? crowdRoom.gain : null, crowdTarget(), BUS_FADE);
    // The bed is a running source rather than a one-shot, so the switch has to
    // reach it directly: retire it on the way out, rebuild it on the way in.
    applyMurmurTarget(on ? 1.4 : BUS_FADE, !on);
  }

  function setCrowdLevel(level: number): void {
    crowdUserLevel = clamp01(level);
    rampTo(crowdUser ? crowdUser.gain : null, crowdTarget(), LEVEL_FADE);
    rampTo(crowdRoom ? crowdRoom.gain : null, crowdTarget(), LEVEL_FADE);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (pumpTimer !== null) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
    }
    musicPlaying = false;
    musicWanted = false;
    const context = ctx;
    if (!context) return;
    const t = context.currentTime;
    stopMurmur();
    for (let i = voices.length - 1; i >= 0; i -= 1) stealVoice(voices[i], t);
    voices.length = 0;
    if (master) {
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t);
      master.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    }
    // Close after the fade so the teardown itself does not click.
    setTimeout(() => {
      if (context.state !== "closed") context.close().then(undefined, () => undefined);
    }, 200);
    ctx = null;
    master = null;
    sfxBus = null;
    sfxUser = null;
    crowdBus = null;
    crowdUser = null;
    musicUser = null;
    musicBus = null;
    musicDuck = null;
    sfxRoom = null;
    crowdRoom = null;
    musicRoom = null;
    musicFilter = null;
    reverbIn = null;
    convolver = null;
    layerPad = null;
    layerBass = null;
    layerPerc = null;
    layerArp = null;
    layerTension = null;
    whiteBuffer = null;
    pinkBuffer = null;
    applauseBuffer = null;
    waveChime = null;
    waveOrgan = null;
    waveBuzz = null;
    waveVoice = null;
  }

  const engine: MixerAudioEngine = {
    unlock,
    play,
    setMuted,
    get muted() {
      return muted;
    },
    setIntensity,
    startMusic,
    stopMusic,
    duck,
    dispose,
    setMasterLevel,
    setMusicEnabled,
    setMusicLevel,
    setSfxEnabled,
    setSfxLevel,
    setCrowdEnabled,
    setCrowdLevel,
    get mix(): AudioMixState {
      // A fresh snapshot: the caller must not be able to write the mixer by
      // assigning to a shared object.
      return {
        master: masterUser,
        music: musicOn,
        musicLevel: musicUserLevel,
        sfx: sfxOn,
        sfxLevel: sfxUserLevel,
        crowd: crowdOn,
        crowdLevel: crowdUserLevel,
      };
    },
  };
  return engine;
}
