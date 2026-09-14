import { describe, expect, it } from "vitest";

import { citiesInArea, isBayArea } from "./bay-area";

describe("citiesInArea", () => {
  it("lists the cities isBayArea accepts for the Bay Area", () => {
    const cities = citiesInArea("Bay Area");

    expect(cities).toContain("san francisco");
    expect(cities.every((city) => isBayArea(`${city}, CA`))).toBe(true);
  });

  it("reads the area case- and whitespace-insensitively", () => {
    expect(citiesInArea("  bay area ")).toEqual(citiesInArea("Bay Area"));
  });

  it("lists nothing for an area it has no cities for, rather than throwing", () => {
    expect(citiesInArea("New York")).toEqual([]);
  });
});

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
