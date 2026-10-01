// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_ROLE } from "../lib/supabase/env";
import {
  DEFAULT_PAGE_SIZE,
  readDeckPage,
  readKeptProfiles,
  recordSwipe,
  type DeckPage,
  type DeckProfile,
} from "./deck";
import { asUser } from "./rls";
import { profiles, swipes } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { seedProfiles } from "./testing/seed-profiles";
import {
  readUserProfile,
  writeUserProfile,
  type UserProfile,
} from "./user-profile";

/**
 * The role the app connects as, asserted from both sides: everything the app actually does
 * succeeds as that role, and a query that skips `asUser()` is refused outright. Ticket #188,
 * and docs/adr/0005, which asked for this role in the first place.
 *
 * Before it, `DATABASE_URL` logged in as Supabase's `postgres`, which bypasses RLS. The
 * policies applied only because `asUser()` runs `set local role authenticated` inside every
 * transaction, so a query that forgot it had no backstop at all — and with one account it
 * returned the owner's own rows and looked completely correct. That is what the refusals below
 * exist to make impossible, and each is Postgres's own "permission denied" rather than merely
 * an empty result.
 */

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

const MIGRATION_PATH = fileURLToPath(
  new URL("./migrations/0012_app_role.sql", import.meta.url),
);

describe("the app's role itself", () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createScratchDb();
  }, 60_000);

  afterAll(async () => {
    await scratch?.close();
  });

  it("is not a superuser, cannot create roles or databases, cannot replicate, and does not bypass RLS", async () => {
    const { rows } = await scratch.client.query(
      "select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname = $1",
      [APP_ROLE],
    );

    expect(rows).toEqual([
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        // The attribute with the teeth: a member that inherits nothing holds `authenticated`'s
        // privileges only while `asUser()` has it `set role authenticated`.
        rolinherit: false,
        rolcanlogin: true,
      },
    ]);
  });

  it("is a member of authenticated, of nothing else, and cannot grant that membership on", async () => {
    const { rows } = await scratch.client.query(
      "select roleid::regrole::text as role, admin_option from pg_auth_members where member = $1::regrole order by 1",
      [APP_ROLE],
    );

    expect(rows).toEqual([{ role: "authenticated", admin_option: false }]);
  });

  it("holds no grant of its own on any table, column, sequence, schema or function", async () => {
    // Everything granted to this role by name, anywhere in the cluster. It needs none: every
    // query it makes runs as `authenticated`, which Supabase grants the table privileges to.
    const { rows } = await scratch.client.query(
      `select granted.what
         from (
           select n.nspname || '.' || c.relname as what
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             cross join lateral aclexplode(c.relacl) a
            where a.grantee = $1::regrole
           union all
           select n.nspname || '.' || c.relname || '.' || at.attname
             from pg_attribute at
             join pg_class c on c.oid = at.attrelid
             join pg_namespace n on n.oid = c.relnamespace
             cross join lateral aclexplode(at.attacl) a
            where a.grantee = $1::regrole
           union all
           select 'schema ' || n.nspname
             from pg_namespace n
             cross join lateral aclexplode(n.nspacl) a
            where a.grantee = $1::regrole
           union all
           select p.oid::regprocedure::text
             from pg_proc p
             cross join lateral aclexplode(p.proacl) a
            where a.grantee = $1::regrole
         ) as granted
        order by 1`,
      [APP_ROLE],
    );

    expect(rows).toEqual([]);
  });

  // The same question Postgres itself asks before it reads a row, which is what a grant to
  // PUBLIC or an inherited membership would show up in and the ACL listing above would not.
  it.each([
    ["public", "swipes"],
    ["public", "profiles"],
    ["public", "user_profiles"],
    ["auth", "users"],
  ])(
    "can reach no privilege of its own on %s.%s, where authenticated can",
    async (schema, table) => {
      const { rows } = await scratch.client.query(
        `select has_table_privilege($1, $3::text, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as app,
                has_any_column_privilege($1, $3::text, 'SELECT, INSERT, UPDATE, REFERENCES') as app_by_column,
                has_table_privilege($2, $3::text, 'SELECT') as authenticated`,
        [APP_ROLE, "authenticated", `${schema}.${table}`],
      );

      // `auth.users` is nobody's to read: Supabase keeps it behind its own functions, and the
      // shim grants the API roles nothing outside `public`. The point of the row is the first
      // two columns; the third says the check would notice if the role did hold something.
      expect(rows).toEqual([
        {
          app: false,
          app_by_column: false,
          authenticated: schema === "public",
        },
      ]);
    },
  );

  /**
   * The migration's last statement refuses to finish if the role it leaves behind is broader
   * than the file says, on whatever database it runs against — including the real Supabase
   * project, where none of the tests above ever run. That makes it the only check production
   * gets, so it is worth knowing it has been seen to fail and not only to pass. Run here
   * against the role as the migration left it, and then against one deliberately widened.
   */
  const roleCheck = async (): Promise<string> => {
    const migration = await readFile(MIGRATION_PATH, "utf8");
    // Drizzle's own separator, which `db/migrations/meta/_journal.json` records as
    // `breakpoints: true`. The check is the last statement in the file.
    const statements = migration.split("--> statement-breakpoint");
    const check = statements.at(-1) ?? "";

    expect(check).toContain("RAISE EXCEPTION 'rolodeck_app");
    return check;
  };

  it("passes the migration's own check on the role as the migration left it", async () => {
    await expect(scratch.client.exec(await roleCheck())).resolves.toBeDefined();
  });

  it.each([
    [
      "a grant on swipes",
      "grant select on swipes to rolodeck_app",
      "revoke select on swipes from rolodeck_app",
    ],
    [
      "a column grant on swipes",
      "grant select (user_id) on swipes to rolodeck_app",
      "revoke select (user_id) on swipes from rolodeck_app",
    ],
    [
      "usage of the public schema, which it needs only as authenticated",
      "grant usage on schema public to rolodeck_app",
      "revoke usage on schema public from rolodeck_app",
    ],
    [
      // Granted to PUBLIC rather than to the role, so only the privilege check catches it.
      "a grant to PUBLIC on user_profiles",
      "grant select on user_profiles to public",
      "revoke select on user_profiles from public",
    ],
    [
      "an RLS bypass",
      "alter role rolodeck_app bypassrls",
      "alter role rolodeck_app nobypassrls",
    ],
    [
      "the right to create roles",
      "alter role rolodeck_app createrole",
      "alter role rolodeck_app nocreaterole",
    ],
    [
      // The quietest widening of the lot: every grant stays as it was, and the role simply
      // starts holding `authenticated`'s table privileges while it is still itself.
      "inheritance of the role it belongs to",
      "alter role rolodeck_app inherit",
      "alter role rolodeck_app noinherit",
    ],
    [
      "membership of a second role",
      "grant rolodeck_ingest to rolodeck_app",
      "revoke rolodeck_ingest from rolodeck_app",
    ],
    [
      "the right to hand its membership of authenticated to somebody else",
      "grant authenticated to rolodeck_app with admin option",
      "revoke admin option for authenticated from rolodeck_app",
    ],
  ])(
    "fails the migration's own check on a role broadened with %s",
    async (_description, broaden, restore) => {
      const check = await roleCheck();
      await scratch.client.exec(broaden);

      try {
        await expect(scratch.client.exec(check)).rejects.toThrow(
          /rolodeck_app may|rolodeck_app must/,
        );
      } finally {
        await scratch.client.exec(restore);
      }
    },
  );
});

