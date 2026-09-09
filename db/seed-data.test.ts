import { describe, expect, it } from "vitest";

import { profileInputSchema } from "./profile-input";
import { MINIMUM_PROFILE_COUNT } from "./seed-fallback";
import { SEED_PROFILES } from "./seed-data";

describe("SEED_PROFILES", () => {
  it("holds enough rows to bring an empty table up to the minimum on its own", () => {
    expect(SEED_PROFILES.length).toBeGreaterThanOrEqual(MINIMUM_PROFILE_COUNT);
  });

  it("passes profileInputSchema unchanged, row by row", () => {
    for (const input of SEED_PROFILES) {
      expect(profileInputSchema.parse(input)).toEqual(input);
    }
  });

  it("names only real, distinct companies", () => {
    const names = SEED_PROFILES.map((input) => input.name);

    expect(new Set(names).size).toBe(names.length);
  });
});
