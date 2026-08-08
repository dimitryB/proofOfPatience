"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { MAX_BACKLOG } from "../../lib/pop";
import { Odometer } from "./Odometer";
import { isEngaged } from "./engagement";

/**
 * A result overlay replaces the control the player was holding, so focus has to
 * be handed somewhere deliberate. It goes to the one action on the screen.
 */
function useResultFocus() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isEngaged()) return;
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

function RegistrationMarks() {
  return (
    <div className="reg-marks" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}

/**
 * The attract screen. A title card, not a centred paragraph on black: the
 * scrim is graded across the frame so the studio stays visible behind the
 * type, a hemi rule anchors the left edge, and the block enters in staged
 * beats — rule, eyebrow, title, lede, control, meta.
 */
export function AttractOverlay({ onStart }: { onStart: () => void }) {
  return (
    <div className="stage-overlay is-attract">
      <RegistrationMarks />
      <p className="overlay-eyebrow">TONIGHT ON MWM &middot; THE AUDIENCE ASKS EVERYTHING</p>
      <h2 className="overlay-title">
        How long can Max
        <em>stay patient?</em>
      </h2>
      <p className="overlay-lede">
        Callers descend on the desk faster than the host can answer. Point the mic at one and hold
        &mdash; every question gets the same reply, <b>S · O · O · N</b>, one letter at a time.
      </p>
      <button type="button" className="primary-control cta" onClick={onStart}>
        <span className="control-label">GO LIVE</span>
        <span className="keycap on-hemi" aria-hidden="true">
          ENTER
        </span>
      </button>
      <p className="overlay-meta">
        <span>FIVE-MINUTE SEGMENT</span>
        <span>{MAX_BACKLOG}-DEEP QUESTION BACKLOG</span>
        <span>PRACTICE LOCALLY &middot; WALLET ONLY TO RECORD</span>
      </p>
    </div>
  );
}

export interface ResultStats {
  score: number;
  answered: number;
  accuracy: number;
  bestCombo: number;
}

/**
 * Victory and defeat. Same skeleton, deliberately different weather: the win
 * lifts warm from below and puts the score on a hemi plate that rolls up like a
 * counter settling; the loss stays cold and states the queue that beat you.
 */
export function ResultOverlay({
  won,
  stats,
  chainAction,
  onRestart,
}: {
  won: boolean;
  stats: ResultStats;
  chainAction?: ReactNode;
  onRestart: () => void;
}) {
  const ctaRef = useResultFocus();

  return (
    <div className={`stage-overlay ${won ? "is-won" : "is-lost"}`}>
      <RegistrationMarks />
      <p className="overlay-eyebrow">
        {won ? "SEGMENT CLEARED · CHAT SATISFIED" : "SEGMENT LOST · CHAT UNCONVINCED"}
      </p>
      <h2 className="overlay-title">
        {won ? "Max survived" : "Same time"}
        <em>{won ? "the takeover." : "next week?"}</em>
      </h2>
      <dl className="result-ledger">
        <div className="hero">
          <dt className="ledger-kicker">{won ? "FINAL PATIENCE POINTS" : "PATIENCE POINTS"}</dt>
          <dd className="ledger-value">
            <Odometer value={stats.score} digits={6} label="Patience points" />
          </dd>
        </div>
        <div>
          <dt className="ledger-kicker">QUESTIONS PARKED</dt>
          <dd className="ledger-value">{String(stats.answered).padStart(2, "0")}</dd>
        </div>
        <div>
          <dt className="ledger-kicker">ANSWER ACCURACY</dt>
          <dd className="ledger-value">{stats.accuracy}%</dd>
        </div>
        <div>
          <dt className="ledger-kicker">BEST PATIENCE STREAK</dt>
          <dd className="ledger-value">&times;{stats.bestCombo}</dd>
        </div>
      </dl>
      <div className="result-actions">
        {chainAction}
        <button type="button" ref={ctaRef} className="primary-control cta restart-control" onClick={onRestart}>
          <span className="control-label">GO LIVE AGAIN</span>
          <span className="keycap" aria-hidden="true">
            R
          </span>
        </button>
      </div>
      {/* Two facts the outcome guarantees. The run's numbers are in the
          ledger and the machine's best is in the gallery strap; neither is
          repeated here. */}
      <p className="overlay-meta">
        <span>{won ? "FIVE-MINUTE SEGMENT COMPLETE" : `THE QUEUE REACHED ${MAX_BACKLOG}`}</span>
        <span>{won ? "MAX KEPT THE DESK" : "CHAT TOOK THE DESK"}</span>
      </p>
    </div>
  );
}