describe("logged in as the app role", () => {
  /**
   * A database of its own, logged in as `rolodeck_app` for good — the way a real connection
   * with `DATABASE_URL` is. Not `scratch.as()`, which only changes the current user: a session
   * that began as the superuser can still `set role` to anyone, so it would wave through the
   * escapes below. PGlite cannot hand a session back once its authorization has changed, which
   * is why this does not share a database with the block above.
   */
  let session: ScratchDb;
  let jacksProfiles: string[];
  let theirProfile: string;
  /** What the same `asUser()` calls returned before the session became the app role. */
  let asPostgres: {
    deck: DeckPage;
    kept: DeckProfile[];
    userProfile: UserProfile;
  };

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
    await session.createUser(SOMEONE_ELSE);

    jacksProfiles = await seedProfiles(session.db, { count: 3, ownerId: JACK });
    const theirs = await seedProfiles(session.db, {
      count: 1,
      ownerId: SOMEONE_ELSE,
    });
    theirProfile = theirs[0]!;
    await session.db.insert(swipes).values({
      userId: JACK,
      profileId: jacksProfiles[0]!,
      decision: "keep",
    });
    await session.db.insert(swipes).values({
      userId: SOMEONE_ELSE,
      profileId: theirProfile,
      decision: "keep",
    });

    // The baseline: what the app's own reads answered while the connection was still the
    // superuser, which is what `DATABASE_URL` logged in as before this Ticket.
    asPostgres = {
      deck: await asUser(session.db, JACK, (tx) =>
        readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
      ),
      kept: await asUser(session.db, JACK, (tx) => readKeptProfiles(tx, JACK)),
      userProfile: await asUser(session.db, JACK, (tx) =>
        readUserProfile(tx, JACK),
      ),
    };

    await session.client.exec(`set session authorization ${APP_ROLE}`);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
  });

  it("really is the app role, and can still ask whether Postgres is up — so every refusal below is a refusal", async () => {
    const { rows } = await session.client.query(
      "select current_user, session_user",
    );
    expect(rows).toEqual([{ current_user: APP_ROLE, session_user: APP_ROLE }]);

    // `select 1` is the health route's query, and the one query in the app outside `asUser()`:
    // it reads no row, so no policy could be its backstop. See app/api/health/route.ts.
    expect(await refusal("select 1")).toBeNull();
  });

  /**
   * The point of Ticket #188. This query succeeded before it, as `postgres`, returning every
   * account's swipes; with one account it returned Jack's own and looked perfectly correct.
   */
  it("cannot read another user's swipes with no asUser() around the query", async () => {
    expect(
      await refusal("select * from swipes where user_id = $1", [SOMEONE_ELSE]),
    ).toMatch(/permission denied for table swipes/);

    // Nor its own owner's, nor the table at large: the refusal is the role's, not a policy's,
    // so it does not depend on who the query asks about.
    expect(await refusal("select * from swipes")).toMatch(
      /permission denied for table swipes/,
    );
    expect(
      await refusal("select * from swipes where user_id = $1", [JACK]),
    ).toMatch(/permission denied for table swipes/);
  });

  it("cannot write a swipe, or any other table, with no asUser() around the query", async () => {
    expect(
      await refusal(
        "insert into swipes (user_id, profile_id, decision) values ($1, $2, 'keep')",
        [SOMEONE_ELSE, theirProfile],
      ),
    ).toMatch(/permission denied for table swipes/);
    expect(await refusal("update swipes set decision = 'pass'")).toMatch(
      /permission denied for table swipes/,
    );
    expect(await refusal("delete from swipes")).toMatch(
      /permission denied for table swipes/,
    );
  });

  it.each([
    "profiles",
    "user_profiles",
    "news_items",
    "events",
    "event_attendances",
  ])(
    "cannot read %s with no asUser() around the query either",
    async (table) => {
      expect(await refusal(`select * from ${table}`)).toMatch(
        new RegExp(`permission denied for table ${table}`),
      );
    },
  );

  it("cannot reach the auth schema at all", async () => {
    expect(await refusal("select id from auth.users")).toMatch(
      /permission denied/,
    );
    expect(
      await refusal("insert into auth.users (id) values ($1)", [
        "33333333-3333-3333-3333-333333333333",
      ]),
    ).toMatch(/permission denied/);
  });

  it.each(["profiles", "swipes", "user_profiles"])(
    "cannot truncate %s, which would not consult a policy even inside asUser()",
    async (table) => {
      expect(await refusal(`truncate ${table} cascade`)).toMatch(
        /permission denied/,
      );
    },
  );

  it.each(["postgres", "anon", "rolodeck_ingest", "service_role"])(
    "cannot become %s",
    async (role) => {
      // `service_role` does not exist in the shim, which is itself a refusal: the role cannot
      // reach it either way, and a cluster that has it answers "permission denied to set role".
      expect(await refusal(`set role ${role}`)).toMatch(
        /permission denied to set role|does not exist/,
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

  it("can become authenticated, which is the one thing it is a member of", async () => {
    expect(await refusal("set role authenticated")).toBeNull();
    await session.client.exec("reset role");
  });

  it("answers the app's own reads exactly as the postgres connection did", async () => {
    const deck = await asUser(session.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );
    const kept = await asUser(session.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );
    const userProfile = await asUser(session.db, JACK, (tx) =>
      readUserProfile(tx, JACK),
    );

    expect(deck).toEqual(asPostgres.deck);
    expect(kept).toEqual(asPostgres.kept);
    expect(userProfile).toEqual(asPostgres.userProfile);

    // Not vacuous: the Deck has Jack's unswiped Profiles in it and the Watchlist has his Keep.
    expect(deck.profiles).toHaveLength(2);
    expect(kept).toHaveLength(1);
  });

  it("writes through asUser() too: a swipe, and a User Profile", async () => {
    const recorded = await asUser(session.db, JACK, (tx) =>
      recordSwipe(tx, {
        userId: JACK,
        profileId: jacksProfiles[1]!,
        decision: "keep",
      }),
    );
    expect(recorded).toMatchObject({ profileId: jacksProfiles[1]! });

    const written = await asUser(session.db, JACK, (tx) =>
      writeUserProfile(tx, JACK, {
        sectors: ["ai-ml"],
        stages: ["seed"],
        area: "San Francisco",
        excluded_sectors: [],
      }),
    );
    expect(written).toMatchObject({
      sectors: ["ai-ml"],
      area: "San Francisco",
    });

    // Read back through the same path, so the row is really there and really visible.
    const kept = await asUser(session.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );
    expect(kept).toHaveLength(2);
  });

  it("still gets RLS between accounts inside asUser(), which is what the policies are for", async () => {
    const theirs = await asUser(session.db, SOMEONE_ELSE, (tx) =>
      readKeptProfiles(tx, SOMEONE_ELSE),
    );
    expect(theirs.map((profile) => profile.id)).toEqual([theirProfile]);

    // Jack's rows, asked for by somebody else's session: the `where` clause and the policy
    // agree, and neither is the connection role's doing.
    const jacks = await asUser(session.db, SOMEONE_ELSE, (tx) =>
      tx.select().from(swipes),
    );
    expect(jacks.map((swipe) => swipe.userId)).toEqual([SOMEONE_ELSE]);
  });

  it("leaves no role or claim behind when a transaction ends", async () => {
    await asUser(session.db, JACK, (tx) => tx.select().from(profiles));

    const { rows } = await session.client.query<{
      current_user: string;
      claims: string | null;
    }>(
      "select current_user, current_setting('request.jwt.claims', true) as claims",
    );

    expect(rows[0]?.current_user).toBe(APP_ROLE);
    // Null where the setting was never set at session level, empty where it was; either way
    // the signed-in user did not survive the commit, which is what `set local` is for.
    expect(rows[0]?.claims ?? "").toBe("");
  });
});
