// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  measureProfileDuplicates,
  readOnly,
} from "./measure-profile-duplicates";
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
    expect(stats.profilesInMultipleSources).toBe(2);
    expect(stats.percentageInMultipleSources).toBe(100);
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
    expect(stats.profilesInMultipleSources).toBe(3);
    expect(stats.percentageInMultipleSources).toBe(100);
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

  it("uses the ingest connection read-only: no writes occur", async () => {
    // Insert test data as superuser
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

    // The ingest role can SELECT, INSERT and UPDATE profiles (ADR 0013). The report must still
    // read correctly through it, which is what this half proves.
    await scratch.as("rolodeck_ingest");

    const stats = await measureProfileDuplicates(scratch.db, JACK);
    expect(stats.totalProfiles).toBe(2);
    expect(stats.profilesInMultipleSources).toBe(2);
  });

  /**
   * The criterion as written, and the one the previous version of this test only claimed to
   * meet. That test ran the report and checked the rows did not change, which proves the
   * current code happens not to write, not that it cannot. The ingest role is allowed to write
   * profiles, so nothing about the connection stopped a write either.
   *
   * This attempts one, as the same role, through the same read-only wrapper the report uses,
   * and requires Postgres to refuse it.
   */
  it("refuses a write made through the report's read-only transaction, even as the ingest role", async () => {
    await scratch.as("rolodeck_ingest");

    // Drizzle wraps the driver error as "Failed query: ...", so the Postgres reason is on
    // `cause`. Asserting on the reason rather than on "it threw" matters here: an insert can
    // also fail on a constraint, and a test that accepted any failure would pass for the
    // wrong reason while proving nothing about read-only.
    const refusal = await readOnly(scratch.db, (tx) =>
      tx.insert(profiles).values({
        ownerId: JACK,
        source: "yc",
        name: "Should Never Land",
        description: "A write the report must not be able to make",
        sector: "other",
        stage: "seed",
        website: null,
        location: null,
        provenance: {
          name: "scraped",
          description: "scraped",
          sector: "scraped",
          stage: "scraped",
          website: null,
          location: null,
        },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(
      refusal,
      "the write went through, so the transaction was not read-only",
    ).not.toBeNull();
    const reason = String(
      ((refusal as { cause?: { message?: unknown } }).cause?.message ??
        (refusal as Error).message) as string,
    );
    expect(reason).toMatch(/read-only transaction/);

    const rows = await scratch.db.select().from(profiles);
    expect(rows.find((r) => r.name === "Should Never Land")).toBeUndefined();
  });

  // Guards the guard: without this, a readOnly() that silently stopped setting the transaction
  // read-only would leave the refusal test above as the only signal, and a broken wrapper
  // around a test that never writes would pass everything.
  it("still lets the same role write outside the read-only wrapper", async () => {
    await scratch.as("rolodeck_ingest");
    // A plain await: if the role could not write at all, this throws and the test fails, which
    // is the point. `expect(promise).resolves.not.toThrow()` would not have caught that, since
    // `toThrow` expects a function and a resolved insert result is not one.
    await scratch.db.insert(profiles).values({
      ownerId: JACK,
      source: "yc",
      name: "Written Outside The Wrapper",
      description:
        "Proves the refusal above comes from READ ONLY, not from missing grants",
      sector: "other",
      stage: "seed",
      website: null,
      location: null,
      provenance: {
        name: "scraped",
        description: "scraped",
        sector: "scraped",
        stage: "scraped",
        website: null,
        location: null,
      },
    });

    const rows = await scratch.db.select().from(profiles);
    expect(
      rows.find((r) => r.name === "Written Outside The Wrapper"),
    ).toBeDefined();
  });
});
