"use client";

import type { CSSProperties } from "react";

import { Odometer } from "./Odometer";

/**
 * The gallery strap.
 *
 * Deliberately *not* a second scoreboard: patience points, time remaining,
 * patience streak and active callers are all printed inside the picture by
 * `lib/render/overlay.ts`, and repeating them here would put two treatments of
 * the same number on one screen. The strap carries the three things the canvas
 * does not — how full the question queue is, whether that queue still has room
 * to absorb a caller, and what this machine's best run was.
 *
 * Every cell is the same two-row grid with the same row heights, so the kickers
 * share one baseline and the values share another right across the strap.
 */
export function GalleryStrap({
  backlog,
  maxBacklog,
  queueHasRoom,
  highScore,
}: {
  backlog: number;
  maxBacklog: number;
  /**
   * True while the backlog is still clear of going off air. There is no
   * Producer Override any more — nothing bails the host out at any point in
   * the round — so this cell reports headroom, and headroom is the *calm*
   * state. The tone therefore runs the opposite way to the armed-override
   * light it replaces.
   */
  queueHasRoom: boolean;
  highScore: number;
}) {
  const filled = Math.max(0, Math.min(maxBacklog, backlog));
  const critical = filled >= maxBacklog - 1;
  const state = queueState(filled, maxBacklog);

  return (
    <section className="gallery-strap" aria-label="Producer gallery">
      <div className="strap-cell">
        <div className="strap-kicker">
          <span className="k-kicker">QUESTION BACKLOG</span>
          <span className="strap-state" data-tone={state.tone}>
            {state.word}
          </span>
        </div>
        <div className="strap-figure">
          <span className={critical ? "count-of hot" : "count-of"}>
            <b>{String(filled).padStart(2, "0")}</b>
            <span>/{String(maxBacklog).padStart(2, "0")}</span>
          </span>
          <span
            className="backlog-rack"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={maxBacklog}
            aria-valuenow={filled}
            aria-valuetext={`${filled} of ${maxBacklog} questions in the backlog`}
            aria-label="Question backlog"
          >
            {Array.from({ length: maxBacklog }).map((_, index) => (
              <i
                key={index}
                aria-hidden="true"
                className={pipClass(index, filled, maxBacklog)}
                style={{ "--i": index } as CSSProperties}
              />
            ))}
          </span>
        </div>
      </div>

      <div className="strap-cell">
        <div className="strap-kicker">
          <span className="k-kicker">QUESTION QUEUE</span>
        </div>
        <div className="strap-figure">
          <span className="strap-state" data-tone={queueHasRoom ? "calm" : "warn"}>
            {queueHasRoom ? "STABLE" : "CRITICAL"}
          </span>
          <span className="strap-note">
            {queueHasRoom ? "Backlog has room" : "One caller from off air"}
          </span>
        </div>
      </div>

      <div className="strap-cell">
        <div className="strap-kicker">
          <span className="k-kicker">BEST PATIENCE POINTS</span>
        </div>
        <div className="strap-figure">
          <Odometer
            value={highScore}
            digits={6}
            label="Local best patience points"
            className="k-value"
          />
        </div>
      </div>
    </section>
  );
}

function pipClass(index: number, filled: number, max: number) {
  if (index >= filled) return "pip";
  return index >= max - 2 ? "pip lit critical" : "pip lit";
}

function queueState(filled: number, max: number): { word: string; tone: string } {
  if (filled === 0) return { word: "CLEAR", tone: "calm" };
  if (filled >= max - 1) return { word: "CRITICAL", tone: "hot" };
  if (filled > max / 2) return { word: "RISING", tone: "warn" };
  return { word: "STABLE", tone: "calm" };
}
