import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADVANCE_ERROR_MESSAGE,
  Deck,
  EMPTY_DECK_MESSAGE,
  LOAD_ERROR_MESSAGE,
  LOADING_DECK_MESSAGE,
  PREFETCH_AT_REMAINING,
  SWIPE_COMMIT_FRACTION,
  undoErrorMessage,
  undoLabel,
  unsavedMessage,
} from "./deck";

type Profile = {
  id: string;
  name: string;
  description: string;
  sector: string;
  stage: string;
  location: string | null;
};

const acme: Profile = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Acme",
  description: "Widgets, but faster.",
  sector: "Hardware",
  stage: "Seed",
  location: "San Francisco, CA",
};

const globex: Profile = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Globex",
  description: "Logistics for the last mile.",
  sector: "Logistics",
  stage: "Series A",
  location: null,
};

const initech: Profile = {
  id: "33333333-3333-3333-3333-333333333333",
  name: "Initech",
  description: "Reports, with cover sheets.",
  sector: "SaaS",
  stage: "Seed",
  location: null,
};

const hooli: Profile = {
  id: "44444444-4444-4444-4444-444444444444",
  name: "Hooli",
  description: "Making the world a better place.",
  sector: "Consumer",
  stage: "Growth",
  location: null,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

/** Every request `Deck` makes, keyed by method and URL, so a test only has to say what a
 * particular call answers rather than reproduce the whole fetch signature. */
function stubFetch(answers: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const key = `${method} ${url}`;
      const body = answers[key];

      if (body === undefined) {
        throw new Error(`unexpected fetch: ${key}`);
      }

      return jsonResponse(body);
    },
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

/**
 * Answers GETs from `pages` at once, except those whose URL is in `held`, and holds every
 * write — a swipe's POST, an Undo's DELETE — open until the test answers it by URL with a
 * status. That is what lets a test look at the Deck with a write still in flight, or finish
 * writes in whatever order it likes. By URL rather than by method, which is unambiguous: the
 * two kinds of write are at `/keep`, `/pass` and `/swipe`.
 */
function stubSwipes(pages: Record<string, unknown>, held: string[] = []) {
  const open: { url: string; settle: (response: Response) => void }[] = [];
  const posted: string[] = [];
  const fetched: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if ((init?.method ?? "GET") !== "GET") {
        posted.push(url);
        return new Promise<Response>((settle) => open.push({ url, settle }));
      }

      fetched.push(url);
      const body = pages[`GET ${url}`];

      if (body === undefined) {
        throw new Error(`unexpected fetch: GET ${url}`);
      }

      if (held.includes(url)) {
        return new Promise<Response>((settle) =>
          open.push({ url, settle: () => settle(jsonResponse(body)) }),
        );
      }

      return jsonResponse(body);
    }),
  );

  return {
    posted: () => [...posted],
    fetched: () => [...fetched],
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

/**
 * Resolves in the microtask straight after React commits its next change to `container` —
 * which is before the passive effects of that commit have run, because React schedules those
 * as a separate task. That gap is a real one in a browser: it is the moment a Profile is on
 * screen with live buttons and the component's own effects have not caught up yet. Waiting
 * this way rather than with `findBy` is what makes the test below land in it every time.
 */
function nextPaint(container: Element): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });

    observer.observe(container, { childList: true, subtree: true });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Deck", () => {
  it("renders the current Profile fetched from GET /api/profiles", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme], next_cursor: null },
    });

    render(<Deck />);

    expect(
      await screen.findByRole("heading", { name: "Acme" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Widgets, but faster.")).toBeInTheDocument();
    expect(screen.getByText("Hardware")).toBeInTheDocument();
    expect(screen.getByText("Seed")).toBeInTheDocument();
    expect(screen.getByText("San Francisco, CA")).toBeInTheDocument();
  });

  it("renders no Location field for a Profile whose location is unknown", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Globex" });

    expect(screen.queryByText("Location")).not.toBeInTheDocument();
  });

  it("shows a designed loading state while the first page is in flight, rather than nothing at all", async () => {
    // Never resolves: the Deck stays in the state this test is about for as long as it takes.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(<Deck />);

    expect(await screen.findByText(LOADING_DECK_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("shows an explicit error when the initial fetch fails, rather than staying on loading forever", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );

    render(<Deck />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_ERROR_MESSAGE,
    );
  });

  it("Keeps the current Profile and advances to the next one in the page", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [acme, globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/keep`]: {
        profile_id: acme.id,
        decision: "keep",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/keep`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("Passes the current Profile and advances to the next one in the page", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [acme, globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/pass`]: {
        profile_id: acme.id,
        decision: "pass",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Pass" }));

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/pass`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("treats the left arrow key as Pass", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [acme, globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/pass`]: {
        profile_id: acme.id,
        decision: "pass",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.keyDown(window, { key: "ArrowLeft" });

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/pass`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("treats the right arrow key as Keep", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [acme, globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/keep`]: {
        profile_id: acme.id,
        decision: "keep",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/keep`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores keys other than the left and right arrows", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [acme, globex],
        next_cursor: null,
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows an explicit empty state when the Deck starts out empty", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [], next_cursor: null },
    });

    render(<Deck />);

    expect(await screen.findByText(EMPTY_DECK_MESSAGE)).toBeInTheDocument();
  });

  it("shows the empty state once the last Profile in the page is decided and next_cursor is exhausted", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme], next_cursor: null },
      [`POST /api/profiles/${acme.id}/keep`]: {
        profile_id: acme.id,
        decision: "keep",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    expect(await screen.findByText(EMPTY_DECK_MESSAGE)).toBeInTheDocument();
  });

  it("fetches the next page by its cursor once the current page is exhausted", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme], next_cursor: "cursor-1" },
      "GET /api/profiles?cursor=cursor-1": {
        profiles: [globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/keep`]: {
        profile_id: acme.id,
        decision: "keep",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
  });

  it("shows an explicit error when a Keep or Pass records but fetching the next page fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";

        if (method === "GET" && url === "/api/profiles") {
          return jsonResponse({ profiles: [acme], next_cursor: "cursor-1" });
        }

        if (method === "POST" && url === `/api/profiles/${acme.id}/keep`) {
          return jsonResponse({
            profile_id: acme.id,
            decision: "keep",
            decided_at: new Date().toISOString(),
          });
        }

        return { ok: false, status: 500 } as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      ADVANCE_ERROR_MESSAGE,
    );
  });

  it("shows the next Profile the instant Keep is clicked, before the swipe has been recorded", async () => {
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    // Synchronously, with the POST still unanswered: nothing on the network sits between
    // the click and the next card.
    expect(swipes.pending()).toEqual([`/api/profiles/${acme.id}/keep`]);
    expect(screen.getByRole("heading", { name: "Globex" })).toBeInTheDocument();
  });

  it("shows the next Profile the instant an arrow key decides, before the swipe has been recorded", async () => {
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.keyDown(window, { key: "ArrowLeft" });

    expect(swipes.pending()).toEqual([`/api/profiles/${acme.id}/pass`]);
    expect(screen.getByRole("heading", { name: "Globex" })).toBeInTheDocument();
  });

  it("names the company and decision of a swipe that failed to save, without going back to it, and retries it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await act(async () => swipes.answer(`/api/profiles/${acme.id}/keep`, 500));

    expect(screen.getByRole("alert")).toHaveTextContent(
      unsavedMessage("Acme", "keep"),
    );
    // The reader stays where they had moved on to.
    expect(screen.getByRole("heading", { name: "Globex" })).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Retry Keep on Acme" });
    fireEvent.click(retry);
    fireEvent.click(retry);

    // A retry clicked twice is still one write.
    expect(swipes.pending()).toEqual([`/api/profiles/${acme.id}/keep`]);

    await act(async () => swipes.answer(`/api/profiles/${acme.id}/keep`, 200));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(swipes.posted()).toEqual([
      `/api/profiles/${acme.id}/keep`,
      `/api/profiles/${acme.id}/keep`,
    ]);
  });

  it("keeps a failed swipe on screen after the Deck runs out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    expect(screen.getByText(EMPTY_DECK_MESSAGE)).toBeInTheDocument();

    await act(async () => swipes.answer(`/api/profiles/${acme.id}/pass`, 500));

    expect(screen.getByRole("alert")).toHaveTextContent(
      unsavedMessage("Acme", "pass"),
    );
  });

  it("records three swipes in rapid succession as three distinct decisions, each exactly once", async () => {
    const swipes = stubSwipes({
      "GET /api/profiles": {
        profiles: [acme, globex, initech, hooli],
        next_cursor: null,
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    // Faster than any write can come back, and than React can re-render between them for
    // the second click on the same button.
    const keep = screen.getByRole("button", { name: "Keep" });
    fireEvent.click(keep);
    fireEvent.click(keep);
    fireEvent.keyDown(window, { key: "ArrowLeft" });

    expect(screen.getByRole("heading", { name: "Hooli" })).toBeInTheDocument();
    expect(swipes.posted()).toEqual([
      `/api/profiles/${acme.id}/keep`,
      `/api/profiles/${globex.id}/keep`,
      `/api/profiles/${initech.id}/pass`,
    ]);

    // Completing out of order changes nothing about which Profile each was recorded against.
    await act(async () => {
      swipes.answer(`/api/profiles/${initech.id}/pass`, 200);
      swipes.answer(`/api/profiles/${acme.id}/keep`, 200);
      swipes.answer(`/api/profiles/${globex.id}/keep`, 200);
    });

    expect(swipes.posted()).toHaveLength(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fetches the next page ahead of need, so a swipe across the page boundary does not wait", async () => {
    const swipes = stubSwipes({
      "GET /api/profiles": {
        profiles: [acme, globex],
        next_cursor: "cursor-1",
      },
      "GET /api/profiles?cursor=cursor-1": {
        profiles: [initech],
        next_cursor: null,
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    // Two in hand is under `PREFETCH_AT_REMAINING`, so the next page is fetched as soon as
    // the first one is dealt, before any decision.
    expect(PREFETCH_AT_REMAINING).toBeGreaterThanOrEqual(2);
    await waitFor(() =>
      expect(swipes.fetched()).toContain("/api/profiles?cursor=cursor-1"),
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    // Across the boundary, synchronously.
    expect(
      screen.getByRole("heading", { name: "Initech" }),
    ).toBeInTheDocument();
  });

  it("does not prefetch while more than PREFETCH_AT_REMAINING Profiles are in hand", async () => {
    const page = Array.from({ length: PREFETCH_AT_REMAINING + 2 }, (_, i) => ({
      ...acme,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      name: `Company ${i}`,
    }));

    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: page, next_cursor: "cursor-1" },
      "GET /api/profiles?cursor=cursor-1": { profiles: [], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Company 0" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await act(async () => {});

    expect(swipes.fetched()).not.toContain("/api/profiles?cursor=cursor-1");

    fireEvent.click(screen.getByRole("button", { name: "Pass" }));

    await waitFor(() =>
      expect(swipes.fetched()).toContain("/api/profiles?cursor=cursor-1"),
    );
  });

  it("never deals a decided Profile again, even if a page fetched while its write was in flight carries it", async () => {
    const swipes = stubSwipes(
      {
        "GET /api/profiles": { profiles: [acme], next_cursor: "cursor-1" },
        "GET /api/profiles?cursor=cursor-1": {
          profiles: [acme, globex],
          next_cursor: null,
        },
      },
      ["/api/profiles?cursor=cursor-1"],
    );

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    // Out of Profiles with the next page not yet in: the one wait left, and a rare one.
    expect(screen.getByText(LOADING_DECK_MESSAGE)).toBeInTheDocument();
    // The page was read before Acme's swipe landed, so the server still dealt Acme in it.
    await waitFor(() =>
      expect(swipes.pending()).toContain("/api/profiles?cursor=cursor-1"),
    );
    await act(async () => swipes.answer("/api/profiles?cursor=cursor-1", 200));

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    expect(screen.getByText(EMPTY_DECK_MESSAGE)).toBeInTheDocument();
    expect(swipes.posted()).toEqual([
      `/api/profiles/${acme.id}/keep`,
      `/api/profiles/${globex.id}/keep`,
    ]);
  });

  it("takes a Keep clicked the instant the first Profile appears, before its effects have run", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [acme, globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/keep`]: {
        profile_id: acme.id,
        decision: "keep",
        decided_at: new Date().toISOString(),
      },
    });

    const { container } = render(<Deck />);

    await nextPaint(container);

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    // A decision read from a `stateRef` the render had not caught up with was dropped on the
    // floor: no request, no advance, and nothing on screen to say the click had happened.
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/keep`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
  });

  it("tells Keep and Pass apart by text, not colour alone", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme], next_cursor: null },
    });

    render(<Deck />);

    const pass = await screen.findByRole("button", { name: "Pass" });
    const keep = screen.getByRole("button", { name: "Keep" });

    // Ticket #12: a screen reader announces these distinctly, and the check is at the level
    // of rendered content rather than of the colour each is styled with.
    expect(pass.textContent).toContain("Pass");
    expect(keep.textContent).toContain("Keep");
    expect(pass.textContent).not.toBe(keep.textContent);
  });

  it("throws the decided card off as a copy nothing can read, focus or click, then removes it", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
      [`POST /api/profiles/${acme.id}/keep`]: {},
    });
    // jsdom has no `matchMedia`, which the Deck reads as "no motion"; a browser that allows it.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
    }));

    const { container } = render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    // The Deck has already moved on: the only card anything can reach is the next one.
    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Acme" })).toBeNull();

    const copy = container.querySelector('[aria-hidden="true"][inert]');
    expect(copy?.textContent).toContain("Acme");

    // React listens for `webkitAnimationEnd` where `AnimationEvent` is missing, as it is in
    // jsdom, and for `animationend` in a browser. Both are fired so this passes in either.
    act(() => {
      fireEvent.animationEnd(copy!);
      copy!.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
    });

    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("decides without a flying copy when the reader prefers reduced motion", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
      [`POST /api/profiles/${acme.id}/keep`]: {},
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
    }));

    const { container } = render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await screen.findByRole("heading", { name: "Globex" });

    expect(container.querySelector("[inert]")).toBeNull();
  });
});

/**
 * Ticket #272. A Pass commits on a quarter of the card's width, so one can happen by accident
 * and nothing in the app listed them or took one back. What these pin is that the decision
 * just made can be taken back, that it is the only one that can be, and that an Undo the
 * server refused leaves the decision standing rather than dealing a card the Deck has lost.
 */
describe("undoing the decision just made", () => {
  /** The Undo control by the accessible name the Deck gives it, which names the company. */
  const undoOf = (profile: Profile, decision: "keep" | "pass") =>
    screen.getByRole("button", {
      name: undoLabel(profile.name, decision),
    });

  it("offers no Undo until a decision has been made", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("puts the card back on top after a Pass, without refetching the page", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
      [`POST /api/profiles/${acme.id}/pass`]: {},
      [`DELETE /api/profiles/${acme.id}/swipe`]: {},
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await screen.findByRole("heading", { name: "Globex" });

    const undo = undoOf(acme, "pass");
    // A real button, so it is in the tab order and answers Enter and Space on its own.
    expect(undo.tagName).toBe("BUTTON");
    expect(undo).not.toHaveAttribute("tabindex");

    await act(async () => {
      fireEvent.click(undo);
    });

    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/swipe`,
      expect.objectContaining({ method: "DELETE" }),
    );
    // The card came from the hand the Deck was already holding: one GET, the first one.
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/profiles"),
    ).toHaveLength(1);
    // Spent: there is no decision left to take back.
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("deals the Profile again, and takes a second decision about it", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
      [`POST /api/profiles/${acme.id}/pass`]: {},
      [`POST /api/profiles/${acme.id}/keep`]: {},
      [`DELETE /api/profiles/${acme.id}/swipe`]: {},
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await screen.findByRole("heading", { name: "Globex" });
    await act(async () => {
      fireEvent.click(undoOf(acme, "pass"));
    });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/keep`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  // Undoing a Keep is what takes the company back off the Watchlist, because the Watchlist is
  // the reader's Keeps and this deletes the row that was one. `db/deck.test.ts` asserts that
  // half against Postgres; what the Deck owes is the DELETE.
  it("sends the DELETE that takes a Kept company back off the Watchlist", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
      [`POST /api/profiles/${acme.id}/keep`]: {},
      [`DELETE /api/profiles/${acme.id}/swipe`]: {},
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await screen.findByRole("heading", { name: "Globex" });

    await act(async () => {
      fireEvent.click(undoOf(acme, "keep"));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/swipe`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
  });

  it("offers an Undo of the most recent decision only", async () => {
    stubFetch({
      "GET /api/profiles": {
        profiles: [acme, globex, initech],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/pass`]: {},
      [`POST /api/profiles/${globex.id}/keep`]: {},
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await screen.findByRole("heading", { name: "Globex" });
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await screen.findByRole("heading", { name: "Initech" });

    expect(undoOf(globex, "keep")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: undoLabel(acme.name, "pass") }),
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Undo/ })).toHaveLength(1);
  });

  it("brings back the card whose Pass emptied the Deck", async () => {
    stubFetch({
      "GET /api/profiles": { profiles: [acme], next_cursor: null },
      [`POST /api/profiles/${acme.id}/pass`]: {},
      [`DELETE /api/profiles/${acme.id}/swipe`]: {},
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    expect(screen.getByText(EMPTY_DECK_MESSAGE)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(undoOf(acme, "pass"));
    });

    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_DECK_MESSAGE)).toBeNull();
  });

  it("names the company and leaves the decision standing when the Undo fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await act(async () => swipes.answer(`/api/profiles/${acme.id}/pass`, 200));

    fireEvent.click(undoOf(acme, "pass"));
    await act(async () => {});
    await act(async () => swipes.answer(`/api/profiles/${acme.id}/swipe`, 500));

    expect(screen.getByRole("alert")).toHaveTextContent(
      undoErrorMessage("Acme", "pass"),
    );
    // The decision stands: the reader is where they had moved on to, and the card is not back.
    expect(screen.getByRole("heading", { name: "Globex" })).toBeInTheDocument();
    // And they can try again.
    expect(undoOf(acme, "pass")).toBeEnabled();
  });

  it("waits for the swipe's own write before deleting it, however fast the Undo is", async () => {
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));

    // Undone inside the round trip that records it, which is a window a reader can hit.
    fireEvent.click(undoOf(acme, "pass"));
    await act(async () => {});

    // No DELETE yet: one that overtook the POST would be answered 404, and the Pass would
    // land behind it and stand.
    expect(swipes.pending()).toEqual([`/api/profiles/${acme.id}/pass`]);

    await act(async () => swipes.answer(`/api/profiles/${acme.id}/pass`, 200));
    await waitFor(() =>
      expect(swipes.pending()).toEqual([`/api/profiles/${acme.id}/swipe`]),
    );

    await act(async () => swipes.answer(`/api/profiles/${acme.id}/swipe`, 204));

    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
  });

  // A write can fail after the row was written — a 500 on the way back out. Undoing then
  // succeeds, and what must not be left behind is a Retry offering to save the decision again.
  it("stops offering to retry a failed write once its decision is Undone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await act(async () => swipes.answer(`/api/profiles/${acme.id}/pass`, 500));

    expect(screen.getByRole("alert")).toHaveTextContent(
      unsavedMessage("Acme", "pass"),
    );

    fireEvent.click(undoOf(acme, "pass"));
    await act(async () => {});
    await act(async () => swipes.answer(`/api/profiles/${acme.id}/swipe`, 204));

    expect(
      screen.queryByRole("button", { name: "Retry Pass on Acme" }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
  });

  it("sends one DELETE for an Undo pressed twice", async () => {
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await act(async () => swipes.answer(`/api/profiles/${acme.id}/pass`, 200));

    const undo = undoOf(acme, "pass");
    fireEvent.click(undo);
    fireEvent.click(undo);
    await act(async () => {});

    expect(swipes.posted()).toEqual([
      `/api/profiles/${acme.id}/pass`,
      `/api/profiles/${acme.id}/swipe`,
    ]);
  });
});

describe("swiping the Deck's card by pointer drag", () => {
  /** jsdom lays nothing out, so the card measures zero wide and a threshold taken as a
   * fraction of its width would be zero too — every drag would clear it. One stubbed width
   * stands in for the layout a browser would have done. */
  const CARD_WIDTH = 320;

  const THRESHOLD_PX = CARD_WIDTH * SWIPE_COMMIT_FRACTION;

  /** Where a drag starts, in a viewport the card is imagined to be centred in. */
  const START = { clientX: 160, clientY: 400 };

  function stubCardWidth() {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, CARD_WIDTH, 480),
    );
  }

  /** The card's drag surface: the element the Deck's own pointer handler sits on. */
  function dragSurface(): HTMLElement {
    const surface = screen.getByRole("article").parentElement;

    if (surface === null) {
      throw new Error("the card is not inside a drag surface");
    }

    return surface;
  }

  /**
   * One whole gesture: down on `target`, two moves — so the first fixes the axis and the
   * second is the drag proper, as a real pointer does — and up where the second move left it.
   * The moves and the release go to `window`, which is where a browser sends them once the
   * pointer has left the card.
   */
  function drag(target: Element, { dx, dy = 0 }: { dx: number; dy?: number }) {
    fireEvent.pointerDown(target, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      ...START,
    });

    for (const fraction of [0.5, 1]) {
      fireEvent.pointerMove(window, {
        pointerId: 1,
        clientX: START.clientX + dx * fraction,
        clientY: START.clientY + dy * fraction,
      });
    }

    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: START.clientX + dx,
      clientY: START.clientY + dy,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves the card with the pointer while a horizontal drag is under way", async () => {
    stubCardWidth();
    stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.pointerDown(screen.getByRole("article"), {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      ...START,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: START.clientX + 40,
      clientY: START.clientY,
    });

    expect(dragSurface().style.transform).toBe("translateX(40px)");

    // Let go short of the threshold: the card springs back to where it started.
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: START.clientX + 40,
      clientY: START.clientY,
    });

    expect(dragSurface().style.transform).toBe("");
  });

  it("Keeps the Profile on a drag to the right past the threshold, with exactly one POST", async () => {
    stubCardWidth();
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    drag(screen.getByRole("article"), { dx: THRESHOLD_PX + 10 });

    expect(swipes.posted()).toEqual([`/api/profiles/${acme.id}/keep`]);
    expect(screen.getByRole("heading", { name: "Globex" })).toBeInTheDocument();
  });

  it("Passes the Profile on a drag to the left past the threshold, with exactly one POST", async () => {
    stubCardWidth();
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    drag(screen.getByRole("article"), { dx: -(THRESHOLD_PX + 10) });

    expect(swipes.posted()).toEqual([`/api/profiles/${acme.id}/pass`]);
    expect(screen.getByRole("heading", { name: "Globex" })).toBeInTheDocument();
  });

  it("records nothing for a drag that stops short of the threshold", async () => {
    stubCardWidth();
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    drag(screen.getByRole("article"), { dx: THRESHOLD_PX - 10 });

    expect(swipes.posted()).toEqual([]);
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
  });

  it("records nothing for a mostly vertical drag, however far it later wanders sideways", async () => {
    stubCardWidth();
    const swipes = stubSwipes({
      "GET /api/profiles": { profiles: [acme, globex], next_cursor: null },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    // Down first, then across: a scroll that drifts is still a scroll.
    fireEvent.pointerDown(screen.getByRole("article"), {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      ...START,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: START.clientX,
      clientY: START.clientY + 60,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: START.clientX + THRESHOLD_PX + 10,
      clientY: START.clientY + 60,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: START.clientX + THRESHOLD_PX + 10,
      clientY: START.clientY + 60,
    });

    expect(swipes.posted()).toEqual([]);
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(dragSurface().style.transform).toBe("");
  });

  it("leaves a press on a tab inside the card to the tab, deciding nothing", async () => {
    stubCardWidth();
    const swipes = stubSwipes({
      "GET /api/profiles": {
        profiles: [{ ...acme, website: "https://acme.example" }, globex],
        next_cursor: null,
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    const contact = screen.getByRole("tab", { name: "Contact" });
    drag(contact, { dx: THRESHOLD_PX + 10 });
    fireEvent.click(contact);

    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Contact");
    expect(swipes.posted()).toEqual([]);
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
  });
});

describe("the card's tabs in the Deck", () => {
  const withFounders = {
    ...acme,
    website: "https://acme.example",
    founders: [{ name: "Ada Quinn", role: "CEO" }],
    links: null,
  };

  // The Deck's card passes no News or Events prop, per the Ticket, so it keeps exactly the
  // three tabs it always had.
  it("shows only Company, Team and Contact: never News or Events", async () => {
    stubFetch({
      "GET /api/profiles": {
        profiles: [withFounders, globex],
        next_cursor: null,
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Company",
      "Team",
      "Contact",
    ]);
  });

  it("opens every Profile on Company, whichever tab the last one was left on", async () => {
    stubFetch({
      "GET /api/profiles": {
        profiles: [withFounders, globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/keep`]: {
        profile_id: acme.id,
        decision: "keep",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("tab", { name: "Contact" }));
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Contact");

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await screen.findByRole("heading", { name: "Globex" });

    expect(screen.getByRole("tab", { name: "Company" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Company");
  });

  it("changes tab from the arrow keys without Keeping or Passing anything", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [withFounders, globex],
        next_cursor: null,
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    const company = screen.getByRole("tab", { name: "Company" });
    company.focus();

    fireEvent.keyDown(company, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Team" }), {
      key: "ArrowLeft",
    });

    expect(company).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still Keeps from the arrow key once focus has left the tabs", async () => {
    const fetchMock = stubFetch({
      "GET /api/profiles": {
        profiles: [withFounders, globex],
        next_cursor: null,
      },
      [`POST /api/profiles/${acme.id}/keep`]: {
        profile_id: acme.id,
        decision: "keep",
        decided_at: new Date().toISOString(),
      },
    });

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });
    fireEvent.click(screen.getByRole("tab", { name: "Team" }));

    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/profiles/${acme.id}/keep`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});
