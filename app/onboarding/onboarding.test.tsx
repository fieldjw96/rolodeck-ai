import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SAVE_ERROR_MESSAGE, Onboarding } from "./onboarding";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function sectorsGroup() {
  return screen.getByRole("group", { name: /sectors/i });
}

function stagesGroup() {
  return screen.getByRole("group", { name: /stages/i });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

describe("Onboarding", () => {
  it("defaults every Sector and every stated Stage to checked", () => {
    render(<Onboarding />);

    for (const checkbox of within(sectorsGroup()).getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
    }
    for (const checkbox of within(stagesGroup()).getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
    }
  });

  it("presents Sectors and Stages as two distinguishable groups, each naming what it does", () => {
    render(<Onboarding />);

    expect(
      screen.getByRole("group", { name: /sectors.*reorders your deck/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /stages.*reorders your deck/i }),
    ).toBeInTheDocument();
  });

  it("never offers `not-stated`, which is not a Stage to prefer", () => {
    render(<Onboarding />);

    expect(
      within(stagesGroup())
        .getAllByRole("checkbox")
        .map((box) => box.parentElement?.textContent),
    ).toEqual(["pre-seed", "seed", "series-a", "series-b-plus", "growth"]);
    expect(
      screen.queryByRole("checkbox", { name: "not-stated" }),
    ).not.toBeInTheDocument();
  });

  it("saves exactly what is checked via PUT /api/user-profile, with no area and no exclusion of its own, then moves on to the Deck", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      jsonResponse(200, JSON.parse(init?.body as string) as unknown),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Onboarding />);

    fireEvent.click(
      within(sectorsGroup()).getByRole("checkbox", { name: "fintech" }),
    );
    fireEvent.click(
      within(stagesGroup()).getByRole("checkbox", { name: "growth" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith("/deck");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user-profile",
      expect.objectContaining({ method: "PUT" }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      sectors: string[];
      stages: string[];
      area: string;
      excluded_sectors: string[];
    };

    expect(body.sectors).not.toContain("fintech");
    expect(body.stages).not.toContain("growth");
    expect(body.area).toBe("Bay Area");
    expect(body.excluded_sectors).toEqual([]);
  });

  it("skips in one click, saving every preference empty regardless of what is checked", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      jsonResponse(200, JSON.parse(init?.body as string) as unknown),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Onboarding />);

    // Checked state is untouched: Skip is a different claim from unchecking everything by hand.
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith("/deck");
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      sectors: string[];
      stages: string[];
      area: string;
      excluded_sectors: string[];
    };

    expect(body).toEqual({
      sectors: [],
      stages: [],
      area: "Bay Area",
      excluded_sectors: [],
    });
  });

  it("shows an explicit error and stays on the screen when saving fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );

    render(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SAVE_ERROR_MESSAGE,
    );
    expect(push).not.toHaveBeenCalled();
  });
});
