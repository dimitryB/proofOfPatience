"use client";

/**
 * The header rail. It identifies the product and carries the global controls;
 * it prints no live game value, because the canvas already prints every one of
 * them inside the picture.
 *
 * Two audio controls sit here, and they are deliberately different jobs. SOUND
 * is the master mute: one press, everything stops, which is what a player
 * reaches for when someone walks into the room. MIX opens the audio desk,
 * where music, effects and the audience are switched and levelled separately.
 * Only SOUND kills everything, so there is exactly one fast way to do it.
 *
 * HOW TO PLAY is deliberately the first button in the header — the visual-QA
 * harness opens the brief with `header button:first-of-type`.
 */
export function ShowHeader({
  muted,
  mixOpen,
  onOpenBrief,
  onOpenMix,
  onToggleSound,
}: {
  muted: boolean;
  /** Drives `aria-expanded`, so the button reports the dialog it controls. */
  mixOpen: boolean;
  onOpenBrief: () => void;
  onOpenMix: () => void;
  onToggleSound: () => void;
}) {
  return (
    <header className="show-header">
      <div className="pop-mark">
        <span className="mark-plate" aria-hidden="true">
          POP
        </span>
        <span className="mark-legend">
          {/* The lockup stacks the two words, so the accessible name and the
              server-rendered HTML both need the brand as one contiguous run. */}
          <span className="sr-only">PROOF OF PATIENCE, trademark</span>
          <b aria-hidden="true">PROOF OF</b>
          <span aria-hidden="true">PATIENCE™</span>
        </span>
      </div>

      <div className="show-id">
        <p className="show-eyebrow">MIDWEEK WITH MAX &middot; STAGE THREE</p>
        <h1>
          {/* Its own element so it can be the thing that truncates: the h1 is a
              flex row (title + LIVE chip), and bare text in a flex container
              overflows without an ellipsis. */}
          <span className="show-title">COMMUNITY TAKEOVER</span>
          <span className="live-chip">
            <i aria-hidden="true" />
            LIVE
          </span>
        </h1>
      </div>

      <div className="header-actions">
        <button type="button" className="ghost-button" onClick={onOpenBrief}>
          HOW TO PLAY
        </button>
        <button
          type="button"
          className="ghost-button mix-button"
          onClick={onOpenMix}
          aria-haspopup="dialog"
          aria-expanded={mixOpen}
          /* the word "MIX" is hidden on a phone, so the name is carried here
             as well as in the label span */
          aria-label="Open the audio desk. Music, sound effects and audience."
        >
          <i className="fader-glyph" aria-hidden="true">
            <b />
            <b />
            <b />
          </i>
          <span className="label">MIX</span>
        </button>
        <button
          type="button"
          className="ghost-button sound-button"
          onClick={onToggleSound}
          aria-pressed={!muted}
          /* the word "SOUND" is hidden on a phone, so the name is carried
             here as well as in the label span */
          aria-label={muted ? "Sound off. Turn sound on." : "Sound on. Turn sound off."}
        >
          <i className={muted ? "lamp off" : "lamp"} aria-hidden="true" />
          <span className="label">SOUND</span>
          <span className="state">{muted ? "OFF" : "ON"}</span>
        </button>
        <span className="build-tag">
          <i aria-hidden="true" />
          LOCAL BUILD
        </span>
      </div>
    </header>
  );
}
