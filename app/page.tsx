"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CARD_HALF_HEIGHT,
  DESK_X,
  DESK_Y,
  FIRE_COOLDOWN,
  GAME_HEIGHT,
  GAME_WIDTH,
  LETTERS,
  MAX_BACKLOG,
  MUZZLE_OFFSET,
  QUESTION_SPECS,
  REVIEW_INTERVAL_SECONDS,
  ROUND_SECONDS,
  SHOT_SPEED,
  SIM_STEP,
  SPAWN_Y,
  STAGE_Y,
  answersTo,
  assistedAimAngle,
  backlogAfterReview,
  difficultyAt,
  expectedLetter,
  insideStrikeBox,
  nextAmmoIndex,
  patienceTier,
  perfectChainBonus,
  pickSpawnX,
  predictedTarget,
  questionPool,
  questionsOverlap,
  scoreForAnswer,
  separateQuestions,
  shouldBurnBacklog,
  type QuestionKind,
  type QuestionSpec,
  type SoonLetter,
} from "../lib/pop";
import { createScene, type Scene, type SceneFrame } from "../lib/render/scene";
import type { QualityTier } from "../lib/render/types";
import { AudioPanel } from "./components/AudioPanel";
import {
  DEFAULT_AUDIO_SETTINGS,
  applyAudioPatch,
  readAudioSettings,
  writeAudioSettings,
  type AudioSettings,
} from "./components/audioSettings";
import { GalleryStrap } from "./components/GalleryStrap";
import { HowToModal } from "./components/HowToModal";
import { Leaderboards } from "./components/Leaderboards";
import { OnchainScore } from "./components/OnchainScore";
import { ProducerRack } from "./components/ProducerRack";
import { ShowHeader } from "./components/ShowHeader";
import { AttractOverlay, ResultOverlay } from "./components/StageOverlays";
import { ThumbBar } from "./components/ThumbBar";
import { EMPTY_TRACE_HASH } from "../lib/chain";
import type { FinalRunResult, RunProof } from "../lib/chain";

type Phase = "idle" | "playing" | "won" | "lost";

/**
 * Caller card. Deliberately shaped so it can be handed straight to the scene as
 * a `SceneQuestionInput` with no per-frame mapping: the adapter work that the
 * renderer needs (danger, targeting, knockback, squash, rotation) happens
 * inside `lib/render/scene.ts`, not here.
 */
interface QuestionBubble {
  id: number;
  kind: QuestionKind;
  label: string;
  x: number;
  baseX: number;
  y: number;
  speed: number;
  progress: number;
  /** Letters required in total. */
  total: number;
  words: number;
  value: number;
  width: number;
  color: string;
  motion: QuestionSpec["motion"];
  phase: number;
  /** Seconds since spawn. */
  age: number;
  /** Seconds since last struck; starts large so a fresh card never flashes. */
  sinceHit: number;
}

interface SoonShot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  letter: SoonLetter;
  age: number;
}

interface GameState {
  phase: Phase;
  elapsed: number;
  score: number;
  backlog: number;
  combo: number;
  bestCombo: number;
  answered: number;
  shots: number;
  hits: number;
  popMeter: number;
  ammoIndex: number;
  aim: number;
  questions: QuestionBubble[];
  projectiles: SoonShot[];
  spawnTimer: number;
  cooldown: number;
  slowTimer: number;
  announcement: string;
  announcementTimer: number;
  announcementAge: number;
  /** No wrong letter and no landing since this patience chain began. */
  chainClean: boolean;
  perfectChains: number;
  flash: number;
  randomState: number;
  entityId: number;
  nextReviewAt: number;
  /**
   * The last letter that landed: which caller it struck and whether it was the
   * one that caller was waiting for. This is the ground truth the lock reticle
   * is predicting, so the QA bridge can check prediction against outcome.
   */
  lastStrike: { shotId: number; cardId: number; correct: boolean } | null;
}

interface HudState {
  score: number;
  time: number;
  backlog: number;
  combo: number;
  bestCombo: number;
  answered: number;
  shots: number;
  hits: number;
  popMeter: number;
  ammoIndex: number;
  slowTimer: number;
  announcement: string;
  activeQuestions: number;
  highScore: number;
  difficulty: string;
}

/** The fixed step. Shared with the shot prediction so the two cannot drift. */
const STEP = SIM_STEP;
const KEYBOARD_AIM_SPEED = 3.2;
/** Ceiling on simulation steps per rendered frame; stops a tab-return spiral. */
const MAX_STEPS_PER_FRAME = 5;

function randomHex32() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as const;
}

/**
 * A practice run. It carries no server ticket, so it can never be recorded on
 * chain, and its seed is local rather than server-issued.
 */
function createLocalRunProof(): RunProof {
  return {
    runId: randomHex32(),
    issuedAt: Math.floor(Date.now() / 1_000),
    ticket: null,
    seed: randomHex32(),
  };
}

