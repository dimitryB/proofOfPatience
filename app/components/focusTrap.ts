"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus containment, shared by every dialog in the shell.
 *
 * The dialog element itself takes focus on open — not its first control — so a
 * screen reader announces the title and the lede before any button, and the
 * first Tab lands on something useful rather than opening a ring on a dismiss
 * action. Tab and Shift+Tab then cycle inside, Escape closes, and focus goes
 * back to whatever opened the dialog.
 *
 * Returns the ref to put on the dialog element. That element must carry
 * `tabIndex={-1}` so it can hold focus without joining the tab order.
 */
export function useDialogFocusTrap(onClose: () => void): RefObject<HTMLDivElement | null> {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  /**
   * The close callback is almost always an inline arrow, so its identity
   * changes on every render of the owner. Held in a ref and read at call time
   * so it can stay out of the effect's dependencies: if it were a dependency,
   * every re-render would tear the trap down — restoring focus to whatever
   * opened the dialog — and immediately set it up again, pulling focus onto
   * the dialog container. A player who toggles a control inside a live dialog
   * would lose their place in the tab order on every single press.
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const focusables = useCallback(() => {
    const root = dialogRef.current;
    if (!root) return [] as HTMLElement[];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
  }, []);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The shell binds gameplay keys on window; a dialog must swallow its
        // own Escape rather than let it reach the round underneath.
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      // The dialog container itself counts as "before the first control", so a
      // Shift+Tab from the freshly-opened dialog wraps to the last control
      // instead of stepping out into the page behind.
      const atStart = active === first || active === dialogRef.current;
      if (event.shiftKey && (atStart || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus({ preventScroll: true });
    };
  }, [focusables]);

  return dialogRef;
}
