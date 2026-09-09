import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_WATCHLIST_MESSAGE, LOAD_ERROR_MESSAGE, Watchlist } from "./watchlist";

type KeptProfile = {
  id: string;
  name: string;
  sector: string;
  stage: string;
};

const acme: KeptProfile = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Acme",
  sector: "Hardware",
  stage: "Seed",
};

const globex: KeptProfile = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Globex",
  sector: "Logistics",
  stage: "Series A",
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
    expect(fetchMock).toHaveBeenCalledWith("/api/profiles?filter=kept");
  });

  it("shows an explicit empty state when nothing has been Kept, rather than a blank screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ profiles: [], next_cursor: null })),
    );

    render(<Watchlist />);

    expect(await screen.findByText(EMPTY_WATCHLIST_MESSAGE)).toBeInTheDocument();
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
});