function createGame(phase: Phase = "idle"): GameState {
  return {
    phase,
    elapsed: 0,
    score: 0,
    backlog: 0,
    combo: 0,
    bestCombo: 0,
    answered: 0,
    shots: 0,
    hits: 0,
    popMeter: 0,
    ammoIndex: 0,
    aim: -Math.PI / 2,
    questions: [],
    projectiles: [],
    spawnTimer: 2.8,
    cooldown: 0,
    slowTimer: 0,
    announcement: "MWM COMMUNITY TAKEOVER BEGINS IN 3…",
    announcementTimer: 3.2,
    announcementAge: 0,
    chainClean: true,
    perfectChains: 0,
    flash: 0,
    randomState: 0x50_4f_50,
    entityId: 1,
    nextReviewAt: REVIEW_INTERVAL_SECONDS,
    lastStrike: null,
  };
}

function initialHud(highScore = 0): HudState {
  return {
    score: 0,
    time: ROUND_SECONDS,
    backlog: 0,
    combo: 0,
    bestCombo: 0,
    answered: 0,
    shots: 0,
    hits: 0,
    popMeter: 0,
    ammoIndex: 0,
    slowTimer: 0,
    announcement: "MWM COMMUNITY TAKEOVER BEGINS IN 3…",
    activeQuestions: 0,
    highScore,
    difficulty: "OPENING CHAT",
  };
}

/** Deterministic stream owned by the simulation. Never `Math.random`. */
function random(game: GameState) {
  game.randomState = (Math.imul(game.randomState, 1_664_525) + 1_013_904_223) >>> 0;
  return game.randomState / 4_294_967_296;
}

function say(game: GameState, text: string, seconds = 2) {
  game.announcement = text;
  game.announcementTimer = seconds;
  game.announcementAge = 0;
}

/**
 * The angle a letter fired this instant would travel along. The single source
 * of this rule lives in `lib/pop.ts`, so the barrel, the lock reticle and the
 * projectile all read the same number.
 */
function assistedAim(game: GameState) {
  return assistedAimAngle(game.aim, LETTERS[game.ammoIndex], game.questions);
}

function fireShot(game: GameState, scene: Scene | null) {
  if (game.phase !== "playing" || game.cooldown > 0 || game.projectiles.length > 0) return;
  const aim = assistedAim(game);
  const letter = LETTERS[game.ammoIndex];
  game.aim = aim;
  const x = DESK_X + Math.cos(aim) * MUZZLE_OFFSET;
  const y = DESK_Y + Math.sin(aim) * MUZZLE_OFFSET;
  game.projectiles.push({
    id: game.entityId++,
    x,
    y,
    vx: Math.cos(aim) * SHOT_SPEED,
    vy: Math.sin(aim) * SHOT_SPEED,
    letter,
    age: 0,
  });
  game.shots += 1;
  game.cooldown = FIRE_COOLDOWN;
  scene?.onFire(x, y, aim, letter);
}

function spawnQuestion(game: GameState) {
  const pool = questionPool(game.elapsed);
  const isOpeningQuestion = game.elapsed < 8 && game.answered === 0 && game.backlog === 0;
  const spec = isOpeningQuestion ? QUESTION_SPECS[0] : pool[Math.floor(random(game) * pool.length)];
  const difficulty = difficultyAt(game.elapsed);
  const x = isOpeningQuestion
    ? DESK_X
    : pickSpawnX(spec.width, game.questions, () => random(game));
  game.questions.push({
    id: game.entityId++,
    kind: spec.kind,
    label: spec.label,
    x,
    baseX: x,
    // Below the gallery band, wholly inside the frame. The card is *keyed in*
    // by question.ts's entry choreography rather than sliding through the top
    // edge, so no frame ever shows a caller cut in half by it.
    y: SPAWN_Y,
    speed: spec.speed * difficulty.speedScale,
    progress: 0,
    total: spec.words * LETTERS.length,
    words: spec.words,
    value: spec.value,
    width: spec.width,
    color: spec.color,
    motion: spec.motion,
    phase: random(game) * Math.PI * 2,
    age: 0,
    sinceHit: 99,
  });
  if (isOpeningQuestion) {
    say(game, "FIRST CALLER — HOLD FIRE TO ANSWER S · O · O · N", 2.7);
  }
}

function syncHud(game: GameState, highScore: number): HudState {
  return {
    score: game.score,
    time: Math.max(0, ROUND_SECONDS - game.elapsed),
    backlog: game.backlog,
    combo: game.combo,
    bestCombo: game.bestCombo,
    answered: game.answered,
    shots: game.shots,
    hits: game.hits,
    popMeter: game.popMeter,
    ammoIndex: game.ammoIndex,
    slowTimer: game.slowTimer,
    announcement: game.announcement,
    activeQuestions: game.questions.length,
    highScore,
    difficulty: difficultyAt(game.elapsed).label,
  };
}

