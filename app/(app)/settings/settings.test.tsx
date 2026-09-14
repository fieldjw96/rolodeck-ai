import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOAD_ERROR_MESSAGE, SAVED_MESSAGE, Settings } from "./settings";

const EMPTY_BODY = {
  sectors: [],
  stages: [],
  area: "Bay Area",
  excluded_sectors: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Sectors and Excluded sectors both list every Sector, so a checkbox is only unambiguous
 * once scoped to the `fieldset` it lives in. */
function sectorsGroup() {
  return screen.getByRole("group", { name: "Sectors" });
}

function excludedSectorsGroup() {
  return screen.getByRole("group", { name: "Excluded sectors" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings", () => {
  it("loads the owner's stated preferences and checks the boxes that apply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          sectors: ["ai-ml"],
          stages: ["seed"],
          area: "Bay Area",
          excluded_sectors: ["security"],
        }),
      ),
    );

    render(<Settings />);

    await screen.findByRole("checkbox", { name: "seed" });

    expect(
      within(sectorsGroup()).getByRole("checkbox", { name: "ai-ml" }),
    ).toBeChecked();
    expect(
      within(excludedSectorsGroup()).getByRole("checkbox", {
        name: "security",
      }),
    ).toBeChecked();
    expect(
      within(sectorsGroup()).getByRole("checkbox", { name: "security" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "seed" })).toBeChecked();

    expect(screen.getByLabelText("Area")).toHaveValue("Bay Area");
  });

  it("shows an explicit error when the load fails, rather than staying blank", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );

    render(<Settings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      LOAD_ERROR_MESSAGE,
    );
  });

  it("checking a Sector as excluded unchecks it as stated, and the reverse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, EMPTY_BODY)),
    );

    render(<Settings />);
    await screen.findByRole("checkbox", { name: "seed" });

    const stated = within(sectorsGroup()).getByRole("checkbox", {
      name: "ai-ml",
    });
    const excluded = within(excludedSectorsGroup()).getByRole("checkbox", {
      name: "ai-ml",
    });

    fireEvent.click(stated);
    expect(stated).toBeChecked();

    fireEvent.click(excluded);
    expect(excluded).toBeChecked();
    expect(stated).not.toBeChecked();
  });

  it("saves the form via PUT /api/user-profile and shows a confirmation", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(200, JSON.parse(init.body as string) as unknown);
      }
      return jsonResponse(200, EMPTY_BODY);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Settings />);
    await screen.findByRole("checkbox", { name: "seed" });

    fireEvent.click(
      within(sectorsGroup()).getByRole("checkbox", { name: "fintech" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(SAVED_MESSAGE);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/user-profile",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("shows the rejection naming the offending field when the save is a 422", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(422, {
          error: "invalid request",
          field: "excluded_sectors",
          reason: "cannot list a Sector as both stated and excluded: fintech",
        });
      }
      return jsonResponse(200, EMPTY_BODY);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Settings />);
    await screen.findByRole("checkbox", { name: "seed" });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "excluded_sectors",
    );
  });
});
