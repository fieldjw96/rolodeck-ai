// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { INGEST_ROLE } from "../lib/ingest/env";
import type { NewsFeedClient } from "../lib/news/feed-fetch";
import { fetchNewsForTheCatalogue } from "../lib/news/run";
import type { EventInput } from "./event-input";
import { persistEvents } from "./events";
import { persistProfiles, type ProfileCandidate } from "./ingest";
import {
  eventAttendances,
  events,
  ingestRole,
  newsArticles,
  newsItems,
  newsProfileCoverage,
  newsProfileSiteRecovery,
  profiles,
  swipes,
  userProfiles,
} from "./schema";
import { backfillSeedProfiles, MINIMUM_PROFILE_COUNT } from "./seed";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";

/**
 * The ingest role's grants, asserted from both sides: everything ingest actually does succeeds
 * as that role, and everything it has no business doing fails. See docs/adr/0013. A grant that
 * was never checked is a grant nobody knows the shape of — and the failure mode here is a
 * credential that looks scoped and is not — so every refusal below is Postgres's own
 * "permission denied", never merely an empty result.
 */

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

const ROLE_CHECK_PATH = fileURLToPath(
  new URL("./testing/ingest-role-check.sql", import.meta.url),
);

const candidate = (name: string): ProfileCandidate => ({
  input: {
    name,
    description: `${name}, for the ingest role tests.`,
    sector: "developer-tools",
    stage: "seed",
  },
  provenance: {
    name: "scraped",
    description: "scraped",
    sector: "scraped",
    stage: "enriched",
    website: null,
    location: null,
    founders: null,
    links: null,
  },
});

let scratch: ScratchDb;

/** A Company Profile in the Catalogue, arranged as the superuser. Returns its id. */
async function companyProfile(name: string): Promise<string> {
  const [row] = await scratch.db
    .insert(profiles)
    .values({
      ...candidate(name).input,
      source: "seed",
      website: null,
      provenance: candidate(name).provenance,
    })
    .returning({ id: profiles.id });

  return row!.id;
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
  await scratch.db.delete(eventAttendances);
  await scratch.db.delete(events);
  await scratch.db.delete(newsItems);
  await scratch.db.delete(newsArticles);
  await scratch.db.delete(newsProfileCoverage);
  await scratch.db.delete(newsProfileSiteRecovery);
  await scratch.db.delete(swipes);
  await scratch.db.delete(userProfiles);
  await scratch.db.delete(profiles);
});

