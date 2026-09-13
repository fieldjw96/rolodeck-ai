// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Exercises migration `0004_company_profile_location` on its own, against a database that
 * still has no `location` column at all — the situation the real Supabase database is in the
 * moment before this migration runs there. `db/testing/scratch-db.ts` cannot stand in for
 * this: it applies every migration to an empty table, which never puts a row through this
 * one's backfill.
 */

const SHIM_PATH = fileURLToPath(
  new URL("./testing/supabase-shim.sql", import.meta.url),
);
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

const PRE_LOCATION_MIGRATIONS = [
  "0000_profiles.sql",
  "0001_swipes.sql",
  "0002_profile_natural_key.sql",
  "0003_sector_controlled_vocabulary.sql",
];

const LOCATION_MIGRATION = "0004_company_profile_location.sql";

const OWNER = "11111111-1111-1111-1111-111111111111";

/** Every field's provenance, in the shape the pre-migration constraint requires: no
 * `location` key at all, since the column it would describe does not exist yet. */
const PRE_MIGRATION_PROVENANCE = JSON.stringify({
  name: "scraped",
  description: "scraped",
  sector: "scraped",
  stage: "scraped",
  website: null,
});

async function applyRawMigration(
  client: PGlite,
  filename: string,
): Promise<void> {
  const sql = await readFile(`${MIGRATIONS_FOLDER}/${filename}`, "utf8");
  await client.exec(sql);
}

async function insertPreMigrationRow(
  client: PGlite,
  {
    source,
    name,
    description,
  }: { source: string; name: string; description: string },
): Promise<void> {
  await client.query(
    `insert into profiles (owner_id, source, name, description, sector, stage, provenance)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      OWNER,
      source,
      name,
      description,
      "fintech",
      "seed",
      PRE_MIGRATION_PROVENANCE,
    ],
  );
}

describe("migration 0004_company_profile_location", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readFile(SHIM_PATH, "utf8"));

    for (const migration of PRE_LOCATION_MIGRATIONS) {
      await applyRawMigration(client, migration);
    }

    await client.query("insert into auth.users (id) values ($1)", [OWNER]);

    // A sec-form-d row whose description states a city, composed exactly as
    // `lib/ingest/sec-form-d.ts`'s `describeOffering` writes it.
    await insertPreMigrationRow(client, {
      source: "sec-form-d",
      name: "With City Co",
      description:
        "Fintech issuer in San Francisco, CA. Raising $500,000 in a private placement.",
    });

    // A sec-form-d row whose filing named no city, so the sentence names the state alone.
    await insertPreMigrationRow(client, {
      source: "sec-form-d",
      name: "State Only Co",
      description: "Other issuer in CA.",
    });

    // A row from a Source whose stored fields never state where the company is.
    await insertPreMigrationRow(client, {
      source: "yc",
      name: "No Location Co",
      description: "Widgets, but faster.",
    });

    // A sec-form-d row whose city itself contains a period — "St. Helena" is a Bay Area city
    // per lib/location/bay-area.ts — the case a naive "stop at the first period" regex
    // truncates into a wrong, invented location.
    await insertPreMigrationRow(client, {
      source: "sec-form-d",
      name: "Period In City Co",
      description:
        "Fintech issuer in St. Helena, CA. Raising $500,000 in a private placement.",
    });

    await applyRawMigration(client, LOCATION_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("extracts the city and state a sec-form-d row's description already states", async () => {
    const { rows } = await client.query<{
      location: string | null;
      provenance: { location: string | null };
    }>("select location, provenance from profiles where name = $1", [
      "With City Co",
    ]);

    expect(rows[0]?.location).toBe("San Francisco, CA");
    expect(rows[0]?.provenance.location).toBe("scraped");
  });

  it("extracts a state-only location when the filing named no city", async () => {
    const { rows } = await client.query<{ location: string | null }>(
      "select location from profiles where name = $1",
      ["State Only Co"],
    );

    expect(rows[0]?.location).toBe("CA");
  });

  it("extracts the full city and state when the city name itself contains a period", async () => {
    const { rows } = await client.query<{
      location: string | null;
      provenance: { location: string | null };
    }>("select location, provenance from profiles where name = $1", [
      "Period In City Co",
    ]);

    expect(rows[0]?.location).toBe("St. Helena, CA");
    expect(rows[0]?.provenance.location).toBe("scraped");
  });

  it("leaves a row from a Source that never stated a location null, rather than inventing one", async () => {
    const { rows } = await client.query<{
      location: string | null;
      provenance: { location: string | null };
    }>("select location, provenance from profiles where name = $1", [
      "No Location Co",
    ]);

    expect(rows[0]?.location).toBeNull();
    // Untouched by the migration: no `location` key was added to this row's provenance at
    // all, which is exactly what the check constraint treats as equivalent to null.
    expect(rows[0]?.provenance.location).toBeUndefined();
  });

  it("adds a check constraint that a Profile whose location is unknown still satisfies", async () => {
    let constraint: string | undefined;

    try {
      await client.query(
        `insert into profiles (owner_id, source, name, description, sector, stage, location, provenance)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          OWNER,
          "test",
          "Unknown Location Co",
          "No location stated.",
          "fintech",
          "seed",
          null,
          JSON.stringify({
            ...JSON.parse(PRE_MIGRATION_PROVENANCE),
            location: null,
          }),
        ],
      );
    } catch (error) {
      constraint = (error as { constraint?: string }).constraint;
    }

    expect(constraint).toBeUndefined();
  });

  it("rejects a location left unattributed, even after the migration", async () => {
    let constraint: string | undefined;

    try {
      await client.query(
        `insert into profiles (owner_id, source, name, description, sector, stage, location, provenance)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          OWNER,
          "test",
          "Unattributed Location Co",
          "States a location without attributing it.",
          "fintech",
          "seed",
          "Oakland, CA",
          PRE_MIGRATION_PROVENANCE,
        ],
      );
    } catch (error) {
      constraint = (error as { constraint?: string }).constraint;
    }

    expect(constraint).toBe("profiles_provenance_covers_every_field");
  });
});
