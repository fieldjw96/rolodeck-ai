import {
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

  it("does not advance the Deck when a swipe request fails", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          return jsonResponse({ profiles: [acme, globex], next_cursor: null });
        }

        return { ok: false, status: 500 } as Response;
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    render(<Deck />);

    await screen.findByRole("heading", { name: "Acme" });

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/profiles/${acme.id}/keep`,
        expect.objectContaining({ method: "POST" }),
      ),
    );

    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
  });

  it("ignores a second decision made before the first swipe has settled", async () => {
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

    const keepButton = screen.getByRole("button", { name: "Keep" });
    fireEvent.click(keepButton);
    fireEvent.click(keepButton);

    expect(
      await screen.findByRole("heading", { name: "Globex" }),
    ).toBeInTheDocument();

    const keepCalls = fetchMock.mock.calls.filter(
      ([url]) => url === `/api/profiles/${acme.id}/keep`,
    );
    expect(keepCalls).toHaveLength(1);
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
});

describe("the card's tabs in the Deck", () => {
  const withFounders = {
    ...acme,
    website: "https://acme.example",
    founders: [{ name: "Ada Quinn", role: "CEO" }],
    links: null,
  };

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
