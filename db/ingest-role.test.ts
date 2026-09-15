// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { INGEST_ROLE } from "../lib/ingest/env";
import type { GNewsClient } from "../lib/news/gnews";
import { fetchNewsForKeptProfiles } from "../lib/news/run";
import type { EventInput } from "./event-input";
import { persistEvents } from "./events";
import { persistProfiles, type ProfileCandidate } from "./ingest";
import {
  eventAttendances,
  events,
  ingestRole,
  newsItems,
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
  },
});

let scratch: ScratchDb;
const ownerIdBefore = process.env.ROLODECK_OWNER_ID;

/** A Company Profile owned by `ownerId`, arranged as the superuser. Returns its id. */
async function companyProfile(name: string, ownerId = JACK): Promise<string> {
  const [row] = await scratch.db
    .insert(profiles)
    .values({
      ...candidate(name).input,
      ownerId,
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
  process.env.ROLODECK_OWNER_ID = ownerIdBefore;
});

beforeEach(async () => {
  process.env.ROLODECK_OWNER_ID = JACK;
  await scratch.reset();
  await scratch.db.delete(eventAttendances);
  await scratch.db.delete(events);
  await scratch.db.delete(newsItems);
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
      { table: "public.news_items", privilege: "INSERT" },
      { table: "public.news_items", privilege: "SELECT" },
      { table: "public.profiles", privilege: "INSERT" },
      { table: "public.profiles", privilege: "SELECT" },
    ]);
  });

  it("may update every column of its tables but id and owner_id, and nothing else by column", async () => {
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
        ownerId: JACK,
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
    const kept = await session.client.query(
      "select * from ingest.kept_profile_ids($1)",
      [JACK],
    );
    expect(kept.rows).toEqual([{ kept_profile_ids: keptProfileId }]);
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

  // Its update policies are `with check (true)`, so only the column grant stands between an
  // update and a row moved into another account.
  it("cannot move a Company Profile into another account, but can still correct one", async () => {
    expect(
      await refusal("update profiles set owner_id = $1 where id = $2", [
        SOMEONE_ELSE,
        keptProfileId,
      ]),
    ).toMatch(/permission denied for table profiles/);

    expect(
      await refusal("update profiles set description = $1 where id = $2", [
        "Sprocket, corrected by ingest.",
        keptProfileId,
      ]),
    ).toBeNull();
    const { rows } = await session.client.query(
      "select owner_id, description from profiles where id = $1",
      [keptProfileId],
    );
    expect(rows).toEqual([
      { owner_id: JACK, description: "Sprocket, corrected by ingest." },
    ]);
  });

  it.each(["news_items", "events"])(
    "cannot move a row of %s into another account",
    async (table) => {
      expect(
        await refusal(`update ${table} set owner_id = $1`, [SOMEONE_ELSE]),
      ).toMatch(new RegExp(`permission denied for table ${table}`));
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

  it.each(["profiles", "news_items", "events"])(
    "cannot delete from %s",
    async (table) => {
      expect(await refusal(`delete from ${table}`)).toMatch(
        new RegExp(`permission denied for table ${table}`),
      );
    },
  );

  // TRUNCATE does not consult RLS at all, so a grant of it would be a bypass with no policy
  // in the way. It is refused even where ingest may delete.
  it.each(["profiles", "news_items", "events", "event_attendances"])(
    "cannot truncate %s",
    async (table) => {
      expect(await refusal(`truncate ${table} cascade`)).toMatch(
        /permission denied/,
      );
    },
  );

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

describe("the function that tells ingest what is Kept", () => {
  it("cannot be called by anon or authenticated", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await scratch.as(role, JACK);

      await expect(
        scratch.client.query("select ingest.kept_profile_ids($1)", [JACK]),
      ).rejects.toThrow(/permission denied/);

      await scratch.reset();
    }
  });
});

describe("what ingest does, as the ingest role", () => {
  it("writes and re-writes Company Profiles owned by the account, not by itself", async () => {
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
    expect(rows.map((row) => row.ownerId)).toEqual([JACK, JACK]);
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

  it("searches News for Kept Company Profiles only, without being able to read swipes", async () => {
    const ramp = await companyProfile("Ramp");
    const mercury = await companyProfile("Mercury");
    await companyProfile("Quiet Co");
    const theirs = await companyProfile("Theirs Inc", SOMEONE_ELSE);
    await scratch.db.insert(swipes).values([
      { userId: JACK, profileId: ramp, decision: "keep" },
      { userId: JACK, profileId: mercury, decision: "pass" },
      { userId: SOMEONE_ELSE, profileId: theirs, decision: "keep" },
    ]);

    const searched: string[] = [];
    const client: GNewsClient = {
      search: async (company) => {
        searched.push(company);
        return {
          totalArticles: 1,
          articles: [
            {
              id: "a1",
              title: `${company} raises a round`,
              description: null,
              content: "",
              url: `https://news.example/${company.toLowerCase()}`,
              image: null,
              publishedAt: "2026-09-01T12:00:00Z",
              lang: "en",
              source: {
                id: "s1",
                name: "TechCrunch",
                url: "https://tc.example",
              },
            },
          ],
        };
      },
    };

    await scratch.as("rolodeck_ingest");
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      client,
    });
    await scratch.reset();

    expect(searched).toEqual(["Ramp"]);
    expect(report).toMatchObject({ companies: 1, inserted: 1, failures: [] });

    const stored = await scratch.db.select().from(newsItems);
    expect(stored.map((row) => [row.profileId, row.ownerId])).toEqual([
      [ramp, JACK],
    ]);
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
      "update on owner_id",
      "grant update (owner_id) on news_items to rolodeck_ingest",
      "revoke update (owner_id) on news_items from rolodeck_ingest",
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
