import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_WATCHLIST_MESSAGE,
  LOAD_ERROR_MESSAGE,
  Watchlist,
} from "./watchlist";

type KeptProfile = {
  id: string;
  name: string;
  sector: string;
  stage: string;
  location: string | null;
};

const acme: KeptProfile = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Acme",
  sector: "Hardware",
  stage: "Seed",
  location: "San Francisco, CA",
};

const globex: KeptProfile = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Globex",
  sector: "Logistics",
  stage: "Series A",
  location: null,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Watchlist", () => {
  it("lists every Kept Profile's name, sector and stage, fetched from GET /api/profiles?filter=kept", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ profiles: [acme, globex], next_cursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Watchlist />);

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Hardware")).toBeInTheDocument();
    expect(screen.getByText("Seed")).toBeInTheDocument();
    expect(screen.getByText("Globex")).toBeInTheDocument();
    expect(screen.getByText("Logistics")).toBeInTheDocument();
    expect(screen.getByText("Series A")).toBeInTheDocument();
    expect(screen.getByText("San Francisco, CA")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/profiles?filter=kept");
  });

  it("shows an explicit empty state when nothing has been Kept, rather than a blank screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ profiles: [], next_cursor: null })),
    );

    render(<Watchlist />);

    expect(
      await screen.findByText(EMPTY_WATCHLIST_MESSAGE),
    ).toBeInTheDocument();
  });

  it("shows an explicit error when the fetch fails, rather than staying on loading forever", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );

    render(<Watchlist />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_ERROR_MESSAGE,
    );
  });

  describe("opening a row", () => {
    const detailed = {
      ...acme,
      description: "Acme builds rockets. It also builds anvils.",
      website: "https://acme.example",
      founders: [{ name: "Wile Coyote", role: "CEO" }],
      links: null,
    };

    async function renderReady() {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ profiles: [detailed, globex], next_cursor: null }),
        ),
      );
      render(<Watchlist />);
      return screen.findByRole("button", { name: "Open Acme" });
    }

    it("offers each row as a real button and opens the full card, with its tabs and no Keep or Pass, on a pointer click", async () => {
      const row = await renderReady();

      expect(row.tagName).toBe("BUTTON");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      fireEvent.click(row);

      const dialog = screen.getByRole("dialog", { name: "Acme" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(
        within(dialog)
          .getAllByRole("tab")
          .map((tab) => tab.textContent),
      ).toEqual(["Company", "Team", "Contact"]);
      expect(
        within(dialog).queryByRole("button", { name: /keep|pass/i }),
      ).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("opens from the keyboard: the row is focusable, and Enter on a button is a click", async () => {
      const row = await renderReady();

      row.focus();
      expect(row).toHaveFocus();
      // Browsers turn Enter and Space on a focused button into a click; jsdom does not, so the
      // click is dispatched here and the guarantee under test is that the row is a button.
      fireEvent.keyDown(row, { key: "Enter" });
      fireEvent.click(row);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });

    it("keeps Tab inside the dialog", async () => {
      fireEvent.click(await renderReady());
      const dialog = screen.getByRole("dialog");
      const close = within(dialog).getByRole("button", { name: "Close" });

      const selectedTab = within(dialog).getByRole("tab", { selected: true });

      // Shift+Tab off the first stop wraps to the last; Tab off the last wraps to the first.
      close.focus();
      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      expect(selectedTab).toHaveFocus();

      fireEvent.keyDown(selectedTab, { key: "Tab" });
      expect(close).toHaveFocus();
    });

    it("closes on Escape, returns focus to the row that opened it and lets the page scroll again", async () => {
      const row = await renderReady();
      row.focus();
      fireEvent.click(row);

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(row).toHaveFocus();
      expect(document.body.style.overflow).toBe("");
    });

    it("closes from its Close button", async () => {
      fireEvent.click(await renderReady());
      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("changes nothing about the Kept list by opening a card", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ profiles: [detailed, globex], next_cursor: null }),
      );
      vi.stubGlobal("fetch", fetchMock);
      render(<Watchlist />);
      fireEvent.click(await screen.findByRole("button", { name: "Open Acme" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
