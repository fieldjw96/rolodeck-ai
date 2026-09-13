import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

import { usePathname } from "next/navigation";
import { Nav } from "./nav";

const LINKS = [
  ["Deck", "/deck"],
  ["Watchlist", "/watchlist"],
  ["News", "/news"],
  ["Diary", "/diary"],
] as const;

beforeEach(() => {
  vi.mocked(usePathname).mockReset();
});

afterEach(() => {
  cleanup();
});

/** Which of the nav's links carry `aria-current="page"`, by name. */
function currentLinks(): string[] {
  return LINKS.map(([name]) => name).filter(
    (name) =>
      screen.getByRole("link", { name }).getAttribute("aria-current") ===
      "page",
  );
}

describe("Nav", () => {
  it("links to the Deck, the Watchlist, News and the Diary, in that order", () => {
    vi.mocked(usePathname).mockReturnValue("/deck");

    render(<Nav />);

    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(LINKS.map(([, path]) => path));
  });

  it.each(LINKS)(
    "marks only the %s link with aria-current when on %s",
    (current, path) => {
      vi.mocked(usePathname).mockReturnValue(path);

      render(<Nav />);

      expect(currentLinks()).toEqual([current]);
    },
  );

  it("links each entry to its own route", () => {
    vi.mocked(usePathname).mockReturnValue("/deck");

    render(<Nav />);

    for (const [name, path] of LINKS) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", path);
    }
  });

  it("does not mark any link when on a different route", () => {
    vi.mocked(usePathname).mockReturnValue("/other");

    render(<Nav />);

    expect(currentLinks()).toEqual([]);
  });
});
