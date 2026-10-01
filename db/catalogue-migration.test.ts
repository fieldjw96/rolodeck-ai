// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDeckPage, DEFAULT_PAGE_SIZE } from "./deck";
import { asUser } from "./rls";
import * as schema from "./schema";

/**
 * Migration `0013_shared_catalogue` against a database that still has `owner_id` on all four
 * tables and rows under two different accounts — the situation the real project is in the
 * moment before it runs. `db/testing/scratch-db.ts` cannot stand in for this: it applies every
 * migration to an empty database, so nothing of this migration's data half ever happens there.
 *
 * The last test is the one this Ticket exists for: a second signed-in User, who before this
 * migration saw an empty Deck and no error, now deals the same Catalogue as the first.
 */

const SHIM_PATH = fileURLToPath(
  new URL("./testing/supabase-shim.sql", import.meta.url),
);
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

const PROVENANCE = JSON.stringify({
  name: "scraped",
  description: "scraped",
  sector: "scraped",
  stage: "scraped",
  website: null,
  location: null,
  founders: null,
  links: null,
});

const CATALOGUE_TABLES = [
  "profiles",
  "news_items",
  "events",
  "event_attendances",
] as const;

let client: PGlite;
let before: Record<string, number>;
let after: Record<string, number>;

async function apply(filename: string): Promise<void> {
  await client.exec(await readFile(`${MIGRATIONS_FOLDER}/${filename}`, "utf8"));
}

async function counts(): Promise<Record<string, number>> {
  const tallied: Record<string, number> = {};

  for (const table of [...CATALOGUE_TABLES, "swipes"]) {
    const { rows } = await client.query<{ total: number }>(
      `select count(*)::int as total from ${table}`,
    );
    tallied[table] = rows[0]!.total;
  }

  return tallied;
}

/** A Company Profile under `owner`, in the pre-migration shape. Returns its id. */
async function company(
  owner: string,
  source: string,
  name: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into profiles (owner_id, source, name, description, sector, stage, provenance)
     values ($1, $2, $3, $4, 'fintech', 'seed', $5) returning id`,
    [
      owner,
      source,
      name,
      `${name}, before the Catalogue was shared.`,
      PROVENANCE,
    ],
  );

  return rows[0]!.id;
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(await readFile(SHIM_PATH, "utf8"));

  // Every migration up to but not including this Ticket's, in order.
  const earlier = (await readdir(MIGRATIONS_FOLDER))
    .filter((name) => name.endsWith(".sql") && name < "0013")
    .sort();
  for (const filename of earlier) {
    await apply(filename);
  }

  await client.query("insert into auth.users (id) values ($1), ($2)", [
    JACK,
    SOMEONE_ELSE,
  ]);

  const jacksSprocket = await company(JACK, "yc", "Sprocket");
  await company(JACK, "yc", "Quiet Co");
  // The same company under the same Source, held by the other account: the one shape the old
  // key permitted and the new one does not.
  const theirSprocket = await company(SOMEONE_ELSE, "yc", "Sprocket");

  await client.query(
    "insert into swipes (user_id, profile_id, decision) values ($1, $2, 'keep'), ($3, $4, 'keep')",
    [JACK, jacksSprocket, SOMEONE_ELSE, theirSprocket],
  );
  await client.query(
    `insert into news_items (owner_id, profile_id, title, url, published_at, source_name, confidence)
     values ($1, $2, 'Sprocket raises', 'https://news.example/sprocket', now(), 'The Example Times', 0.9)`,
    [JACK, jacksSprocket],
  );
  const { rows: eventRows } = await client.query<{ id: string }>(
    `insert into events (owner_id, source, external_id, name, start_date, url)
     values ($1, 'luma', 'summit@example.com', 'Sprocket Summit', '2026-10-01', 'https://example.com/summit')
     returning id`,
    [JACK],
  );
  await client.query(
    "insert into event_attendances (event_id, profile_id) values ($1, $2)",
    [eventRows[0]!.id, jacksSprocket],
  );

  before = await counts();
  await apply("0013_shared_catalogue.sql");
  after = await counts();
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("migration 0013_shared_catalogue", () => {
  it("collapses the one pair of Company Profiles two accounts both held, and nothing else", () => {
    expect(before["profiles"]).toBe(3);
    expect(after["profiles"]).toBe(2);
  });

  it("keeps every Keep, including the one repointed at the surviving row", () => {
    expect(after["swipes"]).toBe(before["swipes"]);
  });

  it("deletes no News, Event or Attendance", () => {
    expect(after["news_items"]).toBe(before["news_items"]);
    expect(after["events"]).toBe(before["events"]);
    expect(after["event_attendances"]).toBe(before["event_attendances"]);
  });

  it("leaves no owner_id on any Catalogue table", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select c.relname as table_name
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and a.attname = 'owner_id' and not a.attisdropped`,
    );

    expect(rows).toEqual([]);
  });

  /** The Acceptance Criterion this Ticket exists for. */
  it("deals a second signed-in User a Deck that is not empty", async () => {
    const db = drizzle(client, { schema });

    const theirs = await asUser(db, SOMEONE_ELSE, (tx) =>
      readDeckPage(tx, { userId: SOMEONE_ELSE, limit: DEFAULT_PAGE_SIZE }),
    );

    // Two Company Profiles in the Catalogue; this User has Kept one, so one is left to deal.
    expect(theirs.profiles.map((profile) => profile.name)).toEqual([
      "Quiet Co",
    ]);

    const jacks = await asUser(db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );
    expect(jacks.profiles.map((profile) => profile.name)).toEqual(["Quiet Co"]);
  });
});
