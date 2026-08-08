"use client";

import type { CSSProperties } from "react";

/**
 * A hardware counter.
 *
 * Each digit is a ten-high strip inside a fixed window that is 1.5em tall, and
 * every glyph is centred in its own 10 % row. A digit therefore has half an em
 * of air above its cap and below its baseline at all times, so no numeral can
 * ever be sliced flat against the top of its cell while the wheel is turning —
 * which is exactly what the old odometer did.
 *
 * Layout is frozen: the cell count comes from `digits`, not from the value, and
 * every cell is exactly 0.66em wide with tabular figures, so a score going from
 * 999 to 1000 does not move a single pixel of anything around it.
 */
export function Odometer({
  value,
  digits = 6,
  label,
  className,
}: {
  value: number;
  /** Fixed number of wheels. The layout never reflows. */
  digits?: number;
  /** Accessible label; the wheels themselves are hidden from assistive tech. */
  label?: string;
  className?: string;
}) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const text = String(safe).padStart(digits, "0");
  const cells = text.split("");
  // Everything left of the first significant digit is held back a stop, the
  // way a real counter reads. It stays legible — measured, not decorative.
  const firstSignificant = Math.max(0, text.length - String(safe).length);

  return (
    <span className={className ? `odometer ${className}` : "odometer"}>
      <span className="sr-only">{label ? `${label}: ${safe}` : String(safe)}</span>
      <span aria-hidden="true" className="odo-wheels">
        {cells.map((character, index) => {
          const digit = Number(character);
          // The units wheel leads and each wheel to its left follows a frame
          // later, so a rolling number reads as a mechanism, not a jump cut.
          const order = cells.length - 1 - index;
          return (
            <span className={index < firstSignificant ? "odo-cell odo-lead" : "odo-cell"} key={index}>
              <span
                className="odo-strip"
                style={{ "--d": digit, "--i": order } as CSSProperties}
              >
                {ROWS.map((row) => (
                  <span key={row}>{row}</span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
