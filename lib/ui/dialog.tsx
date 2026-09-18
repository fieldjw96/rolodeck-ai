"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import styles from "./dialog.module.css";

type DialogProps = {
  /** The dialog's accessible name. Required: a dialog with no name is announced as nothing. */
  label: string;
  /** Called for Escape, the close button and a click on the backdrop. The caller owns whether
   * the dialog is mounted, so closing is always the caller unmounting it. */
  onClose: () => void;
  children: ReactNode;
};

const FOCUSABLE =
  ':is(a[href], button, input, select, textarea, [tabindex]):not([disabled], [tabindex="-1"])';

/**
 * A modal dialog, and knows nothing about what it holds. Mounting it opens it: focus moves in,
 * Tab and Shift+Tab wrap inside it, Escape closes it, the page behind stops scrolling, and
 * unmounting returns focus to whatever had it before and restores the page's scroll.
 *
 * Rendered into `document.body` so no ancestor's overflow or stacking context can clip it.
 */
export function Dialog({ label, onClose, children }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Latest `onClose` without re-running the mount effect, which must run once: re-running it
  // would steal focus back to the close button and record the wrong element to return to.
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const { overflow } = document.body.style;

    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => {
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close.current();
      return;
    }

    if (event.key !== "Tab" || panel.current === null) {
      return;
    }

    // Hidden tab panels still hold links; only what can actually take focus is a stop.
    const stops = [
      ...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ].filter((stop) => stop.closest("[hidden]") === null);
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;

    if (first === undefined || last === undefined) {
      event.preventDefault();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className={styles.backdrop}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close.current();
        }
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={styles.panel}
      >
        <button
          type="button"
          className={styles.close}
          onClick={() => close.current()}
        >
          Close
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
