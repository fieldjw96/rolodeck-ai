// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SECTOR_VALUES } from "./profile-input";

/**
 * Exercises migration `0003_sector_controlled_vocabulary` on its own, against a database that
 * still holds the free text `sector` used to carry — the situation the real Supabase database
 * is in the moment before this migration runs there. `db/testing/scratch-db.ts` cannot stand in
 * for this: it applies every migration to an empty table, which never puts a row through this
 * one's backfill at all.
 */

const SHIM_PATH = fileURLToPath(
  new URL("./testing/supabase-shim.sql", import.meta.url),
);
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

const PRE_SECTOR_MIGRATIONS = [
  "0000_profiles.sql",
  "0001_swipes.sql",
  "0002_profile_natural_key.sql",
];

const SECTOR_MIGRATION = "0003_sector_controlled_vocabulary.sql";

const OWNER = "11111111-1111-1111-1111-111111111111";

const PROVENANCE = JSON.stringify({
  name: "scraped",
  description: "scraped",
  sector: "scraped",
  stage: "scraped",
  website: null,
});

/** Every legacy raw value the Ticket's Notes name, and the canonical Sector each should land
 * on, plus one value no Source ever produced, to prove the backfill's catch-all works too. */
const LEGACY_SECTORS: ReadonlyArray<readonly [string, string]> = [
  ["Artificial Intelligence", "ai-ml"],
  ["Machine Learning", "ai-ml"],
  ["Developer Tools", "developer-tools"],
  ["Data Infrastructure", "data-infrastructure"],
  ["SaaS", "saas-enterprise"],
  ["Enterprise Software", "saas-enterprise"],
  ["Fintech", "fintech"],
  ["Health Tech", "health-bio"],
  ["Security & Compliance", "security"],
  ["Robotics", "hardware-robotics"],
  ["Climate Technology", "climate-energy"],
  ["Marketplace", "consumer-marketplace"],
  ["HR Technology", "vertical-saas"],
  ["Nonprofit", "other"],
  ["Something no Source has ever produced", "other"],
];

/**
 * `--> statement-breakpoint` is drizzle-kit's own marker, not SQL — but it starts with `--`,
 * so Postgres reads it as an ordinary line comment, and a migration file can be handed to
 * `exec` whole rather than split apart.
 */
async function applyRawMigration(
  client: PGlite,
  filename: string,
): Promise<void> {
  const sql = await readFile(`${MIGRATIONS_FOLDER}/${filename}`, "utf8");
  await client.exec(sql);
}

describe("migration 0003_sector_controlled_vocabulary", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readFile(SHIM_PATH, "utf8"));

    for (const migration of PRE_SECTOR_MIGRATIONS) {
      await applyRawMigration(client, migration);
    }

    await client.query("insert into auth.users (id) values ($1)", [OWNER]);

    for (const [index, [raw]] of LEGACY_SECTORS.entries()) {
      await client.query(
        `insert into profiles (owner_id, source, name, description, sector, stage, provenance)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          OWNER,
          "test",
          `Legacy Co ${index}`,
          "Pre-migration free-text sector.",
          raw,
          "seed",
          PROVENANCE,
        ],
      );
    }

    await applyRawMigration(client, SECTOR_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("maps every legacy row onto the Sector each raw value's Notes entry names", async () => {
    const { rows } = await client.query<{ name: string; sector: string }>(
      "select name, sector from profiles order by name",
    );

    const bySector = new Map(rows.map((row) => [row.name, row.sector]));

    for (const [index, [, expected]] of LEGACY_SECTORS.entries()) {
      expect(bySector.get(`Legacy Co ${index}`)).toBe(expected);
    }
  });

  it("leaves no row outside the twelve controlled values", async () => {
    const literals = SECTOR_VALUES.map((value) => `'${value}'`).join(", ");
    const { rows } = await client.query<{ count: number }>(
      `select count(*)::int as count from profiles where sector not in (${literals})`,
    );

    expect(rows[0]?.count).toBe(0);
  });

  it("adds a check constraint that now rejects an off-list sector", async () => {
    let constraint: string | undefined;

    try {
      await client.query(
        `insert into profiles (owner_id, source, name, description, sector, stage, provenance)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          OWNER,
          "test",
          "Post-migration Co",
          "Should be rejected.",
          "Robotics",
          "seed",
          PROVENANCE,
        ],
      );
    } catch (error) {
      constraint = (error as { constraint?: string }).constraint;
    }

    expect(constraint).toBe("profiles_sector_is_controlled");
  });
});
