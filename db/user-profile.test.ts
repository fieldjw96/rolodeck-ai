// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Sector } from "./profile-input";
import { userProfiles } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import {
  EMPTY_USER_PROFILE,
  readUserProfile,
  writeUserProfile,
} from "./user-profile";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

let scratch: ScratchDb;

/**
 * The name of the constraint a write violated, or undefined if it was accepted. Drizzle wraps
 * driver errors, so the constraint name lives on the cause rather than the message.
 */
async function constraintViolatedBy(
  write: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await write;
    return undefined;
  } catch (error) {
    return (error as { cause?: { constraint?: string } }).cause?.constraint;
  }
}

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(SOMEONE_ELSE);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
});

beforeEach(async () => {
  await scratch.reset();
  await scratch.db.delete(userProfiles);
});

describe("readUserProfile", () => {
  it("returns a well-defined empty User Profile when the owner has never saved one", async () => {
    await expect(readUserProfile(scratch.db, JACK)).resolves.toEqual(
      EMPTY_USER_PROFILE,
    );
  });

  it("reads back exactly what writeUserProfile wrote", async () => {
    await writeUserProfile(scratch.db, JACK, {
      sectors: ["ai-ml", "fintech"],
      stages: ["seed", "series-a"],
      area: "Bay Area",
      excluded_sectors: ["security"],
    });

    await expect(readUserProfile(scratch.db, JACK)).resolves.toEqual({
      sectors: ["ai-ml", "fintech"],
      stages: ["seed", "series-a"],
      area: "Bay Area",
      excludedSectors: ["security"],
    });
  });
});

describe("writeUserProfile", () => {
  it("the owner has exactly one row: writing twice corrects it rather than adding a second", async () => {
    await writeUserProfile(scratch.db, JACK, {
      sectors: ["ai-ml"],
      stages: ["seed"],
      area: "Bay Area",
      excluded_sectors: [],
    });

    await writeUserProfile(scratch.db, JACK, {
      sectors: ["fintech"],
      stages: ["growth"],
      area: "Bay Area",
      excluded_sectors: ["ai-ml"],
    });

    const rows = await scratch.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, JACK));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sectors).toEqual(["fintech"]);
    expect(rows[0]?.excludedSectors).toEqual(["ai-ml"]);
  });
});

describe("user_profiles constraints", () => {
  it("rejects a sector off the controlled list, even bypassing the Zod boundary", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(userProfiles).values({
        userId: JACK,
        sectors: ["not-a-sector"] as unknown as Sector[],
        stages: [],
        area: "Bay Area",
        excludedSectors: [],
      }),
    );

    expect(violated).toBe("user_profiles_sectors_are_controlled");
  });

  it("rejects an excluded sector off the controlled list", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(userProfiles).values({
        userId: JACK,
        sectors: [],
        stages: [],
        area: "Bay Area",
        excludedSectors: ["not-a-sector"] as unknown as Sector[],
      }),
    );

    expect(violated).toBe("user_profiles_excluded_sectors_are_controlled");
  });

  it("rejects a Sector that is both stated and excluded", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(userProfiles).values({
        userId: JACK,
        sectors: ["ai-ml", "fintech"],
        stages: [],
        area: "Bay Area",
        excludedSectors: ["fintech"],
      }),
    );

    expect(violated).toBe("user_profiles_sectors_excluded_disjoint");
  });
});

describe("user_profiles row level security", () => {
  beforeEach(async () => {
    await scratch.db.insert(userProfiles).values([
      {
        userId: JACK,
        sectors: ["ai-ml"],
        stages: ["seed"],
        area: "Bay Area",
        excludedSectors: [],
      },
      {
        userId: SOMEONE_ELSE,
        sectors: ["fintech"],
        stages: ["growth"],
        area: "Bay Area",
        excludedSectors: [],
      },
    ]);
  });

  it("is enabled on the user_profiles table", async () => {
    const { rows } = await scratch.client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.user_profiles'::regclass",
    );

    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  it("returns zero rows to the anonymous role", async () => {
    await scratch.as("anon");

    await expect(scratch.db.select().from(userProfiles)).resolves.toEqual([]);
  });

  it("returns only the signed-in user's own row", async () => {
    await scratch.as("authenticated", JACK);

    const rows = await scratch.db.select().from(userProfiles);

    expect(rows.map((row) => row.userId)).toEqual([JACK]);
  });

  it("hides the row from an authenticated user who does not own it", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    const rows = await scratch.db.select().from(userProfiles);

    expect(rows.map((row) => row.userId)).toEqual([SOMEONE_ELSE]);
  });

  it("does not let a signed-in user write another user's row", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(
      scratch.db
        .update(userProfiles)
        .set({ sectors: ["security"] })
        .where(eq(userProfiles.userId, JACK)),
    ).resolves.not.toThrow();

    await scratch.reset();

    const [untouched] = await scratch.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, JACK));

    expect(untouched?.sectors).toEqual(["ai-ml"]);
  });
});