/**
 * Returns the rack to S when the caller that owned the half-finished word has
 * left the board.
 *
 * The rack only advances on a *correct* letter, and every caller starts at
 * `expectedLetter(0)` — "S". Only one caller can be mid-word at a time, because
 * advancing the rack is what puts it there. So if that caller leaves while O or
 * N is loaded — it lands on the floor, or POP Off clears the studio — then no
 * caller on the board is waiting for the loaded letter, no shot can ever be
 * correct, the rack can never advance, and the round is unwinnable: the player
 * holds the trigger and watches the backlog fill. This was unreachable while
 * the board ran empty and nothing ever landed. It is very reachable now.
 *
 * This only ever *relaxes* the rack. While any live caller is still waiting for
 * the loaded letter it does nothing, so a legitimate half-finished SOON is
 * never interrupted.
 */
function reloadRack(game: GameState) {
  const letter = LETTERS[game.ammoIndex];
  if (game.questions.some((question) => answersTo(question, letter))) return;
  game.ammoIndex = 0;
}

/** Moves a caller to the floor: backlog up, chain broken, the set takes a knock. */
function landQuestion(game: GameState, question: QuestionBubble, scene: Scene | null) {
  game.backlog += 1;
  game.combo = 0;
  game.chainClean = true;
  game.questions = game.questions.filter((candidate) => candidate.id !== question.id);
  reloadRack(game);
  say(game, `${question.label} TOOK OVER THE SHOW`, 1.9);
  scene?.onLand(question.x, STAGE_Y - 6, question.label);
}

function popOff(game: GameState, scene: Scene | null) {
  const cleared = game.questions.length;
  scene?.onPopOff(cleared, game.questions);
  game.questions = [];
  game.score += cleared * 260;
  game.answered += cleared;
  game.popMeter = 0;
  game.flash = 1;
  reloadRack(game);
  say(game, `POP OFF — ${cleared} QUESTIONS MOVED TO NEXT WEEK`, 2.5);
}

