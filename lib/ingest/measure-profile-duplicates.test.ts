// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { measureProfileDuplicates } from "./measure-profile-duplicates";
import { profiles } from "../../db/schema";
import { createScratchDb, type ScratchDb } from "../../db/testing/scratch-db";

const JACK = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "22222222-2222-2222-2222-222222222222";

let scratch: ScratchDb;

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(OTHER_OWNER);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
});

beforeEach(async () => {
  await scratch.reset();
  await scratch.db.delete(profiles);
});

describe("measureProfileDuplicates", () => {
  it("finds companies that appear under multiple sources with the same name_key", async () => {
    // Insert the same company from two different sources
    await scratch.db.insert(profiles).values([
      {
        ownerId: JACK,
        source: "yc",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
      {
        ownerId: JACK,
        source: "sec-form-d",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
    ]);

    const stats = await measureProfileDuplicates(scratch.db, JACK);

    expect(stats.totalProfiles).toBe(2);
    expect(stats.profilesInMultipleSources).toBe(1);
    expect(stats.percentageInMultipleSources).toBe(50);
    expect(stats.worstOffenders).toHaveLength(1);
    expect(stats.worstOffenders[0]).toEqual({
      nameKey: "acme corp",
      sources: expect.arrayContaining(["yc", "sec-form-d"]),
      count: 2,
    });
  });

  it("does not find different companies as duplicates", async () => {
    await scratch.db.insert(profiles).values([
      {
        ownerId: JACK,
        source: "yc",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
      {
        ownerId: JACK,
        source: "sec-form-d",
        name: "Bravo Systems",
        description: "Another company",
        sector: "ai-ml",
        stage: "growth",
        website: "https://bravo.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
    ]);

    const stats = await measureProfileDuplicates(scratch.db, JACK);

    expect(stats.totalProfiles).toBe(2);
    expect(stats.profilesInMultipleSources).toBe(0);
    expect(stats.percentageInMultipleSources).toBe(0);
    expect(stats.worstOffenders).toHaveLength(0);
  });

  it("finds companies differing only in case or whitespace as duplicates", async () => {
    // These all normalize to the same name_key
    await scratch.db.insert(profiles).values([
      {
        ownerId: JACK,
        source: "yc",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
      {
        ownerId: JACK,
        source: "sec-form-d",
        name: "ACME CORP", // Different case
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
      {
        ownerId: JACK,
        source: "show-hn",
        name: "Acme   Corp", // Extra whitespace
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
    ]);

    const stats = await measureProfileDuplicates(scratch.db, JACK);

    expect(stats.totalProfiles).toBe(3);
    expect(stats.profilesInMultipleSources).toBe(1);
    expect(stats.percentageInMultipleSources).toBeCloseTo(33.33, 1);
    expect(stats.worstOffenders).toHaveLength(1);
    expect(stats.worstOffenders[0]?.nameKey).toBe("acme corp");
    expect(stats.worstOffenders[0]?.count).toBe(3);
  });

  it("reports zero duplicates when all companies have unique names", async () => {
    await scratch.db.insert(profiles).values([
      {
        ownerId: JACK,
        source: "yc",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
      {
        ownerId: JACK,
        source: "yc",
        name: "Bravo Systems",
        description: "Another company",
        sector: "ai-ml",
        stage: "growth",
        website: "https://bravo.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
    ]);

    const stats = await measureProfileDuplicates(scratch.db, JACK);

    expect(stats.totalProfiles).toBe(2);
    expect(stats.profilesInMultipleSources).toBe(0);
    expect(stats.percentageInMultipleSources).toBe(0);
    expect(stats.worstOffenders).toHaveLength(0);
  });

  it("handles empty database", async () => {
    const stats = await measureProfileDuplicates(scratch.db, JACK);

    expect(stats.totalProfiles).toBe(0);
    expect(stats.profilesInMultipleSources).toBe(0);
    expect(stats.percentageInMultipleSources).toBe(0);
    expect(stats.worstOffenders).toHaveLength(0);
  });

  it("scopes results to the specified owner", async () => {
    await scratch.db.insert(profiles).values([
      {
        ownerId: JACK,
        source: "yc",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
      {
        ownerId: OTHER_OWNER,
        source: "yc",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
    ]);

    const stats = await measureProfileDuplicates(scratch.db, JACK);

    expect(stats.totalProfiles).toBe(1);
    expect(stats.profilesInMultipleSources).toBe(0);
  });

  it("never modifies the database", async () => {
    // Insert test data
    await scratch.db.insert(profiles).values([
      {
        ownerId: JACK,
        source: "yc",
        name: "Acme Corp",
        description: "A company",
        sector: "saas-enterprise",
        stage: "seed",
        website: "https://acme.example",
        location: "San Francisco, CA",
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "enriched",
          website: "scraped",
          location: "scraped",
        },
      },
    ]);

    // Get row count before
    const rowsBefore = await scratch.db.select().from(profiles);
    const countBefore = rowsBefore.length;

    // Run the analysis
    await measureProfileDuplicates(scratch.db, JACK);

    // Verify no rows were added/deleted
    const rowsAfter = await scratch.db.select().from(profiles);
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.length).toBe(countBefore);
  });
});
