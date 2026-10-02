// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Exercises migration `0015_backfill_user_profiles` against a database that already holds
 * `auth.users` rows from before the first-run screen existed — the situation the real project
 * is in the moment before this migration runs there. `db/testing/scratch-db.ts` cannot stand
 * in for this: it applies every migration to an empty database, so no `auth.users` row ever
 * predates this one there, and the backfill always runs over nothing.
 */

const SHIM_PATH = fileURLToPath(
  new URL("./testing/supabase-shim.sql", import.meta.url),
);
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

const BACKFILL_MIGRATION = "0015_backfill_user_profiles.sql";

const JACK = "11111111-1111-1111-1111-111111111111";
const SMOKE_ACCOUNT = "22222222-2222-2222-2222-222222222222";
const ALREADY_ASKED = "33333333-3333-3333-3333-333333333333";

async function apply(client: PGlite, filename: string): Promise<void> {
  await client.exec(await readFile(`${MIGRATIONS_FOLDER}/${filename}`, "utf8"));
}

async function profileRows(
  client: PGlite,
): Promise<{ userId: string; sectors: string[]; area: string | null }[]> {
  const { rows } = await client.query<{
    user_id: string;
    sectors: string[];
    area: string | null;
  }>('select user_id, sectors, area from "user_profiles" order by user_id');

  return rows.map((row) => ({
    userId: row.user_id,
    sectors: row.sectors,
    area: row.area,
  }));
}

describe("migration 0015_backfill_user_profiles", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readFile(SHIM_PATH, "utf8"));

    // Every migration up to but not including this Ticket's, in order — the real project's
    // shape the moment before this one runs there.
    const earlier = (await readdir(MIGRATIONS_FOLDER))
      .filter((name) => name.endsWith(".sql") && name < BACKFILL_MIGRATION)
      .sort();
    for (const filename of earlier) {
      await apply(client, filename);
    }

    // JACK and SMOKE_ACCOUNT predate the first-run screen: no user_profiles row at all.
    // ALREADY_ASKED has been through it already, with a stated preference that must survive.
    await client.query("insert into auth.users (id) values ($1), ($2), ($3)", [
      JACK,
      SMOKE_ACCOUNT,
      ALREADY_ASKED,
    ]);
    await client.query(
      `insert into "user_profiles" ("user_id", "sectors", "area") values ($1, $2, $3)`,
      [ALREADY_ASKED, ["fintech"], "Bay Area"],
    );

    await apply(client, BACKFILL_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("writes an empty row for every account that predates the first-run screen", async () => {
    const rows = await profileRows(client);

    expect(rows).toEqual([
      { userId: JACK, sectors: [], area: null },
      { userId: SMOKE_ACCOUNT, sectors: [], area: null },
      { userId: ALREADY_ASKED, sectors: ["fintech"], area: "Bay Area" },
    ]);
  });

  it("leaves the account that already stated preferences untouched", async () => {
    const rows = await profileRows(client);
    const already = rows.find((row) => row.userId === ALREADY_ASKED);

    expect(already).toEqual({
      userId: ALREADY_ASKED,
      sectors: ["fintech"],
      area: "Bay Area",
    });
  });

  it("is idempotent: running it again writes no further rows", async () => {
    const before = await profileRows(client);

    await apply(client, BACKFILL_MIGRATION);

    const after = await profileRows(client);
    expect(after).toEqual(before);
  });
});
