"use client";

import type { CSSProperties } from "react";

import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "./audioSettings";
import { useDialogFocusTrap } from "./focusTrap";

/** A fader needs its fill position in CSS; the track is a pseudo-element. */
type FaderStyle = CSSProperties & Record<"--mix-fill", string>;

interface BusRow {
  /** Key of the on/off switch in the settings record. */
  on: "music" | "sfx" | "crowd";
  /** Key of the level fader in the settings record. */
  level: "musicLevel" | "sfxLevel" | "crowdLevel";
  name: string;
  note: string;
}

/**
 * One strip per bus the engine actually separates. The audience is its own
 * strip rather than part of effects because the murmur, the cheer and the
 * groan are a continuous presence rather than feedback on an action, and they
 * are the first thing a player reaches for when a studio gets loud.
 */
const BUSES: readonly BusRow[] = [
  { on: "music", level: "musicLevel", name: "SHOW MUSIC", note: "The band bed under the segment." },
  { on: "sfx", level: "sfxLevel", name: "SOUND EFFECTS", note: "Mic hits, impacts, POP OFF, controls." },
  { on: "crowd", level: "crowdLevel", name: "AUDIENCE", note: "Studio murmur, cheers and groans." },
];

function percent(level: number): number {
  return Math.round(level * 100);
}

/** A hardware rocker. A real `role="switch"`, so Space and Enter both work. */
function MixSwitch({
  on,
  labelledBy,
  onToggle,
}: {
  on: boolean;
  labelledBy: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="mix-switch"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      onClick={onToggle}
    >
      {/* The state is carried by aria-checked, so the printed word is decoration
          for sighted players — announcing it as well would say "on, on". */}
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
      <span className="switch-state" aria-hidden="true">
        {on ? "ON" : "OFF"}
      </span>
    </button>
  );
}

/** A channel fader. A native range input: arrows, Home/End and drag all work. */
function MixFader({
  name,
  level,
  on,
  onLevel,
}: {
  name: string;
  level: number;
  on: boolean;
  onLevel: (value: number) => void;
}) {
  const value = percent(level);
  const style: FaderStyle = { "--mix-fill": `${value}%` };
  return (
    <div className="mix-fader-row">
      <input
        type="range"
        className="mix-fader"
        style={style}
        min={0}
        max={100}
        step={1}
        value={value}
        data-on={on ? "true" : "false"}
        aria-label={`${name} level`}
        aria-valuetext={`${value} percent`}
        onChange={(event) => onLevel(Number(event.target.value) / 100)}
      />
      <span className="mix-level" data-on={on ? "true" : "false"} aria-hidden="true">
        {value}
      </span>
    </div>
  );
}

/**
 * The audio desk.
 *
 * The fiction is the gallery's monitor mixer: one strip per bus, each with a
 * hardware rocker and a fader, under a master output strip. The header lamp is
 * still the fast kill — this panel is where a player who wants the band gone
 * but the mic hits kept comes to say so.
 */
export function AudioPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: AudioSettings;
  onChange: (patch: Partial<AudioSettings>) => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocusTrap(onClose);
  const live = !settings.muted;
  const isDefault =
    settings.muted === DEFAULT_AUDIO_SETTINGS.muted &&
    settings.master === DEFAULT_AUDIO_SETTINGS.master &&
    settings.music === DEFAULT_AUDIO_SETTINGS.music &&
    settings.musicLevel === DEFAULT_AUDIO_SETTINGS.musicLevel &&
    settings.sfx === DEFAULT_AUDIO_SETTINGS.sfx &&
    settings.sfxLevel === DEFAULT_AUDIO_SETTINGS.sfxLevel &&
    settings.crowd === DEFAULT_AUDIO_SETTINGS.crowd &&
    settings.crowdLevel === DEFAULT_AUDIO_SETTINGS.crowdLevel;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="audio-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mix-title"
        aria-describedby="mix-lede"
        ref={dialogRef}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        /* The shell binds Space, the arrows, P and R on `window` and calls
           preventDefault on them, which would eat the very keys these
           controls run on — Space toggles a rocker, the arrows move a fader.
           React dispatches at its root, below `window`, so stopping here
           keeps the round's controls inert while the desk has focus. */
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <button type="button" className="modal-close" aria-label="Close the audio desk" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>

        <div className="modal-head">
          <p className="k-kicker">MWM GALLERY &middot; AUDIO DESK</p>
          <h2 id="mix-title">SOUND MIX</h2>
          <p id="mix-lede" className="k-body">
            Four buses off one output. Switch a bus off and it stops playing entirely.
          </p>
        </div>

        <div className="mix-desk">
          <section className="mix-strip master">
            <div className="mix-id">
              <p className="mix-name" id="mix-master-name">
                STUDIO OUTPUT
              </p>
              <p className="mix-note">
                {live
                  ? "Everything above the transmitter. The header lamp throws the same switch."
                  : "Muted. Nothing is audible until this goes back on."}
              </p>
            </div>
            <MixSwitch
              on={live}
              labelledBy="mix-master-name"
              onToggle={() => onChange({ muted: live })}
            />
            <MixFader
              name="Studio output"
              level={settings.master}
              on={live}
              onLevel={(value) => onChange({ master: value })}
            />
          </section>

          {BUSES.map((bus) => {
            const on = settings[bus.on];
            const nameId = `mix-${bus.on}-name`;
            return (
              <section className="mix-strip" key={bus.on}>
                <div className="mix-id">
                  <p className="mix-name" id={nameId}>
                    {bus.name}
                  </p>
                  <p className="mix-note">{bus.note}</p>
                </div>
                <MixSwitch on={on} labelledBy={nameId} onToggle={() => onChange({ [bus.on]: !on })} />
                <MixFader
                  name={bus.name}
                  level={settings[bus.level]}
                  on={on}
                  onLevel={(value) => onChange({ [bus.level]: value })}
                />
              </section>
            );
          })}
        </div>

        <div className="modal-foot mix-foot">
          <button
            type="button"
            className="ghost-button"
            disabled={isDefault}
            onClick={() => onChange(DEFAULT_AUDIO_SETTINGS)}
          >
            RESET TO BROADCAST
          </button>
          <button type="button" className="primary-control" onClick={onClose}>
            <span className="control-label">BACK TO THE SHOW</span>
            <span className="keycap on-hemi" aria-hidden="true">
              ESC
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