describe("the ingest role itself", () => {
  it("is the role the schema declares and the connection string must log in as", () => {
    expect(ingestRole.name).toBe(INGEST_ROLE);
  });

  it("is not a superuser, cannot create roles or databases, cannot replicate, and does not bypass RLS", async () => {
    const { rows } = await scratch.client.query(
      "select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname = $1",
      [INGEST_ROLE],
    );

    expect(rows).toEqual([
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcanlogin: true,
      },
    ]);
  });

  it("is a member of no other role, so it inherits nothing and can SET ROLE into nothing", async () => {
    const { rows } = await scratch.client.query(
      "select roleid::regrole::text as role from pg_auth_members where member = $1::regrole",
      [INGEST_ROLE],
    );

    expect(rows).toEqual([]);
  });

  it("holds exactly these table grants and no others, anywhere", async () => {
    const { rows } = await scratch.client.query(
      `select n.nspname || '.' || c.relname as "table", a.privilege_type as privilege
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) a
        where a.grantee = $1::regrole
        order by 1, 2`,
      [INGEST_ROLE],
    );

    expect(rows).toEqual([
      { table: "public.event_attendances", privilege: "DELETE" },
      { table: "public.event_attendances", privilege: "INSERT" },
      { table: "public.event_attendances", privilege: "SELECT" },
      { table: "public.events", privilege: "INSERT" },
      { table: "public.events", privilege: "SELECT" },
      { table: "public.news_articles", privilege: "INSERT" },
      { table: "public.news_articles", privilege: "SELECT" },
      { table: "public.news_items", privilege: "INSERT" },
      { table: "public.news_items", privilege: "SELECT" },
      { table: "public.news_profile_coverage", privilege: "INSERT" },
      { table: "public.news_profile_coverage", privilege: "SELECT" },
      { table: "public.news_profile_site_recovery", privilege: "INSERT" },
      { table: "public.news_profile_site_recovery", privilege: "SELECT" },
      { table: "public.profiles", privilege: "INSERT" },
      { table: "public.profiles", privilege: "SELECT" },
    ]);
  });

  it("may update every column of its tables but id, and nothing else by column", async () => {
    const { rows } = await scratch.client.query(
      `select n.nspname || '.' || c.relname as "table",
              x.privilege_type as privilege,
              array_agg(a.attname::text order by a.attname) as columns
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
         cross join lateral aclexplode(a.attacl) x
        where x.grantee = $1::regrole
        group by 1, 2
        order by 1, 2`,
      [INGEST_ROLE],
    );

    expect(rows).toEqual([
      {
        table: "public.event_attendances",
        privilege: "UPDATE",
        columns: ["event_id", "profile_id"],
      },
      {
        table: "public.events",
        privilege: "UPDATE",
        columns: [
          "created_at",
          "end_date",
          "external_id",
          "location",
          "name",
          "source",
          "start_date",
          "url",
        ],
      },
      {
        table: "public.news_articles",
        privilege: "UPDATE",
        // Not `url`, which is this table's key, not `searched_for_profile_id`, which says
        // which Company Profile's search stored the row (docs/adr/0024), and not `fetched_at`,
        // which records when the article was first read. See migrations 0016 and 0017.
        columns: ["description", "published_at", "source_name", "title"],
      },
      {
        table: "public.news_items",
        privilege: "UPDATE",
        columns: [
          "confidence",
          "description",
          "fetched_at",
          "profile_id",
          "published_at",
          "source_name",
          "title",
          "url",
        ],
      },
      {
        table: "public.profiles",
        privilege: "UPDATE",
        columns: [
          "created_at",
          "description",
          "founders",
          "founders_sought_at",
          "links",
          "location",
          "name",
          "name_key",
          "provenance",
          "sector",
          "source",
          "stage",
          "website",
        ],
      },
    ]);
  });
});

