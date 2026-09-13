import { describe, expect, it } from "vitest";

import { MINIMUM_PROFILE_COUNT } from "../../db/seed";
import { profileInputSchema } from "../../db/profile-input";
import { SEED_CANDIDATES, SEED_PROFILES, SEED_SOURCE } from "./seed-profiles";

describe("SEED_PROFILES", () => {
  it("holds enough rows to reach the minimum on its own", () => {
    expect(SEED_PROFILES.length).toBeGreaterThanOrEqual(MINIMUM_PROFILE_COUNT);
  });

  it("passes profileInputSchema unchanged, every entry", () => {
    for (const input of SEED_PROFILES) {
      expect(profileInputSchema.parse(input)).toEqual(input);
    }
  });

  it("names no company twice, even differing only in case or spacing", () => {
    const keys = SEED_PROFILES.map((input) =>
      input.name.trim().toLowerCase().replace(/\s+/g, " "),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is a lowercase slug, like every other Source", () => {
    expect(SEED_SOURCE).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("maps Jack's own sector text onto the controlled Sector list", () => {
    // Anthropic is hand-curated as "Artificial Intelligence"; see the raw list in
    // `seed-profiles.ts`.
    expect(
      SEED_PROFILES.find((input) => input.name === "Anthropic")?.sector,
    ).toBe("ai-ml");
  });

  it("states a location for every row, the way the module doc says it is", () => {
    // The whole list is hand-curated as Bay-Area-headquartered; a row with no location would
    // be a gap in that curation, not something a real Source failed to state.
    for (const input of SEED_PROFILES) {
      expect(typeof input.location).toBe("string");
    }
  });
});

describe("SEED_CANDIDATES", () => {
  it("attributes provenance jack to every field, for every candidate", () => {
    for (const candidate of SEED_CANDIDATES) {
      expect(candidate.provenance.name).toBe("jack");
      expect(candidate.provenance.description).toBe("jack");
      expect(candidate.provenance.sector).toBe("jack");
      expect(candidate.provenance.stage).toBe("jack");
    }
  });

  it("attributes website jack exactly when the Profile has one", () => {
    for (const candidate of SEED_CANDIDATES) {
      expect(candidate.provenance.website).toBe(
        candidate.input.website === undefined ? null : "jack",
      );
    }
  });

  it("attributes location jack for every candidate, which all state one", () => {
    for (const candidate of SEED_CANDIDATES) {
      expect(candidate.provenance.location).toBe("jack");
    }
  });

  it("carries the same Profiles as SEED_PROFILES, in the same order", () => {
    expect(SEED_CANDIDATES.map((candidate) => candidate.input)).toEqual(
      SEED_PROFILES,
    );
  });
});
