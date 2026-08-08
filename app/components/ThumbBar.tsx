"use client";

import { AnswerControl, PopControl } from "./Controls";

/**
 * The mobile control bar.
 *
 * Pinned to the bottom edge inside the safe area, which is the only part of a
 * phone a thumb reaches without regripping. It is rendered on every viewport
 * but `display: none` above 760 px, so it is not in the tab order or the
 * accessibility tree on desktop, where the rack carries the same two controls.
 */
export function ThumbBar({
  live,
  nextLetter,
  charged,
  onAnswerDown,
  onAnswerUp,
  onPopOff,
}: {
  live: boolean;
  nextLetter: string;
  charged: boolean;
  onAnswerDown: () => void;
  onAnswerUp: () => void;
  onPopOff: () => void;
}) {
  return (
    <div className="thumb-bar">
      <AnswerControl
        letter={nextLetter}
        disabled={!live}
        onDown={onAnswerDown}
        onUp={onAnswerUp}
        showKey={false}
      />
      <PopControl
        ready={live && charged}
        disabled={!live || !charged}
        onActivate={onPopOff}
        showKey={false}
      />
    </div>
  );
}
