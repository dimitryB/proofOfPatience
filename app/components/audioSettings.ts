"use client";

import type { AudioMixState, MixerAudioEngine } from "../../lib/engine/audio";

/**
 * The player's saved audio position: the engine's mixer plus the master mute
 * that the header lamp drives.
 */
export interface AudioSettings extends AudioMixState {
  /** Master mute. Silences everything without moving a single fader. */
  muted: boolean;
}

/**
 * Everything on, at the levels the game shipped with. A player who never opens
 * the panel must hear exactly what they heard before it existed, so every
 * level here is 1 — a *relative* trim on the designed mix, not an absolute
 * volume.
 */
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  muted: false,
  master: 1,
  music: true,
  musicLevel: 1,
  sfx: true,
  sfxLevel: 1,
  crowd: true,
  crowdLevel: 1,
};

const STORAGE_KEY = "proof-of-patience-audio";

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function readLevel(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Loads the saved mix.
 *
 * Must be called from an effect, never during render: the app server-renders,
 * so touching `localStorage` at module scope or in a state initialiser would
 * either throw on the server or desync hydration.
 *
 * Anything unreadable — no entry, private-mode `localStorage` that throws,
 * truncated JSON, a hand-edited value, a field of the wrong type, a level of
 * `NaN` — falls back field by field to the shipped default rather than
 * discarding the whole record.
 */
export function readAudioSettings(): AudioSettings {
  if (typeof window === "undefined") return DEFAULT_AUDIO_SETTINGS;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage disabled or blocked by policy. Defaults are a fine answer.
    return DEFAULT_AUDIO_SETTINGS;
  }
  if (!raw) return DEFAULT_AUDIO_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_AUDIO_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_AUDIO_SETTINGS;
  }
  const source = parsed as Record<string, unknown>;
  return {
    muted: readBoolean(source, "muted", DEFAULT_AUDIO_SETTINGS.muted),
    master: readLevel(source, "master", DEFAULT_AUDIO_SETTINGS.master),
    music: readBoolean(source, "music", DEFAULT_AUDIO_SETTINGS.music),
    musicLevel: readLevel(source, "musicLevel", DEFAULT_AUDIO_SETTINGS.musicLevel),
    sfx: readBoolean(source, "sfx", DEFAULT_AUDIO_SETTINGS.sfx),
    sfxLevel: readLevel(source, "sfxLevel", DEFAULT_AUDIO_SETTINGS.sfxLevel),
    crowd: readBoolean(source, "crowd", DEFAULT_AUDIO_SETTINGS.crowd),
    crowdLevel: readLevel(source, "crowdLevel", DEFAULT_AUDIO_SETTINGS.crowdLevel),
  };
}

/** Saves the mix. A full storage quota or a blocked store is not worth a crash. */
export function writeAudioSettings(settings: AudioSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Nothing to do: the session keeps its settings, the next one starts fresh.
  }
}

/**
 * Pushes only what changed at the engine.
 *
 * Applying the whole record on every event would re-arm a ramp on all four
 * buses each time a fader moves a pixel; a patch touches one param.
 */
export function applyAudioPatch(engine: MixerAudioEngine, patch: Partial<AudioSettings>): void {
  if (patch.muted !== undefined) engine.setMuted(patch.muted);
  if (patch.master !== undefined) engine.setMasterLevel(patch.master);
  if (patch.music !== undefined) engine.setMusicEnabled(patch.music);
  if (patch.musicLevel !== undefined) engine.setMusicLevel(patch.musicLevel);
  if (patch.sfx !== undefined) engine.setSfxEnabled(patch.sfx);
  if (patch.sfxLevel !== undefined) engine.setSfxLevel(patch.sfxLevel);
  if (patch.crowd !== undefined) engine.setCrowdEnabled(patch.crowd);
  if (patch.crowdLevel !== undefined) engine.setCrowdLevel(patch.crowdLevel);
}