describe("logged in as the ingest role", () => {
  /**
   * A database of its own, logged in as the ingest role for good — the way a real connection
   * with `ROLODECK_INGEST_DATABASE_URL` is. Not `scratch.as()`, which only changes the current
   * user: a session that began as the superuser can still `set role` to anyone, so it would
   * wave through the one escape below that matters most. PGlite cannot hand a session back once
   * its authorization has changed, which is why this does not share `scratch`.
   */
  let session: ScratchDb;
  let keptProfileId: string;

  /** Runs `statement` and returns the error Postgres raised, or null if it succeeded. */
  async function refusal(
    statement: string,
    params: unknown[] = [],
  ): Promise<string | null> {
    try {
      await session.client.query(statement, params);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  beforeAll(async () => {
    session = await createScratchDb();
    await session.createUser(JACK);

    const [row] = await session.db
      .insert(profiles)
      .values({
        ...candidate("Sprocket").input,
        source: "seed",
        website: null,
        provenance: candidate("Sprocket").provenance,
      })
      .returning({ id: profiles.id });
    keptProfileId = row!.id;
    await session.db
      .insert(swipes)
      .values({ userId: JACK, profileId: keptProfileId, decision: "keep" });
    await session.db.insert(userProfiles).values({ userId: JACK });

    await session.client.exec(`set session authorization ${INGEST_ROLE}`);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
  });

  it("really is the ingest role, and can do what it is for — so every refusal below is a refusal", async () => {
    const { rows } = await session.client.query(
      "select current_user, session_user",
    );
    expect(rows).toEqual([
      { current_user: INGEST_ROLE, session_user: INGEST_ROLE },
    ]);

    expect(await refusal("select id from profiles")).toBeNull();
    expect(await refusal("select url from news_articles")).toBeNull();
    expect(
      await refusal("select profile_id from news_profile_coverage"),
    ).toBeNull();
    expect(
      await refusal("select profile_id from news_profile_site_recovery"),
    ).toBeNull();
  });

  // The function News asked which Company Profiles one User had Kept. Nothing asks now that
  // News gathers for the whole Catalogue, so migration 0016 dropped it and the schema it lived
  // in — which is ADR 0013's second deferred risk closed. See docs/adr/0022.
  it("cannot call ingest.kept_profile_ids, because there is no such function to call", async () => {
    expect(
      await refusal("select * from ingest.kept_profile_ids($1)", [JACK]),
      // Postgres resolves the schema before the function, so either half being gone is a
      // "does not exist" rather than a permission denied.
    ).toMatch(/does not exist/);
    expect(
      (
        await session.client.query(
          "select to_regprocedure('ingest.kept_profile_ids(uuid)') is null as gone",
        )
      ).rows,
    ).toEqual([{ gone: true }]);
  });

  it("cannot write to swipes", async () => {
    expect(
      await refusal(
        "insert into swipes (user_id, profile_id, decision) values ($1, $2, 'pass')",
        [JACK, keptProfileId],
      ),
    ).toMatch(/permission denied for table swipes/);
  });

  it("cannot read, update or delete swipes either", async () => {
    expect(await refusal("select * from swipes")).toMatch(
      /permission denied for table swipes/,
    );
    expect(await refusal("update swipes set decision = 'pass'")).toMatch(
      /permission denied for table swipes/,
    );
    expect(await refusal("delete from swipes")).toMatch(
      /permission denied for table swipes/,
    );
  });

  it("cannot read auth.users", async () => {
    expect(await refusal("select id from auth.users")).toMatch(
      /permission denied/,
    );
  });

  it("cannot write auth.users", async () => {
    expect(
      await refusal("insert into auth.users (id) values ($1)", [
        "33333333-3333-3333-3333-333333333333",
      ]),
    ).toMatch(/permission denied/);
  });

  it("cannot read or write user_profiles", async () => {
    expect(await refusal("select * from user_profiles")).toMatch(
      /permission denied for table user_profiles/,
    );
    expect(await refusal("update user_profiles set area = 'Anywhere'")).toMatch(
      /permission denied for table user_profiles/,
    );
  });

  // There is no `owner_id` on any Catalogue table to move a row by any more (docs/adr/0019),
  // so the column grants that stood between ingest and that move now stand between it and the
  // only other column it must not write: the row's own id, below. Correcting a row is still
  // the thing ingest is for.
  it("can still correct a Company Profile", async () => {
    expect(
      await refusal("update profiles set description = $1 where id = $2", [
        "Sprocket, corrected by ingest.",
        keptProfileId,
      ]),
    ).toBeNull();
    const { rows } = await session.client.query(
      "select description from profiles where id = $1",
      [keptProfileId],
    );
    expect(rows).toEqual([{ description: "Sprocket, corrected by ingest." }]);
  });

  it.each(["profiles", "news_items", "events"])(
    "has no owner column on %s to write at all",
    async (table) => {
      expect(
        await refusal(`update ${table} set owner_id = $1`, [JACK]),
      ).toMatch(/column "owner_id" of relation .* does not exist/);
    },
  );

  it.each(["profiles", "news_items", "events"])(
    "cannot change the id of a row of %s",
    async (table) => {
      expect(
        await refusal(`update ${table} set id = gen_random_uuid()`),
      ).toMatch(new RegExp(`permission denied for table ${table}`));
    },
  );

  it.each([
    "profiles",
    "news_items",
    "news_articles",
    "news_profile_coverage",
    "news_profile_site_recovery",
    "events",
  ])("cannot delete from %s", async (table) => {
    expect(await refusal(`delete from ${table}`)).toMatch(
      new RegExp(`permission denied for table ${table}`),
    );
  });

  // The two tables ingest may not update at all: a Company Profile is covered once, and
  // re-searched once, and each row says that it happened. See migrations 0016 and 0017.
  it("cannot update news_profile_coverage", async () => {
    expect(
      await refusal("update news_profile_coverage set covered_at = now()"),
    ).toMatch(/permission denied for table news_profile_coverage/);
  });

  it("cannot update news_profile_site_recovery", async () => {
    expect(
      await refusal(
        "update news_profile_site_recovery set recovered_at = now()",
      ),
    ).toMatch(/permission denied for table news_profile_site_recovery/);
  });

  // The column that says which Company Profile's search stored an article. It is written on
  // insert and never again, so an article a feed carried first cannot be narrowed to one
  // company, nor one company's search result widened to the Catalogue. See docs/adr/0024.
  it("cannot update news_articles.searched_for_profile_id", async () => {
    expect(
      await refusal("update news_articles set searched_for_profile_id = null"),
    ).toMatch(/permission denied for table news_articles/);
  });

  // TRUNCATE does not consult RLS at all, so a grant of it would be a bypass with no policy
  // in the way. It is refused even where ingest may delete.
  it.each([
    "profiles",
    "news_items",
    "news_articles",
    "news_profile_coverage",
    "news_profile_site_recovery",
    "events",
    "event_attendances",
  ])("cannot truncate %s", async (table) => {
    expect(await refusal(`truncate ${table} cascade`)).toMatch(
      /permission denied/,
    );
  });

  it.each(["authenticated", "anon", "postgres"])(
    "cannot become %s",
    async (role) => {
      expect(await refusal(`set role ${role}`)).toMatch(
        /permission denied to set role/,
      );
    },
  );

  it("cannot create roles, schemas or tables", async () => {
    expect(await refusal("create role escape login")).toMatch(
      /permission denied/,
    );
    expect(await refusal("create schema escape")).toMatch(/permission denied/);
    expect(await refusal("create table public.escape (id int)")).toMatch(
      /permission denied/,
    );
  });
});

describe("the function that told ingest what was Kept", () => {
  it("is gone, with the schema it lived in, so no role can call it", async () => {
    const { rows } = await scratch.client.query(
      "select to_regprocedure('ingest.kept_profile_ids(uuid)') is null as gone, to_regnamespace('ingest') is null as schema_gone",
    );

    expect(rows).toEqual([{ gone: true, schema_gone: true }]);

    for (const role of ["anon", "authenticated", "rolodeck_ingest"] as const) {
      await scratch.as(role, JACK);

      await expect(
        scratch.client.query("select ingest.kept_profile_ids($1)", [JACK]),
      ).rejects.toThrow(/does not exist/);

      await scratch.reset();
    }
  });
});

describe("what ingest does, as the ingest role", () => {
  it("writes and re-writes Company Profiles into the Catalogue, owned by nobody", async () => {
    await scratch.as("rolodeck_ingest");

    const first = await persistProfiles(scratch.db, {
      source: "seed",
      candidates: [candidate("Sprocket"), candidate("Cog")],
    });
    const second = await persistProfiles(scratch.db, {
      source: "seed",
      candidates: [candidate("Sprocket")],
    });

    await scratch.reset();

    expect(first).toMatchObject({ inserted: 2, updated: 0, rejected: 0 });
    expect(second).toMatchObject({ inserted: 0, updated: 1 });

    const rows = await scratch.db.select().from(profiles);
    expect(rows.map((row) => row.name).sort()).toEqual(["Cog", "Sprocket"]);
  });

  it("tops up the seed Profiles, which counts before it writes", async () => {
    await scratch.as("rolodeck_ingest");
    const result = await backfillSeedProfiles(scratch.db);
    await scratch.reset();

    expect(result.report.inserted).toBe(MINIMUM_PROFILE_COUNT);
  });

  it("writes Events and replaces their Attendance, which is the one delete it may make", async () => {
    await companyProfile("Sprocket");
    await companyProfile("Cog");

    const summit = (attendees: string[]): EventInput => ({
      externalId: "summit@example.com",
      name: "Sprocket Summit",
      startDate: "2026-10-01",
      url: "https://example.com/summit",
      attendees,
    });

    await scratch.as("rolodeck_ingest");
    await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [summit(["Sprocket", "Cog"])],
    });
    const second = await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [summit(["Cog"])],
    });
    await scratch.reset();

    expect(second).toMatchObject({ inserted: 0, updated: 1, attendances: 1 });
    expect(await scratch.db.select().from(eventAttendances)).toHaveLength(1);
  });

  it("stores News for the whole Catalogue, and records coverage, without being able to read swipes", async () => {
    const ramp = await companyProfile("Ramp");
    await companyProfile("Quiet Co");
    // A Keep belonging to the other User. Gathering reads no swipe at all now (docs/adr/0022),
    // so this changes nothing about what the run does — and ingest still cannot see it.
    await scratch.db
      .insert(swipes)
      .values([{ userId: SOMEONE_ELSE, profileId: ramp, decision: "keep" }]);

    const client: NewsFeedClient = {
      get: async () =>
        '<rss version="2.0"><channel><item>' +
        "<title>Ramp raises a round</title>" +
        "<link>https://news.example/ramp</link>" +
        "<pubDate>Tue, 01 Sep 2026 12:00:00 GMT</pubDate>" +
        "</item></channel></rss>",
    };

    await scratch.as("rolodeck_ingest");
    const report = await fetchNewsForTheCatalogue(scratch.db, {
      feeds: [
        {
          name: "wire",
          publication: "The Wire",
          url: "https://news.example/feed.xml",
        },
      ],
      client,
      search: { search: async () => ({ hits: [] }) },
    });
    await scratch.reset();

    expect(report).toMatchObject({
      companies: 2,
      inserted: 1,
      unattributed: 1,
      covered: 2,
      articles: { stored: 1, fresh: 1 },
      feeds: [{ feed: "wire", articles: 1, rejections: [] }],
    });

    expect(
      (await scratch.db.select().from(newsItems)).map((row) => row.profileId),
    ).toEqual([ramp]);
    expect(await scratch.db.select().from(newsArticles)).toHaveLength(1);
    expect(await scratch.db.select().from(newsProfileCoverage)).toHaveLength(2);
  });

  it("keeps a search's own-site article and records the re-search, which are the grants 0017 adds", async () => {
    const [row] = await scratch.db
      .insert(profiles)
      .values({
        ...candidate("Sprocket").input,
        source: "seed",
        website: "https://sprocket.example/",
        provenance: { ...candidate("Sprocket").provenance, website: "scraped" },
      })
      .returning({ id: profiles.id });
    const sprocket = row!.id;

    const aDayAgo = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
    const search = {
      search: async (url: string) => {
        const parsed = new URL(url);

        return parsed.searchParams.get("restrictSearchableAttributes") === "url"
          ? {
              hits: [
                {
                  objectID: "1",
                  title: "Announcing our seed round",
                  url: "https://sprocket.example/blog/seed",
                  created_at_i: aDayAgo,
                },
              ],
            }
          : { hits: [] };
      },
    };
    const client: NewsFeedClient = {
      get: async () => {
        throw new Error("no feed is configured for this run");
      },
    };

    await scratch.as("rolodeck_ingest");
    // The first run searches and stores; the second re-searches the one covered Profile.
    const first = await fetchNewsForTheCatalogue(scratch.db, {
      feeds: [],
      client,
      search,
    });
    const second = await fetchNewsForTheCatalogue(scratch.db, {
      feeds: [],
      client,
      search,
    });
    await scratch.reset();

    expect(first.searchArticles).toMatchObject({ stored: 1, fresh: 1 });
    expect(second.reSearches).toEqual({ done: 1, failed: 0, waiting: 0 });
    expect(
      (await scratch.db.select().from(newsArticles)).map((article) => [
        article.url,
        article.searchedForProfileId,
      ]),
    ).toEqual([["https://sprocket.example/blog/seed", sprocket]]);
    expect(
      (await scratch.db.select().from(newsProfileSiteRecovery)).map(
        (recovery) => recovery.profileId,
      ),
    ).toEqual([sprocket]);
  });
});

