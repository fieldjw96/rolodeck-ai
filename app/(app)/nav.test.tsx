import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

import { usePathname } from "next/navigation";
import { Nav } from "./nav";

const LINKS = ["Deck", "Watchlist", "News", "Settings"] as const;

beforeEach(() => {
  vi.mocked(usePathname).mockReset();
});

afterEach(() => {
  cleanup();
});

/** Which of the nav's links carry `aria-current="page"`, by name. */
function currentLinks(): string[] {
  return LINKS.filter(
    (name) =>
      screen.getByRole("link", { name }).getAttribute("aria-current") ===
      "page",
  );
}

describe("Nav", () => {
  it("links to the Deck, the Watchlist, News and Settings, in that order", () => {
    vi.mocked(usePathname).mockReturnValue("/deck");

    render(<Nav />);

    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(["/deck", "/watchlist", "/news", "/settings"]);
  });

  it("marks the Deck link with aria-current when on the Deck", () => {
    vi.mocked(usePathname).mockReturnValue("/deck");

    render(<Nav />);

    expect(currentLinks()).toEqual(["Deck"]);
  });

  it("marks the Watchlist link with aria-current when on the Watchlist", () => {
    vi.mocked(usePathname).mockReturnValue("/watchlist");

    render(<Nav />);

    expect(currentLinks()).toEqual(["Watchlist"]);
  });

  it("marks the News link with aria-current when on News", () => {
    vi.mocked(usePathname).mockReturnValue("/news");

    render(<Nav />);

    expect(currentLinks()).toEqual(["News"]);
  });

  it("marks the Settings link with aria-current when on Settings", () => {
    vi.mocked(usePathname).mockReturnValue("/settings");

    render(<Nav />);

    expect(currentLinks()).toEqual(["Settings"]);
  });

  it("does not mark any link when on a different route", () => {
    vi.mocked(usePathname).mockReturnValue("/other");

    render(<Nav />);

    expect(currentLinks()).toEqual([]);
  });
});
