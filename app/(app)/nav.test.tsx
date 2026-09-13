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
  ["Diary", "/diary"],
] as const;

beforeEach(() => {
  vi.mocked(usePathname).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("Nav", () => {
  it.each(LINKS)(
    "marks only the %s link with aria-current when on %s",
    (current, path) => {
      vi.mocked(usePathname).mockReturnValue(path);

      render(<Nav />);

      for (const [name] of LINKS) {
        const link = screen.getByRole("link", { name });

        if (name === current) {
          expect(link).toHaveAttribute("aria-current", "page");
        } else {
          expect(link).not.toHaveAttribute("aria-current");
        }
      }
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

    for (const [name] of LINKS) {
      expect(screen.getByRole("link", { name })).not.toHaveAttribute(
        "aria-current",
      );
    }
  });
});
