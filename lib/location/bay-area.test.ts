import { describe, expect, it } from "vitest";

import { isBayArea } from "./bay-area";

describe("isBayArea", () => {
  it("accepts a Bay Area city", () => {
    expect(isBayArea("San Francisco, CA")).toBe(true);
  });

  it("rejects a non-Bay-Area Californian city", () => {
    // The Ticket's own example: passes the EDGAR CALIFORNIA filter and is not the Bay Area.
    expect(isBayArea("Los Angeles, CA")).toBe(false);
  });

  it("answers false for a null location rather than throwing", () => {
    expect(isBayArea(null)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isBayArea("san francisco, CA")).toBe(true);
  });

  it("answers false for a bare state with no city stated", () => {
    expect(isBayArea("CA")).toBe(false);
  });
});
