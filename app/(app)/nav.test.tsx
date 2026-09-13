import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

import { usePathname } from "next/navigation";
import { Nav } from "./nav";

beforeEach(() => {
  vi.mocked(usePathname).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("Nav", () => {
  it("marks the Deck link with aria-current when on the Deck", () => {
    vi.mocked(usePathname).mockReturnValue("/deck");

    render(<Nav />);

    const deckLink = screen.getByRole("link", { name: "Deck" });
    const watchlistLink = screen.getByRole("link", { name: "Watchlist" });
    const settingsLink = screen.getByRole("link", { name: "Settings" });

    expect(deckLink).toHaveAttribute("aria-current", "page");
    expect(watchlistLink).not.toHaveAttribute("aria-current");
    expect(settingsLink).not.toHaveAttribute("aria-current");
  });

  it("marks the Watchlist link with aria-current when on the Watchlist", () => {
    vi.mocked(usePathname).mockReturnValue("/watchlist");

    render(<Nav />);

    const deckLink = screen.getByRole("link", { name: "Deck" });
    const watchlistLink = screen.getByRole("link", { name: "Watchlist" });
    const settingsLink = screen.getByRole("link", { name: "Settings" });

    expect(watchlistLink).toHaveAttribute("aria-current", "page");
    expect(deckLink).not.toHaveAttribute("aria-current");
    expect(settingsLink).not.toHaveAttribute("aria-current");
  });

  it("marks the Settings link with aria-current when on Settings", () => {
    vi.mocked(usePathname).mockReturnValue("/settings");

    render(<Nav />);

    const deckLink = screen.getByRole("link", { name: "Deck" });
    const watchlistLink = screen.getByRole("link", { name: "Watchlist" });
    const settingsLink = screen.getByRole("link", { name: "Settings" });

    expect(settingsLink).toHaveAttribute("aria-current", "page");
    expect(deckLink).not.toHaveAttribute("aria-current");
    expect(watchlistLink).not.toHaveAttribute("aria-current");
  });

  it("does not mark any link when on a different route", () => {
    vi.mocked(usePathname).mockReturnValue("/other");

    render(<Nav />);

    const deckLink = screen.getByRole("link", { name: "Deck" });
    const watchlistLink = screen.getByRole("link", { name: "Watchlist" });
    const settingsLink = screen.getByRole("link", { name: "Settings" });

    expect(deckLink).not.toHaveAttribute("aria-current");
    expect(watchlistLink).not.toHaveAttribute("aria-current");
    expect(settingsLink).not.toHaveAttribute("aria-current");
  });
});
