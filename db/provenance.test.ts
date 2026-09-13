import { describe, expect, it } from "vitest";

import { PROVENANCE_VALUES, profileProvenanceSchema } from "./provenance";

describe("profileProvenanceSchema", () => {
  it("accepts a different provenance for every field", () => {
    const mixed = {
      name: "jack",
      description: "enriched",
      sector: "scraped",
      stage: "scraped",
      website: "enriched",
      location: "scraped",
    };

    expect(profileProvenanceSchema.parse(mixed)).toEqual(mixed);
  });

  it("accepts a null provenance for a Profile with no website", () => {
    const parsed = profileProvenanceSchema.parse({
      name: "scraped",
      description: "scraped",
      sector: "scraped",
      stage: "scraped",
      website: null,
      location: "scraped",
    });

    expect(parsed.website).toBeNull();
  });

  it("accepts a null provenance for a Profile whose location is unknown", () => {
    // The Ticket's own criterion: a Profile whose location is unknown still has a valid,
    // null provenance for that field.
    const parsed = profileProvenanceSchema.parse({
      name: "scraped",
      description: "scraped",
      sector: "scraped",
      stage: "scraped",
      website: null,
      location: null,
    });

    expect(parsed.location).toBeNull();
  });

  it.each(PROVENANCE_VALUES)("accepts %s as a field's provenance", (value) => {
    const parsed = profileProvenanceSchema.parse({
      name: value,
      description: value,
      sector: value,
      stage: value,
      website: value,
      location: value,
    });

    expect(parsed.name).toBe(value);
  });

  it("names the offending field when a provenance value is unknown", () => {
    const result = profileProvenanceSchema.safeParse({
      name: "scraped",
      description: "guessed",
      sector: "scraped",
      stage: "scraped",
      website: null,
      location: null,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["description"]);
  });

  it("rejects a Profile field left without provenance", () => {
    expect(
      profileProvenanceSchema.safeParse({
        name: "scraped",
        description: "scraped",
        sector: "scraped",
        website: null,
        location: null,
      }).success,
    ).toBe(false);
  });

  it("rejects provenance for a field that is not a Profile field", () => {
    expect(
      profileProvenanceSchema.safeParse({
        name: "scraped",
        description: "scraped",
        sector: "scraped",
        stage: "scraped",
        website: null,
        location: null,
        founder: "scraped",
      }).success,
    ).toBe(false);
  });

  it("rejects a null provenance for a field that always has a value", () => {
    expect(
      profileProvenanceSchema.safeParse({
        name: null,
        description: "scraped",
        sector: "scraped",
        stage: "scraped",
        website: null,
        location: null,
      }).success,
    ).toBe(false);
  });
});
