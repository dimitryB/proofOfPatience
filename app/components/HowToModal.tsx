"use client";

import { MAX_BACKLOG } from "../../lib/pop";
import { useDialogFocusTrap } from "./focusTrap";

/**
 * The producer's brief.
 *
 * Four drills, each of which *shows* the mechanic on a demonstration plate and
 * then labels it in one line. Nobody reads a paragraph on a title screen.
 *
 * Focus is trapped for real — see `useDialogFocusTrap`, which the audio desk
 * shares: the dialog takes focus on open, Tab and Shift+Tab cycle inside it,
 * Escape and the scrim close it, and focus goes back to whatever opened it.
 */
export function HowToModal({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogFocusTrap(onClose);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="how-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="brief-title"
        aria-describedby="brief-lede"
        ref={dialogRef}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        /* Space activates the focused button; the shell's window handler
           would otherwise preventDefault it and fire a letter instead. */
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <button type="button" className="modal-close" aria-label="Close the producer brief" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>

        <div className="modal-head">
          <p className="k-kicker">MWM PRODUCER BRIEF</p>
          <h2 id="brief-title">HOW TO PROVE PATIENCE</h2>
          <p id="brief-lede" className="k-body">
            Four things happen on this desk. Watch each one, then go live.
          </p>
        </div>

        <div className="drill-grid">
          <section className="drill">
            <div className="drill-plate" aria-hidden="true">
              <span className="demo-card" />
              <span className="demo-lock" />
              <span className="demo-beam" />
              <span className="demo-mic" />
            </div>
            <div className="drill-head">
              <span className="step" aria-hidden="true">
                1
              </span>
              <h3>Point at a caller</h3>
            </div>
            <p>Drag on the field, or hold A and D. The bracket marks the caller you will hit.</p>
          </section>

          <section className="drill">
            <div className="drill-plate" aria-hidden="true">
              <span className="demo-rack">
                <span className="spent">S</span>
                <span className="live">O</span>
                <span>O</span>
                <span>N</span>
              </span>
            </div>
            <div className="drill-head">
              <span className="step" aria-hidden="true">
                2
              </span>
              <h3>Hold to answer</h3>
            </div>
            <p>The rack advances S · O · O · N on its own. Hold click, touch or Space.</p>
          </section>

          <section className="drill">
            <div className="drill-plate" aria-hidden="true">
              <span className="demo-queue">
                {Array.from({ length: MAX_BACKLOG }).map((_, index) => (
                  <i
                    key={index}
                    className={
                      index < MAX_BACKLOG - 2
                        ? "lit"
                        : index === MAX_BACKLOG - 2
                          ? "end"
                          : undefined
                    }
                  />
                ))}
              </span>
            </div>
            <div className="drill-head">
              <span className="step" aria-hidden="true">
                3
              </span>
              <h3>Watch the backlog</h3>
            </div>
            <p>
              Every caller that reaches the desk fills a slot. {MAX_BACKLOG} full slots end the
              show.
            </p>
          </section>

          <section className="drill">
            <div className="drill-plate" aria-hidden="true">
              <span className="demo-gauge">
                <span className="track">
                  <b />
                </span>
                <span className="cards">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            </div>
            <div className="drill-head">
              <span className="step" aria-hidden="true">
                P
              </span>
              <h3>POP off at 100 %</h3>
            </div>
            <p>A full POP-o-meter moves every caller on the board to next week at once.</p>
          </section>
        </div>

        <div className="modal-foot">
          <div className="key-legend">
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
            <span>
              RESTART
              <b className="keycap">R</b>
            </span>
          </div>
          <button type="button" className="primary-control" onClick={onClose}>
            <span className="control-label">UNDERSTOOD</span>
            <span className="keycap on-hemi" aria-hidden="true">
              ESC
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