function updateGame(game: GameState, dt: number, scene: Scene | null) {
  /* An announcement expires on its own clock, in every phase. It used to be
     decremented below the `playing` guard, so the opening card the attract
     screen raises — "MWM COMMUNITY TAKEOVER BEGINS IN 3…" — never expired
     while the title screen was up, and the gallery was still holding it when
     play began. It is the game that decides a line is over, not the renderer,
     so the timer has to run wherever the line is on air. */
  game.announcementAge += dt;
  game.announcementTimer = Math.max(0, game.announcementTimer - dt);
  if (game.phase !== "playing") return;

  game.elapsed += dt;
  game.cooldown = Math.max(0, game.cooldown - dt);
  game.slowTimer = Math.max(0, game.slowTimer - dt);
  game.flash = Math.max(0, game.flash - dt * 2.5);

  // Every break is worth the same: eight seconds of slow chat and one question
  // archived. The 4:00 break used to wipe the backlog outright to cushion the
  // override expiring; there is no expiry to cushion now, and a free wipe at
  // 4:00 was a bigger swing than anything the player could earn.
  if (game.elapsed >= game.nextReviewAt && game.nextReviewAt < ROUND_SECONDS) {
    const minute = Math.round(game.nextReviewAt / REVIEW_INTERVAL_SECONDS);
    game.slowTimer = Math.max(game.slowTimer, 8);
    game.score += 250;
    game.backlog = backlogAfterReview(game.backlog);
    say(game, `MWM BREAK ${minute} — CHAT SLOWED, ONE QUESTION ARCHIVED`, 3);
    game.nextReviewAt += REVIEW_INTERVAL_SECONDS;
  }

  const difficulty = difficultyAt(game.elapsed);
  game.spawnTimer = Math.max(0, game.spawnTimer - dt);
  if (game.spawnTimer <= 0 && game.questions.length < difficulty.maxActive) {
    spawnQuestion(game);
    game.spawnTimer = difficulty.spawnDelay * (0.85 + random(game) * 0.3);
  }

  for (const shot of game.projectiles) {
    shot.x += shot.vx * dt;
    shot.y += shot.vy * dt;
    shot.age += dt;
  }

  const fallScale = game.slowTimer > 0 ? 0.48 : 1;
  for (const question of game.questions) {
    question.age += dt;
    question.sinceHit += dt;
    question.y += question.speed * fallScale * dt;
    // Motion is re-derived from the anchor every step so the separation solve
    // below can be a pure projection of it rather than an accumulating offset.
    const sway =
      question.motion === "sway"
        ? Math.sin(game.elapsed * 1.7 + question.phase) * 38
        : question.motion === "zigzag"
          ? Math.sin(game.elapsed * 3.1 + question.phase) * 58
          : 0;
    question.x = question.baseX + sway;
  }
  // ...and only then are two callers allowed to share a row. Running this after
  // motion is the whole point: sway and zigzag are what walk cards into each
  // other after a clean spawn.
  separateQuestions(game.questions);

  const spentShots = new Set<number>();
  const answeredQuestions = new Set<number>();
  for (const shot of game.projectiles) {
    if (spentShots.has(shot.id)) continue;
    for (const question of game.questions) {
      if (answeredQuestions.has(question.id)) continue;
      // The strike box lives in lib/pop.ts; the lock reticle traces this exact
      // test, in this exact order, so prediction and outcome cannot diverge.
      if (!insideStrikeBox(question, shot.x, shot.y, difficulty.hitPadding)) continue;
      spentShots.add(shot.id);
      const required = expectedLetter(question.progress);
      const liveAmmo = LETTERS[game.ammoIndex];
      const length = Math.hypot(shot.vx, shot.vy) || 1;
      game.lastStrike = {
        shotId: shot.id,
        cardId: question.id,
        correct: shot.letter === required && shot.letter === liveAmmo,
      };

      if (shot.letter === required && shot.letter === liveAmmo) {
        question.progress += 1;
        question.sinceHit = 0;
        game.hits += 1;
        game.score += 20 + game.combo * 3;
        game.ammoIndex = nextAmmoIndex(game.ammoIndex);

        const cardComplete = question.progress >= question.total;
        const wordComplete = question.progress % LETTERS.length === 0;
        const wordsLeft = Math.max(0, question.words - Math.floor(question.progress / LETTERS.length));
        scene?.onHit({
          x: shot.x,
          y: shot.y,
          color: question.color,
          letter: shot.letter,
          cardId: question.id,
          dirX: shot.vx / length,
          dirY: shot.vy / length,
          wordComplete,
          cardComplete,
          wordsLeft,
          words: question.words,
        });

        if (cardComplete) {
          answeredQuestions.add(question.id);
          game.answered += 1;
          game.combo += 1;
          game.bestCombo = Math.max(game.bestCombo, game.combo);
          const spec =
            QUESTION_SPECS.find((candidate) => candidate.kind === question.kind) ?? QUESTION_SPECS[0];
          const value = scoreForAnswer(spec, game.combo);
          game.score += value;
          /* POP Off is a board wipe, and at the old 28/20 the meter refilled
             every four answers — and because a wipe counts every caller it
             clears as answered, it partly refilled itself. On a busy board that
             was a total clear roughly every twenty seconds, which absorbed the
             pressure faster than the curve could apply it: switching POP Off
             off entirely was the single largest survival swing measured. At
             8/6 it charges about every dozen answers, so it stays the emergency
             it is described as rather than the way the round is played. */
          game.popMeter = Math.min(100, game.popMeter + (question.words > 1 ? 8 : 6));

          let bonus = 0;
          if (game.chainClean) {
            bonus = perfectChainBonus(game.combo);
            if (bonus > 0) {
              game.score += bonus;
              game.perfectChains += 1;
            }
          }

          say(game, `${patienceTier(game.combo)} — ${question.label} PARKED`, 1.7);
          scene?.onAnswer({
            x: question.x,
            y: question.y,
            color: question.color,
            value,
            combo: game.combo,
            cardId: question.id,
            words: question.words,
            perfect: game.chainClean,
            perfectBonus: bonus,
          });

          if (game.combo % 3 === 0) {
            game.slowTimer = Math.max(game.slowTimer, 4.5);
            say(game, "PROOF OF PATIENCE — CHAT SLOW MODE ACTIVE", 2);
          }
          if (shouldBurnBacklog(game.answered, game.backlog)) {
            game.backlog -= 1;
            game.score += 300;
            say(game, "MOD ACTION — ONE BACKLOG QUESTION ARCHIVED", 2.1);
          }
        }
      } else {
        game.chainClean = false;
        say(game, `MIC CHECK — NEXT RESPONSE NEEDS ${required}`, 1.1);
        scene?.onReject(shot.x, shot.y, required, question.id);
      }
      break;
    }
  }

  game.projectiles = game.projectiles.filter(
    (shot) =>
      !spentShots.has(shot.id) &&
      shot.x > -40 &&
      shot.x < GAME_WIDTH + 40 &&
      shot.y > -50 &&
      shot.y < GAME_HEIGHT + 30,
  );
  game.questions = game.questions.filter((question) => !answeredQuestions.has(question.id));

  const landed = game.questions.filter((question) => question.y + CARD_HALF_HEIGHT >= STAGE_Y);
  for (const question of landed) landQuestion(game, question, scene);

  /* A full backlog ends the show, at 0:20 exactly as at 4:20. There used to be
     a Producer Override here that halved a full queue instead, for the first
     four minutes: it made the opening unloseable and stacked every loss into
     the final sixty seconds, because that was the first second in which losing
     was permitted at all. The opening is forgiving now because it *is* easy —
     one caller, slow, generous spacing — and not because a rule forbids the
     loss state. */
  if (game.backlog >= MAX_BACKLOG) {
    game.phase = "lost";
    say(game, "THE COMMUNITY TOOK OVER MWM", 4);
  } else if (game.elapsed >= ROUND_SECONDS) {
    game.phase = "won";
    game.score += Math.max(0, MAX_BACKLOG - game.backlog) * 500;
    game.score += Math.round(game.popMeter) * 10;
    say(game, "MAX SURVIVED THE COMMUNITY Q&A", 4);
  }
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const gameRef = useRef<GameState>(createGame());
  const frameRef = useRef<SceneFrame>({
    phase: "idle",
    elapsed: 0,
    score: 0,
    combo: 0,
    backlog: 0,
    answered: 0,
    popMeter: 0,
    slowSeconds: 0,
    aim: -Math.PI / 2,
    ammoLetter: LETTERS[0],
    cooldown: 0,
    questions: [],
    shots: [],
    announcement: "",
    announcementAge: 0,
    difficultyLabel: "OPENING CHAT",
  });
  const highScoreRef = useRef(0);
  // The mix is held in a ref as well as in state: the engine effect reads it
  // while creating the scene, which happens before any re-render lands.
  const audioRef = useRef<AudioSettings>(DEFAULT_AUDIO_SETTINGS);
  const controlsRef = useRef({ left: false, right: false, fire: false });
  const runProofRef = useRef<RunProof | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [audio, setAudio] = useState<AudioSettings>(DEFAULT_AUDIO_SETTINGS);
  const [showHow, setShowHow] = useState(false);
  const [showMix, setShowMix] = useState(false);
  const [hud, setHud] = useState<HudState>(() => initialHud());
  const [finalResult, setFinalResult] = useState<FinalRunResult | null>(null);

  /**
   * Applies a mixer change: engine first, then state, then storage.
   *
   * Every change arrives from a click, a key or a drag, so it is a legitimate
   * moment to unlock audio — which is what makes the first move of a fader
   * audible on a page that has never been clicked.
   */
  const closeMix = useCallback(() => setShowMix(false), []);
  const closeBrief = useCallback(() => setShowHow(false), []);

  const changeAudio = useCallback((patch: Partial<AudioSettings>) => {
    const next = { ...audioRef.current, ...patch };
    audioRef.current = next;
    const scene = sceneRef.current;
    if (scene) {
      if (!next.muted) scene.unlockAudio();
      applyAudioPatch(scene.audio, patch);
    }
    setAudio(next);
    writeAudioSettings(next);
  }, []);

  const startGame = useCallback(() => {
    const next = createGame("playing");
    const localProof = createLocalRunProof();
    runProofRef.current = localProof;
    setFinalResult(null);
    controlsRef.current = { left: false, right: false, fire: false };
    gameRef.current = next;
    sceneRef.current?.unlockAudio();
    setHud(syncHud(next, highScoreRef.current));
    setPhase("playing");

    void fetch("/api/chain/run", { method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Onchain run tickets are disabled.");
        return response.json() as Promise<RunProof>;
      })
      .then((proof) => {
        if (gameRef.current.phase === "playing" && runProofRef.current?.runId === localProof.runId) {
          runProofRef.current = proof;
        }
      })
      .catch(() => {
        // Practice mode is always available, even if Mainnet submission is paused.
      });
  }, []);

  const shoot = useCallback(() => {
    sceneRef.current?.unlockAudio();
    fireShot(gameRef.current, sceneRef.current);
  }, []);

  const activatePop = useCallback(() => {
    const game = gameRef.current;
    if (game.phase !== "playing" || game.popMeter < 100) return;
    popOff(game, sceneRef.current);
    setHud(syncHud(game, highScoreRef.current));
  }, []);

  const setAimFromPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * GAME_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * GAME_HEIGHT;
    const angle = Math.atan2(y - DESK_Y, x - DESK_X);
    gameRef.current.aim = Math.max(-Math.PI + 0.12, Math.min(-0.12, angle));
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setAimFromPointer(event);
      controlsRef.current.fire = true;
      shoot();
    },
    [setAimFromPointer, shoot],
  );

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    controlsRef.current.fire = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /**
   * Restores the saved mix. Read here rather than in a state initialiser
   * because the page server-renders: `localStorage` does not exist there, and
   * seeding state from it would desync hydration. Declared above the engine
   * effect so `audioRef` is already correct when the scene is built.
   */
  useEffect(() => {
    const stored = readAudioSettings();
    // The ref must be correct synchronously — the engine effect below reads it
    // while building the scene. The render-state update is deferred a frame so
    // it cannot cascade renders out of this effect, matching the high-score
    // effect immediately after.
    audioRef.current = stored;
    const frame = window.requestAnimationFrame(() => setAudio(stored));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const stored = Number(window.localStorage.getItem("proof-of-patience-high-score") ?? 0);
      if (Number.isFinite(stored)) {
        highScoreRef.current = stored;
        setHud((current) => ({ ...current, highScore: stored }));
      }
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  /* ---- the engine: created lazily, disposed with the component ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // QA harnesses may pin the presentation path so a run can prove out either
    // the GPU chain or the 2D fallback deliberately. Unset in normal play.
    const qa = window as typeof window & { __POP_POST__?: "auto" | "gpu" | "off" };
    const scene = createScene({
      canvas,
      seed: 0x504f5021,
      muted: audioRef.current.muted,
      mix: audioRef.current,
      postProcessing: qa.__POP_POST__,
    });
    sceneRef.current = scene;

    const sync = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : GAME_WIDTH;
      const height = rect.height > 0 ? rect.height : (width * GAME_HEIGHT) / GAME_WIDTH;
      scene.resize(width, height, window.devicePixelRatio || 1);
    };
    sync();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(sync);
      observer.observe(canvas);
    }
    window.addEventListener("resize", sync);

    return () => {
      window.removeEventListener("resize", sync);
      observer?.disconnect();
      sceneRef.current = null;
      scene.dispose();
    };
  }, []);

  /* ---- fixed-step loop, driven through the engine clock ---------- */
  useEffect(() => {
    let animationFrame = 0;
    let lastTime = performance.now();
    let accumulator = 0;
    let hudTimer = 0;

    const frame = (time: number) => {
      const scene = sceneRef.current;
      const rawSeconds = Math.min(0.1, Math.max(0, (time - lastTime) / 1000));
      lastTime = time;

      // The clock is the time authority: hit-stop and slow motion scale the
      // delta *before* the accumulator sees it, so the fixed step simply runs
      // fewer times and the world freezes without the renderer freezing.
      const scaledSeconds = scene ? scene.tick(rawSeconds) : rawSeconds;
      accumulator += scaledSeconds;

      let steps = 0;
      while (accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
        const game = gameRef.current;
        const previousPhase = game.phase;
        const direction = Number(controlsRef.current.right) - Number(controlsRef.current.left);
        if (game.phase === "playing" && direction !== 0) {
          game.aim = Math.max(
            -Math.PI + 0.12,
            Math.min(-0.12, game.aim + direction * KEYBOARD_AIM_SPEED * STEP),
          );
        }
        if (controlsRef.current.fire) fireShot(game, scene);
        updateGame(game, STEP, scene);
        accumulator -= STEP;
        steps += 1;
        if (previousPhase === "playing" && game.phase !== "playing") {
          controlsRef.current.fire = false;
          if (game.score > highScoreRef.current) {
            highScoreRef.current = game.score;
            window.localStorage.setItem("proof-of-patience-high-score", String(game.score));
          }
          const proof = runProofRef.current ?? createLocalRunProof();
          setFinalResult({
            ...proof,
            score: game.score,
            survivalSeconds: Math.min(ROUND_SECONDS, Math.floor(game.elapsed)),
            answered: game.answered,
            shots: game.shots,
            hits: game.hits,
            // Deterministic replay is the next anti-cheat milestone. The field
            // is signed and emitted today so the verifier can begin requiring a
            // real trace without redeploying the contract.
            traceHash: EMPTY_TRACE_HASH,
          });
          setPhase(game.phase);
          setHud(syncHud(game, highScoreRef.current));
        }
      }
      if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0;

      hudTimer += rawSeconds;
      if (hudTimer >= 0.08) {
        hudTimer = 0;
        setHud(syncHud(gameRef.current, highScoreRef.current));
      }

      if (scene) {
        const game = gameRef.current;
        const next = frameRef.current;
        next.phase = game.phase;
        next.elapsed = game.elapsed;
        next.score = game.score;
        next.combo = game.combo;
        next.backlog = game.backlog;
        next.answered = game.answered;
        next.popMeter = game.popMeter;
        next.slowSeconds = game.slowTimer;
        next.aim = game.aim;
        next.ammoLetter = LETTERS[game.ammoIndex];
        next.cooldown = game.cooldown;
        next.questions = game.questions;
        next.shots = game.projectiles;
        next.announcement = game.announcementTimer > 0 ? game.announcement : "";
        next.announcementAge = game.announcementAge;
        next.difficultyLabel = difficultyAt(game.elapsed).label;
        scene.render(next);
      }

      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.key === "ArrowLeft" || key === "a") {
        event.preventDefault();
        controlsRef.current.left = true;
      }
      if (event.key === "ArrowRight" || key === "d") {
        event.preventDefault();
        controlsRef.current.right = true;
      }
      if (event.code === "Space") {
        event.preventDefault();
        controlsRef.current.fire = true;
        shoot();
      }
      if (key === "p") activatePop();
      if (key === "r" && gameRef.current.phase !== "playing") startGame();
      if (event.key === "Escape") setShowHow(false);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.key === "ArrowLeft" || key === "a") controlsRef.current.left = false;
      if (event.key === "ArrowRight" || key === "d") controlsRef.current.right = false;
      if (event.code === "Space") controlsRef.current.fire = false;
    };
    const clearControls = () => {
      controlsRef.current = { left: false, right: false, fire: false };
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearControls);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearControls);
    };
  }, [activatePop, shoot, startGame]);

  // Automated visual-QA hook. Inert unless a test harness sets __POP_QA__ first.
  useEffect(() => {
    /* Stripped from the production bundle. The flag gate alone was not enough:
       the harness exposes setCombo, advance() and triggerPop, so anyone who set
       __POP_QA__ from the console could drive an arbitrary score in a few
       milliseconds. Build with VITE_POP_QA=1 to keep it. */
    const qaEnabled =
      import.meta.env.DEV ||
      (import.meta.env as unknown as Record<string, string | undefined>).VITE_POP_QA === "1";
    if (!qaEnabled) return;
    const scope = window as typeof window & { __POP_QA__?: boolean; __popGame?: unknown };
    if (!scope.__POP_QA__) return;
    scope.__popGame = {
      game: () => gameRef.current,
      start: startGame,
      fire: () => fireShot(gameRef.current, sceneRef.current),
      /** Headless fast-forward: no scene events, so no particle or audio storm. */
      simulate: (seconds: number) => {
        const steps = Math.round(seconds / STEP);
        for (let index = 0; index < steps; index += 1) updateGame(gameRef.current, STEP, null);
      },
      aimNorm: (nx: number, ny: number) => {
        gameRef.current.aim = Math.atan2(ny * GAME_HEIGHT - DESK_Y, nx * GAME_WIDTH - DESK_X);
      },
      /**
       * Aim at a caller the loaded letter will actually reach — assist and
       * blockers included, i.e. the same answer the lock reticle gives. Falls
       * back to the first answerable caller when every one of them is screened.
       */
      aimAtTarget: () => {
        const game = gameRef.current;
        const letter = LETTERS[game.ammoIndex];
        const padding = difficultyAt(game.elapsed).hitPadding;
        let fallback: number | null = null;
        for (const question of game.questions) {
          if (!answersTo(question, letter)) continue;
          const aim = Math.atan2(question.y - DESK_Y, question.x - DESK_X);
          if (fallback === null) fallback = aim;
          if (predictedTarget(aim, letter, game.questions, padding) === question.id) {
            game.aim = aim;
            return;
          }
        }
        if (fallback !== null) game.aim = fallback;
      },
      /** The caller id the lock reticle is marking this instant, or −1. */
      predictedTarget: () => {
        const game = gameRef.current;
        return predictedTarget(
          game.aim,
          LETTERS[game.ammoIndex],
          game.questions,
          difficultyAt(game.elapsed).hitPadding,
        );
      },
      /** Every pair of callers currently printing over each other. */
      overlaps: () => {
        const questions = gameRef.current.questions;
        const pairs: { a: number; b: number; dx: number; dy: number }[] = [];
        for (let i = 0; i < questions.length - 1; i += 1) {
          for (let j = i + 1; j < questions.length; j += 1) {
            if (!questionsOverlap(questions[i], questions[j])) continue;
            pairs.push({
              a: questions[i].id,
              b: questions[j].id,
              dx: Math.abs(questions[i].x - questions[j].x),
              dy: Math.abs(questions[i].y - questions[j].y),
            });
          }
        }
        return pairs;
      },
      /** Callers currently sliced by the top edge of the frame. */
      clipped: () =>
        gameRef.current.questions
          .filter((question) => question.y - CARD_HALF_HEIGHT < 0 && question.y + CARD_HALF_HEIGHT > 0)
          .map((question) => ({ id: question.id, label: question.label, y: question.y })),
      setPhase: (next: Phase) => {
        gameRef.current.phase = next;
        setPhase(next);
        setHud(syncHud(gameRef.current, highScoreRef.current));
      },
      setCombo: (value: number) => {
        const game = gameRef.current;
        game.combo = Math.max(0, Math.round(value));
        game.bestCombo = Math.max(game.bestCombo, game.combo);
      },
      triggerPop: () => {
        const game = gameRef.current;
        game.popMeter = 100;
        popOff(game, sceneRef.current);
      },
      triggerLand: () => {
        const game = gameRef.current;
        const victim = game.questions[0];
        if (victim) landQuestion(game, victim, sceneRef.current);
      },
      setQuality: (tier: QualityTier) => sceneRef.current?.setQuality(tier),
      /** The live mixer position, for the audio probe. */
      audioMix: () => sceneRef.current?.audio.mix ?? null,
      setAudio: (patch: Partial<AudioSettings>) => changeAudio(patch),
      diagnostics: () => ({
        quality: sceneRef.current?.quality ?? null,
        postProcessing: sceneRef.current?.postProcessing ?? null,
        reducedMotion: sceneRef.current?.reducedMotion ?? null,
        muted: sceneRef.current?.audio.muted ?? null,
        canvas: canvasRef.current ? `${canvasRef.current.width}x${canvasRef.current.height}` : null,
      }),
    };
    return () => {
      delete scope.__popGame;
    };
  }, [changeAudio, startGame]);

  const accuracy = hud.shots > 0 ? Math.round((hud.hits / hud.shots) * 100) : 100;
  const nextLetter = LETTERS[hud.ammoIndex];
  /* The queue-risk light. There is no Producer Override any more, so this is no
     longer "is the safety net still up" but "does the queue still have room":
     true while the backlog is more than two questions clear of going off air. */
  const queueHasRoom = hud.backlog < MAX_BACKLOG - 2;
  const live = phase === "playing";
  const holdAnswer = () => {
    controlsRef.current.fire = true;
    shoot();
  };
  const releaseAnswer = () => {
    controlsRef.current.fire = false;
  };

  return (
    <main className="pop-shell">
      <div className="shell-grain" aria-hidden="true" />
      <div className="shell-vignette" aria-hidden="true" />

      <ShowHeader
        muted={audio.muted}
        mixOpen={showMix}
        onOpenBrief={() => setShowHow(true)}
        onOpenMix={() => {
          // Opening the desk is a gesture, so the graph can come up now and
          // every switch inside is audible on its first press.
          if (!audio.muted) sceneRef.current?.unlockAudio();
          setShowMix(true);
        }}
        onToggleSound={() => changeAudio({ muted: !audioRef.current.muted })}
      />

      <GalleryStrap
        backlog={hud.backlog}
        maxBacklog={MAX_BACKLOG}
        queueHasRoom={queueHasRoom}
        highScore={hud.highScore}
      />

      <section className="play-grid">
        <div className="studio-stage">
          <canvas
            ref={canvasRef}
            width={GAME_WIDTH}
            height={GAME_HEIGHT}
            aria-label="Proof of Patience play field. Drag toward a community question and hold to answer with S O O N."
            onPointerMove={setAimFromPointer}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onLostPointerCapture={() => { controlsRef.current.fire = false; }}
          />

          {phase === "idle" && <AttractOverlay onStart={startGame} />}

          {(phase === "won" || phase === "lost") && (
            <ResultOverlay
              won={phase === "won"}
              stats={{
                score: hud.score,
                answered: hud.answered,
                accuracy,
                bestCombo: hud.bestCombo,
              }}
              chainAction={finalResult ? <OnchainScore result={finalResult} /> : undefined}
              onRestart={startGame}
            />
          )}
        </div>

        <ProducerRack
          live={live}
          ammoIndex={hud.ammoIndex}
          nextLetter={nextLetter}
          popMeter={hud.popMeter}
          answered={hud.answered}
          accuracy={accuracy}
          bestCombo={hud.bestCombo}
          shots={hud.shots}
          onAnswerDown={holdAnswer}
          onAnswerUp={releaseAnswer}
          onPopOff={activatePop}
        />
      </section>

      <Leaderboards />

      <footer className="show-footer">
        <p>
          Proof of Patience™ is a trademark of Neva Technologies Inc. © 2026 Neva Technologies
          Inc. A fictional community satire and unofficial fan game; no rewards, claims,
          allocations or incidents are represented by it.
        </p>
        <div className="control-legend">
          <span>
            AIM
            <b className="keycap">A</b>
            <b className="keycap">D</b>
          </span>
          <span>
            ANSWER
            <b className="keycap">SPACE</b>
          </span>
          <span>
            POP OFF
            <b className="keycap">P</b>
          </span>
        </div>
      </footer>

      <ThumbBar
        live={live}
        nextLetter={nextLetter}
        charged={hud.popMeter >= 100}
        onAnswerDown={holdAnswer}
        onAnswerUp={releaseAnswer}
        onPopOff={activatePop}
      />

      {/* The canvas speaks its announcements graphically; this is the same
          information for a screen reader, and nothing else. */}
      <p className="sr-only" role="status" aria-live="polite">
        {hud.announcement}
      </p>

      {showHow && <HowToModal onClose={closeBrief} />}

      {showMix && <AudioPanel settings={audio} onChange={changeAudio} onClose={closeMix} />}
    </main>
  );
}
