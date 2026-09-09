import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPONENT_ERROR_MESSAGE, ErrorBoundary } from "./error-boundary";

function Boom(): never {
  throw new Error("kaboom");
}

afterEach(() => {
  cleanup();
});

describe("ErrorBoundary", () => {
  it("renders a visible fallback instead of a blank page when a child throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      COMPONENT_ERROR_MESSAGE,
    );
  });

  it("renders its children unchanged when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("All good")).toBeInTheDocument();
  });
});
