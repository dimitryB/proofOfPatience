"use client";

import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { isEngaged, watchEngagement } from "./engagement";

export interface AnswerControlProps {
  /** The letter the mic will fire next. Mirrors the canvas' loaded letter. */
  letter: string;
  disabled: boolean;
  onDown: () => void;
  onUp: () => void;
  /** Hide the keyboard hint where there is no keyboard. */
  showKey?: boolean;
}

/**
 * The primary control.
 *
 * The face is a single flat hemi value under the type — the machining lives in
 * the edge shadows, never under a glyph — so the label's contrast is the same
 * across the whole cap. Near-black `--hemi-ink` on `#ff4600` measures 5.5:1,
 * which clears AA at every size this label is ever set at. The previous build
 * put aluminium on that face and measured 1.4:1.
 */
export function AnswerControl({ letter, disabled, onDown, onUp, showKey = true }: AnswerControlProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasDisabled = useRef(disabled);

  useEffect(watchEngagement, []);

  // When the segment goes live the attract control unmounts, which would drop
  // focus on the floor. Hand it to the primary control instead, so a keyboard
  // player goes straight from GO LIVE to holding Space with no blind Tab.
  useEffect(() => {
    const wasOff = wasDisabled.current;
    wasDisabled.current = disabled;
    if (!wasOff || disabled || !isEngaged()) return;
    const active = document.activeElement;
    // Never yank focus away from something the player deliberately moved to.
    if (active && active !== document.body && active.tagName !== "CANVAS") return;
    buttonRef.current?.focus({ preventScroll: true });
  }, [disabled]);

  const press = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (disabled) return;
    onDown();
  };

  return (
    <button
      type="button"
      ref={buttonRef}
      className="primary-control"
      disabled={disabled}
      onPointerDown={press}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={onUp}
      onClick={() => {
        if (!disabled) onDown();
      }}
      aria-label={`Hold to answer. Next letter ${letter}.`}
    >
      <span className="control-label">
        HOLD TO ANSWER
        <span className="control-letter" aria-hidden="true">
          {letter}
        </span>
      </span>
      {showKey ? (
        <span className="keycap on-hemi" aria-hidden="true">
          SPACE
        </span>
      ) : null}
    </button>
  );
}

export interface PopControlProps {
  ready: boolean;
  disabled: boolean;
  onActivate: () => void;
  showKey?: boolean;
}

/** The ultimate. Dark and quiet until it is genuinely armed. */
export function PopControl({ ready, disabled, onActivate, showKey = true }: PopControlProps) {
  return (
    <button
      type="button"
      className={ready ? "arm-control armed" : "arm-control"}
      disabled={disabled}
      onClick={onActivate}
      aria-label={ready ? "POP OFF ready. Clear every live caller." : "POP OFF charging"}
    >
      POP OFF
      {showKey ? (
        <span className={ready ? "keycap on-hemi" : "keycap"} aria-hidden="true">
          P
        </span>
      ) : null}
    </button>
  );
}
