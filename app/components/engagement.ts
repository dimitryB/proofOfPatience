"use client";

/**
 * Has a human actually touched this page yet?
 *
 * The shell moves focus at two moments — when the segment goes live and when a
 * result screen replaces the field — because letting focus fall on the body
 * strands a keyboard player. Both moves are gated on this flag, so a harness
 * that drives the game through the QA bridge (no pointer, no key) never has
 * focus taken from it, and a capture of the settled screen shows the screen
 * rather than a focus ring around whatever was last mounted.
 */
let engaged = false;

export function isEngaged(): boolean {
  return engaged;
}

/** Installs one-shot listeners. Safe to call from several components. */
export function watchEngagement(): () => void {
  if (engaged) return () => {};
  const mark = () => {
    engaged = true;
  };
  window.addEventListener("keydown", mark, { once: true, capture: true });
  window.addEventListener("pointerdown", mark, { once: true, capture: true });
  return () => {
    window.removeEventListener("keydown", mark, true);
    window.removeEventListener("pointerdown", mark, true);
  };
}