describe("the check on the role", () => {
  /**
   * `db/testing/ingest-role-check.sql`, which refuses a role any broader than the migrations make
   * it. This is the only place it runs: against `scratch`, freshly migrated, and then against a
   * role deliberately broadened, so it has been seen to fail and not only to pass.
   */
  async function roleCheck(): Promise<string> {
    return readFile(ROLE_CHECK_PATH, "utf8");
  }

  it("passes on the role as the migrations left it", async () => {
    await expect(scratch.client.exec(await roleCheck())).resolves.toBeDefined();
  });

  it.each([
    [
      "a grant on swipes",
      "grant select on swipes to rolodeck_ingest",
      "revoke select on swipes from rolodeck_ingest",
    ],
    [
      "a grant on auth.users",
      "grant usage on schema auth to rolodeck_ingest; grant select on auth.users to rolodeck_ingest",
      "revoke select on auth.users from rolodeck_ingest; revoke usage on schema auth from rolodeck_ingest",
    ],
    [
      "a grant to PUBLIC on user_profiles",
      "grant select on user_profiles to public",
      "revoke select on user_profiles from public",
    ],
    [
      "a column grant on user_profiles",
      "grant select (area) on user_profiles to rolodeck_ingest",
      "revoke select (area) on user_profiles from rolodeck_ingest",
    ],
    [
      "truncate on profiles",
      "grant truncate on profiles to rolodeck_ingest",
      "revoke truncate on profiles from rolodeck_ingest",
    ],
    [
      "delete on profiles",
      "grant delete on profiles to rolodeck_ingest",
      "revoke delete on profiles from rolodeck_ingest",
    ],
    [
      "the right to create roles",
      "alter role rolodeck_ingest createrole",
      "alter role rolodeck_ingest nocreaterole",
    ],
    [
      "an RLS bypass",
      "alter role rolodeck_ingest bypassrls",
      "alter role rolodeck_ingest nobypassrls",
    ],
    [
      "membership of authenticated",
      "grant authenticated to rolodeck_ingest",
      "revoke authenticated from rolodeck_ingest",
    ],
    [
      "a grant on a table in a schema that is neither public nor auth",
      "create schema elsewhere; create table elsewhere.secrets (id int); grant select on elsewhere.secrets to rolodeck_ingest",
      "drop schema elsewhere cascade",
    ],
    [
      "a grant on drizzle's own migrations table",
      "grant select on drizzle.__drizzle_migrations to rolodeck_ingest",
      "revoke select on drizzle.__drizzle_migrations from rolodeck_ingest",
    ],
    [
      "usage of a schema beyond public and ingest",
      "grant usage on schema drizzle to rolodeck_ingest",
      "revoke usage on schema drizzle from rolodeck_ingest",
    ],
    [
      "the right to create in public",
      "grant create on schema public to rolodeck_ingest",
      "revoke create on schema public from rolodeck_ingest",
    ],
    [
      "a grant on a sequence",
      "grant usage on sequence drizzle.__drizzle_migrations_id_seq to rolodeck_ingest",
      "revoke usage on sequence drizzle.__drizzle_migrations_id_seq from rolodeck_ingest",
    ],
    [
      "a grant to PUBLIC on a sequence",
      "create sequence public.escape_seq; grant select on sequence public.escape_seq to public",
      "drop sequence public.escape_seq",
    ],
    [
      "update on id",
      "grant update (id) on profiles to rolodeck_ingest",
      "revoke update (id) on profiles from rolodeck_ingest",
    ],
    [
      "a new function in public, which Postgres makes executable by PUBLIC",
      "create function public.escape() returns int language sql as 'select 1'",
      "drop function public.escape()",
    ],
    [
      "a SECURITY DEFINER function executable by PUBLIC in a schema it cannot use",
      "create schema elsewhere; create function elsewhere.escape() returns int language sql security definer as 'select 1'",
      "drop schema elsewhere cascade",
    ],
  ])(
    "refuses a role broadened with %s",
    async (_description, broaden, restore) => {
      await scratch.client.exec(broaden);

      try {
        await expect(scratch.client.exec(await roleCheck())).rejects.toThrow(
          /rolodeck_ingest may/,
        );
      } finally {
        await scratch.client.exec(restore);
      }
    },
  );
});
