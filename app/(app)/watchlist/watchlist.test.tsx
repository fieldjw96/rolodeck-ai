import {
  act,
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
  passErrorMessage,
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

/**
 * Answers `pages` at once and holds every Pass POST open until the test settles it by URL
 * with a status — the same shape `deck.test.tsx`'s `stubSwipes` uses, so a test can look at
 * the Watchlist with a write still in flight, or retry it.
 */
function stubPass(pages: Record<string, unknown>) {
  const open: { url: string; settle: (response: Response) => void }[] = [];
  const posted: string[] = [];

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if ((init?.method ?? "GET") === "POST") {
        posted.push(url);
        return new Promise<Response>((settle) => open.push({ url, settle }));
      }

      const body = pages[`GET ${url}`];

      if (body === undefined) {
        throw new Error(`unexpected fetch: GET ${url}`);
      }

      return jsonResponse(body);
    },
  );

  vi.stubGlobal("fetch", fetchMock);

  return {
    posted: () => [...posted],
    pending: () => open.map((request) => request.url),
    answer(url: string, status: number) {
      const at = open.findIndex((request) => request.url === url);

      if (at === -1) {
        throw new Error(`no pending request ${url}`);
      }

      const [request] = open.splice(at, 1);
      request!.settle(
        (status < 400
          ? { ok: true, status, json: async () => ({}) }
          : { ok: false, status }) as Response,
      );
    },
  };
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

    it("offers each row as a real button and opens the full card, with its tabs, a Pass button and no Keep, on a pointer click", async () => {
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
        within(dialog).queryByRole("button", { name: "Keep" }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", { name: "Pass" }),
      ).toBeInTheDocument();
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
      // The last focusable stop in the panel, since the Pass button sits below the card.
      const pass = within(dialog).getByRole("button", { name: "Pass" });

      // Shift+Tab off the first stop wraps to the last; Tab off the last wraps to the first.
      close.focus();
      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      expect(pass).toHaveFocus();

      fireEvent.keyDown(pass, { key: "Tab" });
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

  describe("Passing a Kept Profile from its open card", () => {
    async function openDialog(...profiles: KeptProfile[]) {
      const swipes = stubPass({
        "GET /api/profiles?filter=kept": { profiles },
      });
      render(<Watchlist />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: `Open ${profiles[0]!.name}`,
        }),
      );
      return swipes;
    }

    it("sends POST /api/profiles/:id/pass, closes the Dialog, removes the row and updates the count", async () => {
      const swipes = await openDialog(acme, globex);

      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Pass",
        }),
      );
      expect(swipes.pending()).toEqual([`/api/profiles/${acme.id}/pass`]);

      await act(async () =>
        swipes.answer(`/api/profiles/${acme.id}/pass`, 200),
      );

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Open Acme" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("1 Kept Profile")).toBeInTheDocument();
    });

    it("moves focus to the Watchlist heading once the opener button it would otherwise have returned to is gone", async () => {
      const swipes = await openDialog(acme, globex);

      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Pass",
        }),
      );
      await act(async () =>
        swipes.answer(`/api/profiles/${acme.id}/pass`, 200),
      );

      expect(screen.getByRole("heading", { name: "Watchlist" })).toHaveFocus();
    });

    it("shows the existing empty state when the last Kept Profile is Passed", async () => {
      const swipes = await openDialog(acme);

      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Pass",
        }),
      );
      await act(async () =>
        swipes.answer(`/api/profiles/${acme.id}/pass`, 200),
      );

      expect(
        await screen.findByText(EMPTY_WATCHLIST_MESSAGE),
      ).toBeInTheDocument();
    });

    it("moves focus to the Watchlist heading when Passing the last Kept Profile empties the list", async () => {
      const swipes = await openDialog(acme);

      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Pass",
        }),
      );
      await act(async () =>
        swipes.answer(`/api/profiles/${acme.id}/pass`, 200),
      );

      await screen.findByText(EMPTY_WATCHLIST_MESSAGE);
      expect(screen.getByRole("heading", { name: "Watchlist" })).toHaveFocus();
    });

    it("keeps the Dialog open and the row in place on a failed Pass, names the Profile in an alert, and Retry re-sends the same POST", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const swipes = await openDialog(acme, globex);

      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Pass" }));
      await act(async () =>
        swipes.answer(`/api/profiles/${acme.id}/pass`, 500),
      );

      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        passErrorMessage("Acme"),
      );
      expect(
        screen.getByRole("button", { name: "Open Acme" }),
      ).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
      await act(async () =>
        swipes.answer(`/api/profiles/${acme.id}/pass`, 200),
      );

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(swipes.posted()).toEqual([
        `/api/profiles/${acme.id}/pass`,
        `/api/profiles/${acme.id}/pass`,
      ]);
    });

    it("disables Pass while the request is in flight, so a double click sends exactly one POST", async () => {
      const swipes = await openDialog(acme, globex);

      const pass = within(screen.getByRole("dialog")).getByRole("button", {
        name: "Pass",
      });
      fireEvent.click(pass);
      fireEvent.click(pass);

      expect(swipes.posted()).toEqual([`/api/profiles/${acme.id}/pass`]);

      await act(async () =>
        swipes.answer(`/api/profiles/${acme.id}/pass`, 200),
      );
    });
  });
});
