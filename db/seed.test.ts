// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SEED_SOURCE } from "../lib/ingest/seed-profiles";
import { backfillSeedProfiles, MINIMUM_PROFILE_COUNT } from "./seed";
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
  it("fills an empty table up to the minimum", async () => {
    const result = await backfillSeedProfiles(scratch.db);

    expect(result.before).toBe(0);
    expect(result.needed).toBe(MINIMUM_PROFILE_COUNT);
    expect(result.report.inserted).toBe(MINIMUM_PROFILE_COUNT);
    expect(result.report.rejected).toBe(0);

    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(MINIMUM_PROFILE_COUNT);
  });

  it("writes every field's provenance as jack, under the jack Source", async () => {
    await backfillSeedProfiles(scratch.db);

    const rows = await scratch.db.select().from(profiles);

    for (const row of rows) {
      expect(row.source).toBe(SEED_SOURCE);
      expect(row.provenance.name).toBe("jack");
      expect(row.provenance.description).toBe("jack");
      expect(row.provenance.sector).toBe("jack");
      expect(row.provenance.stage).toBe("jack");
      expect(row.provenance.website).toBe(row.website === null ? null : "jack");
    }
  });

  it("tops up only as many rows as are missing when some already exist", async () => {
    await seedProfiles(scratch.db, { count: 25, ownerId: JACK });

    const result = await backfillSeedProfiles(scratch.db);

    expect(result.before).toBe(25);
    expect(result.needed).toBe(5);
    expect(result.report.inserted).toBe(5);

    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(MINIMUM_PROFILE_COUNT);
  });

  it("finds nothing to add once profiles already holds the minimum, and that is a pass", async () => {
    await seedProfiles(scratch.db, {
      count: MINIMUM_PROFILE_COUNT,
      ownerId: JACK,
    });

    const result = await backfillSeedProfiles(scratch.db);

    expect(result.before).toBe(MINIMUM_PROFILE_COUNT);
    expect(result.needed).toBe(0);
    expect(result.report).toEqual({
      inserted: 0,
      updated: 0,
      rejected: 0,
      rejections: [],
    });

    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(MINIMUM_PROFILE_COUNT);
  });

  it("finds nothing to add when a table well past the minimum already exists", async () => {
    await seedProfiles(scratch.db, { count: 40, ownerId: JACK });

    const result = await backfillSeedProfiles(scratch.db);

    expect(result.needed).toBe(0);
    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(40);
  });
});

describe("backfillSeedProfiles idempotency", () => {
  it("running it twice grows the row count only once", async () => {
    const first = await backfillSeedProfiles(scratch.db);
    const afterFirst = await scratch.db.select().from(profiles);

    const second = await backfillSeedProfiles(scratch.db);
    const afterSecond = await scratch.db.select().from(profiles);

    expect(first.report.inserted).toBe(MINIMUM_PROFILE_COUNT);
    expect(afterFirst).toHaveLength(MINIMUM_PROFILE_COUNT);

    expect(second.needed).toBe(0);
    expect(second.report.inserted).toBe(0);
    expect(afterSecond).toHaveLength(MINIMUM_PROFILE_COUNT);
  });
});
