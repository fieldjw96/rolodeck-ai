// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  backfillSeedProfiles,
  MINIMUM_PROFILE_COUNT,
  SEED_SOURCE,
} from "./seed-fallback";
import { SEED_PROFILES } from "./seed-data";
import { profiles } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { seedProfiles } from "./testing/seed-profiles";

const JACK = "11111111-1111-1111-1111-111111111111";

let scratch: ScratchDb;
const ownerIdBefore = process.env.ROLODECK_OWNER_ID;

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
  process.env.ROLODECK_OWNER_ID = ownerIdBefore;
});

beforeEach(async () => {
  process.env.ROLODECK_OWNER_ID = JACK;
  await scratch.reset();
  await scratch.db.delete(profiles);
});

describe("backfillSeedProfiles", () => {
  it("brings an empty table up to the minimum with hand-written Profiles", async () => {
    const report = await backfillSeedProfiles(scratch.db);

    expect(report).toEqual({
      before: 0,
      added: MINIMUM_PROFILE_COUNT,
      after: MINIMUM_PROFILE_COUNT,
    });

    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(MINIMUM_PROFILE_COUNT);
    expect(rows.every((row) => row.source === SEED_SOURCE)).toBe(true);
  });

  it("stamps provenance: jack on every field it fills, and null where there is no website", async () => {
    await backfillSeedProfiles(scratch.db);

    const rows = await scratch.db.select().from(profiles);

    for (const row of rows) {
      expect(row.provenance.name).toBe("jack");
      expect(row.provenance.description).toBe("jack");
      expect(row.provenance.sector).toBe("jack");
      expect(row.provenance.stage).toBe("jack");
      expect(row.provenance.website).toBe(row.website === null ? null : "jack");
    }
  });

  it("does nothing when #4 alone already reached the minimum", async () => {
    await seedProfiles(scratch.db, {
      count: MINIMUM_PROFILE_COUNT,
      ownerId: JACK,
    });

    const report = await backfillSeedProfiles(scratch.db);

    expect(report).toEqual({
      before: MINIMUM_PROFILE_COUNT,
      added: 0,
      after: MINIMUM_PROFILE_COUNT,
    });

    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(MINIMUM_PROFILE_COUNT);
  });

  it("tops up only the shortfall when the table is partially populated", async () => {
    await seedProfiles(scratch.db, { count: 12, ownerId: JACK });

    const report = await backfillSeedProfiles(scratch.db);

    expect(report).toEqual({
      before: 12,
      added: MINIMUM_PROFILE_COUNT - 12,
      after: MINIMUM_PROFILE_COUNT,
    });

    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(MINIMUM_PROFILE_COUNT);
  });

  it("honours a caller-supplied minimum", async () => {
    const report = await backfillSeedProfiles(scratch.db, { minimum: 5 });

    expect(report).toEqual({ before: 0, added: 5, after: 5 });
  });

  it("throws rather than under-delivering when the seed list itself is too short", async () => {
    await expect(
      backfillSeedProfiles(scratch.db, {
        minimum: SEED_PROFILES.length + 1,
      }),
    ).rejects.toThrow(/not enough/);

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
  });
});

describe("backfillSeedProfiles idempotency", () => {
  it("runs twice against a scratch table and grows the row count only once", async () => {
    const first = await backfillSeedProfiles(scratch.db);
    const firstCount = (await scratch.db.select().from(profiles)).length;

    const second = await backfillSeedProfiles(scratch.db);
    const secondCount = (await scratch.db.select().from(profiles)).length;

    expect(first.added).toBe(MINIMUM_PROFILE_COUNT);
    expect(firstCount).toBe(MINIMUM_PROFILE_COUNT);

    expect(second.added).toBe(0);
    expect(secondCount).toBe(MINIMUM_PROFILE_COUNT);
  });
});
