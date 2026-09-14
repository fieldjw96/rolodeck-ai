import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_NEWS_MESSAGE,
  LOAD_ERROR_MESSAGE,
  LOADING_NEWS_MESSAGE,
  News,
} from "./news";

const RAMP = {
  profile: {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Ramp",
    sector: "fintech",
  },
  items: [
    {
      id: "a",
      title: "Ramp raises $150 million",
      url: "https://techcrunch.example/ramp-raises",
      published_at: "2026-09-05T12:00:00.000Z",
      source_name: "TechCrunch",
      confidence: 0.85,
    },
    {
      id: "b",
      title: "Ramp launches bill pay",
      url: "https://theverge.example/ramp-bill-pay",
      published_at: "2026-08-20T09:00:00.000Z",
      source_name: "The Verge",
      confidence: 0.7,
    },
  ],
};

const MERCURY = {
  profile: {
    id: "22222222-2222-2222-2222-222222222222",
    name: "Mercury",
    sector: "fintech",
  },
  items: [
    {
      id: "c",
      title: "Mercury, the startup bank, adds credit cards",
      url: "https://fortune.example/mercury-cards",
      published_at: "2026-09-01T12:00:00.000Z",
      source_name: "Fortune",
      confidence: 0.75,
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("News", () => {
  it("lists each Kept company's articles under its name, in the order GET /api/news returns them", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ companies: [RAMP, MERCURY] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<News />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "News" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/news");
    expect(
      screen.getByText("3 articles about 2 companies"),
    ).toBeInTheDocument();

    const companies = screen.getAllByRole("region");
    expect(
      companies.map(
        (company) => within(company).getByRole("heading").textContent,
      ),
    ).toEqual(["Ramp", "Mercury"]);

    const rampLinks = within(companies[0]!).getAllByRole("link");
    expect(rampLinks.map((link) => link.textContent)).toEqual([
      "Ramp raises $150 million",
      "Ramp launches bill pay",
    ]);
    expect(rampLinks[0]).toHaveAttribute(
      "href",
      "https://techcrunch.example/ramp-raises",
    );
    expect(rampLinks[0]).toHaveAttribute("rel", "noopener noreferrer");

    const published = within(companies[0]!).getByText("Sep 5, 2026");
    expect(published).toHaveAttribute("datetime", "2026-09-05T12:00:00.000Z");
    expect(within(companies[0]!).getByText("TechCrunch")).toBeInTheDocument();
  });

  it("says so, with a designed empty state, when there is no News", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ companies: [] })),
    );

    render(<News />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(EMPTY_NEWS_MESSAGE);
    expect(notice).toHaveTextContent("grouped by company");
  });

  it("announces that it is loading while the request is in flight", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(<News />);

    expect(screen.getByRole("status")).toHaveTextContent(LOADING_NEWS_MESSAGE);
  });

  it("shows an explicit error when the fetch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );

    render(<News />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_ERROR_MESSAGE,
    );
  });

  it("counts a single article about a single company in the singular", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ companies: [MERCURY] })),
    );

    render(<News />);

    expect(
      await screen.findByText("1 article about 1 company"),
    ).toBeInTheDocument();
  });
});
