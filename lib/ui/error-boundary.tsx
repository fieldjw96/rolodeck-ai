"use client";

import { Component, type ReactNode } from "react";

/** Shown in place of whatever threw, so a component throw is a visible message rather than a
 * blank page. Ticket #14 scopes this to a render throw: `Deck` and `Watchlist` already turn a
 * failed fetch into their own explicit error state, and never reach here for that. */
export const COMPONENT_ERROR_MESSAGE = "Something went wrong.";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

/**
 * React has no Hook for catching a child's render throw — only a class component's
 * `getDerivedStateFromError`/`componentDidCatch` does — so this is the one class component in
 * the app. Wraps `/deck` and `/watchlist`, the two routes a component throw would otherwise
 * leave blank.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <p role="alert">{COMPONENT_ERROR_MESSAGE}</p>;
    }

    return this.props.children;
  }
}
