import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Deck, EMPTY_DECK_MESSAGE } from "./deck";

type Profile = {
  id: string;
  name: string;
  description: string;
  sector: string;
  stage: string;
};

const acme: Profile = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Acme",
  description: "Widgets, but faster.",
  sector: "Hardware",
  stage: "Seed",
};

const globex: Profile = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Globex",
  description: "Logistics for the last mile.",
  sector: "Logistics",
  stage: "Series A",
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
});
