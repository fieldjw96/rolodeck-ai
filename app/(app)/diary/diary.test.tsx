import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Diary,
  EMPTY_DIARY_MESSAGE,
  EMPTY_DIARY_WITH_PAST_MESSAGE,
  KEPT_ATTENDING_LABEL,
  LOAD_ERROR_MESSAGE,
  SHOW_PAST_LABEL,
  type DiaryEntry,
} from "./diary";

const SUMMIT: DiaryEntry = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Sprocket Summit",
  start_date: "2026-10-01",
  end_date: "2026-10-02",
  location: "San Francisco",
  url: "https://example.com/summit",
  important: true,
  kept_companies: ["Quiet Co", "Sprocket"],
};

const DEMO_DAY: DiaryEntry = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Demo Day",
  start_date: "2026-11-01",
  end_date: null,
  location: null,
  url: "https://example.com/demo-day",
  important: false,
  kept_companies: [],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Diary", () => {
  it("lists every Event from GET /api/events, in the order it arrives", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ events: [SUMMIT, DEMO_DAY] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Diary />);

    const headings = await screen.findAllByRole("heading", { level: 2 });

    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Sprocket Summit",
      "Demo Day",
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/events");
    expect(screen.getByText("2 Events")).toBeInTheDocument();
  });

  it("shows each Event's dates, location and link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ events: [SUMMIT, DEMO_DAY] })),
    );

    render(<Diary />);

    const link = await screen.findByRole("link", { name: "Sprocket Summit" });

    expect(link).toHaveAttribute("href", "https://example.com/summit");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByText("Thu, Oct 1, 2026", { selector: "time" }),
    ).toHaveAttribute("datetime", "2026-10-01");
    expect(
      screen.getByText("Fri, Oct 2, 2026", { selector: "time" }),
    ).toBeInTheDocument();
    expect(screen.getByText("San Francisco")).toBeInTheDocument();
    // A one-day Event shows one date, not a range.
    expect(screen.getByText("Sun, Nov 1, 2026").closest("p")).toHaveTextContent(
      /^Sun, Nov 1, 2026$/,
    );
  });

  it("marks an important Event in words, naming the Kept companies, and leaves the rest unmarked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ events: [SUMMIT, DEMO_DAY] })),
    );

    render(<Diary />);

    const [summit, demoDay] = await screen.findAllByRole("article");

    expect(within(summit!).getByText(`${KEPT_ATTENDING_LABEL}:`)).toBeVisible();
    expect(summit).toHaveTextContent("Quiet Co, Sprocket");
    expect(within(demoDay!).queryByText(`${KEPT_ATTENDING_LABEL}:`)).toBeNull();
    expect(summit!.className).not.toBe(demoDay!.className);
  });

  it("shows a designed empty state when there are no upcoming Events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ events: [] })),
    );

    render(<Diary />);

    expect(await screen.findByText(EMPTY_DIARY_MESSAGE)).toBeInTheDocument();
  });

  it("asks for past Events too when the toggle is pressed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Diary />);
    await screen.findByText(EMPTY_DIARY_MESSAGE);

    const toggle = screen.getByRole("button", { name: SHOW_PAST_LABEL });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    expect(
      await screen.findByText(EMPTY_DIARY_WITH_PAST_MESSAGE),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/events?include=past");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an explicit error when the fetch fails, rather than staying on loading forever", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );

    render(<Diary />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_ERROR_MESSAGE,
    );
  });
});
