import { describe, expect, it } from "vitest";

import { STAGE_VALUES, STATED_STAGE_VALUES } from "./profile-input";
import { userProfileInputSchema } from "./user-profile-input";

const NOTHING = {
  sectors: [],
  stages: [],
  area: "Bay Area",
  excluded_sectors: [],
};

describe("userProfileInputSchema, on stages", () => {
  it.each(STATED_STAGE_VALUES)("accepts %s as a stated preference", (stage) => {
    expect(
      userProfileInputSchema.safeParse({ ...NOTHING, stages: [stage] }).success,
    ).toBe(true);
  });

  it("rejects `not-stated`, which a Company Profile can hold but an owner cannot prefer", () => {
    expect(STAGE_VALUES).toContain("not-stated");

    const result = userProfileInputSchema.safeParse({
      ...NOTHING,
      stages: ["not-stated"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["stages", 0]);
    expect(result.error?.issues[0]?.message).toContain('"not-stated"');
  });

  it("rejects a Stage off the closed list entirely, naming it, before Postgres ever sees it", () => {
    const result = userProfileInputSchema.safeParse({
      ...NOTHING,
      stages: ["series-z"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["stages", 0]);
    expect(result.error?.issues[0]?.message).toContain('"series-z"');
  });
});

describe("userProfileInputSchema, on sectors", () => {
  it("rejects a Sector off the closed list entirely, naming it, before Postgres ever sees it", () => {
    const result = userProfileInputSchema.safeParse({
      ...NOTHING,
      sectors: ["not-a-sector"],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["sectors", 0]);
    expect(result.error?.issues[0]?.message).toContain('"not-a-sector"');
  });
});
