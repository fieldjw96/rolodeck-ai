import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./deck", () => ({
  Deck: () => {
    throw new Error("boom");
  },
}));

import { COMPONENT_ERROR_MESSAGE } from "../../../lib/ui/error-boundary";
import DeckPage from "./page";

afterEach(() => {
  cleanup();
});

describe("DeckPage", () => {
  it("wraps Deck in an error boundary, so a component throw shows a fallback rather than a blank page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<DeckPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      COMPONENT_ERROR_MESSAGE,
    );
  });
});
