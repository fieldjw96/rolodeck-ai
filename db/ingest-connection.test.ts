// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * postgres.js stood in for, so each case decides who Postgres says the connection logged in as
 * without a server to ask. The rest is real: the environment the module reads, and the Drizzle
 * instance it builds on the client.
 */
const server = vi.hoisted(() => ({
  currentUser: "rolodeck_ingest",
  dialled: [] as string[],
  queries: [] as string[],
  ended: 0,
}));

vi.mock("postgres", () => ({
  default: (url: string) => {
    server.dialled.push(url);

    return Object.assign(
      async (strings: TemplateStringsArray) => {
        server.queries.push(strings.join(""));
        return [{ current_user: server.currentUser }];
      },
      {
        // What `drizzle()` reaches into when it wraps a client.
        options: { parsers: {}, serializers: {} },
        end: async () => {
          server.ended += 1;
        },
      },
    );
  },
}));

/** The module memoises its connection, so each case needs its own copy of it. */
async function freshModule() {
  vi.resetModules();
  return import("./ingest-connection");
}

const AS_THE_INGEST_ROLE =
  "postgres://rolodeck_ingest:secret@localhost:5432/rolodeck";

beforeEach(() => {
  server.currentUser = "rolodeck_ingest";
  server.dialled = [];
  server.queries = [];
  server.ended = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ingest's connection to Postgres", () => {
  it("is made once and handed out again, needing nothing of the app's own connection", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", AS_THE_INGEST_ROLE);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SECRET_KEY", undefined);

    const { getIngestDb } = await freshModule();

    const first = await getIngestDb();
    expect(await getIngestDb()).toBe(first);
    expect(server.dialled).toEqual([AS_THE_INGEST_ROLE]);
  });

  it("accepts the ingest role through Supabase's pooler, which names the project after a dot", async () => {
    vi.stubEnv(
      "ROLODECK_INGEST_DATABASE_URL",
      "postgresql://rolodeck_ingest.abcdefghijklmnop:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres",
    );

    const { getIngestDb } = await freshModule();

    await expect(getIngestDb()).resolves.toBeDefined();
  });

  it("accepts sslmode, the one query parameter it permits", async () => {
    vi.stubEnv(
      "ROLODECK_INGEST_DATABASE_URL",
      `${AS_THE_INGEST_ROLE}?sslmode=require`,
    );

    const { getIngestDb } = await freshModule();

    await expect(getIngestDb()).resolves.toBeDefined();
  });

  it.each([
    ["is missing", undefined],
    ["is empty", ""],
    ["is not a URL at all", "localhost:5432"],
    ["points somewhere that is not Postgres", "https://example.com/db"],
    [
      "logs in as postgres, which would make the scoped name a lie",
      "postgres://postgres:secret@localhost:5432/rolodeck",
    ],
    [
      "logs in as postgres through the pooler",
      "postgres://postgres.abcdefghijklmnop:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres",
    ],
    [
      "logs in as a role that only begins with the same letters",
      "postgres://rolodeck_ingestion:secret@localhost:5432/rolodeck",
    ],
    [
      "names the ingest role but overrides it with ?user=",
      "postgres://rolodeck_ingest.abcdefghijklmnop:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres?user=postgres.abcdefghijklmnop",
    ],
    [
      "carries any query parameter but sslmode",
      `${AS_THE_INGEST_ROLE}?application_name=ingest`,
    ],
  ])(
    "fails naming ROLODECK_INGEST_DATABASE_URL, without dialling, when it %s",
    async (_description, value) => {
      vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", value);

      const { getIngestDb } = await freshModule();

      await expect(getIngestDb()).rejects.toThrow(
        /ROLODECK_INGEST_DATABASE_URL/,
      );
      expect(server.dialled).toEqual([]);
    },
  );

  it("refuses a connection Postgres says is not the ingest role, and closes it", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", AS_THE_INGEST_ROLE);
    server.currentUser = "postgres";

    const { getIngestDb } = await freshModule();

    await expect(getIngestDb()).rejects.toThrow(
      /ROLODECK_INGEST_DATABASE_URL logged in as postgres, not rolodeck_ingest/,
    );
    expect(server.queries).toEqual(["select current_user"]);
    expect(server.ended).toBe(1);
  });

  it("asks again after a refusal, rather than remembering it", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", AS_THE_INGEST_ROLE);
    server.currentUser = "postgres";

    const { getIngestDb } = await freshModule();

    await expect(getIngestDb()).rejects.toThrow(/logged in as postgres/);

    server.currentUser = "rolodeck_ingest";
    await expect(getIngestDb()).resolves.toBeDefined();
    expect(server.queries).toHaveLength(2);
  });

  it("does not pick up the variable it replaced, or the app's own", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", undefined);
    vi.stubEnv("SUPABASE_DB_URL", AS_THE_INGEST_ROLE);
    vi.stubEnv("DATABASE_URL", AS_THE_INGEST_ROLE);

    const { getIngestDb } = await freshModule();

    await expect(getIngestDb()).rejects.toThrow(/ROLODECK_INGEST_DATABASE_URL/);
  });

  it.each([
    [
      "logs in as postgres",
      "postgres://postgres:do-not-print-me@localhost:5432/rolodeck",
    ],
    [
      "overrides the login with ?user=",
      "postgres://rolodeck_ingest:do-not-print-me@localhost:5432/rolodeck?user=postgres",
    ],
  ])(
    "never repeats the password when it refuses a connection string that %s",
    async (_description, value) => {
      vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", value);

      const { getIngestDb } = await freshModule();

      await expect(getIngestDb()).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining("do-not-print-me"),
        }),
      );
    },
  );

  it("hands out a new connection after being closed", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", AS_THE_INGEST_ROLE);

    const { getIngestDb, closeIngestDb } = await freshModule();

    const first = await getIngestDb();
    await closeIngestDb();
    const second = await getIngestDb();

    expect(second).not.toBe(first);
    expect(server.ended).toBe(1);
  });

  it("closing before ever connecting does not throw", async () => {
    const { closeIngestDb } = await freshModule();

    await expect(closeIngestDb()).resolves.toBeUndefined();
  });
});

describe("why the query string is refused", () => {
  it("postgres.js really would send ?user= at login, in place of the URL's own user", async () => {
    const { default: realPostgres } = await vi.importActual<{
      default: typeof import("postgres");
    }>("postgres");

    // Building a client dials nothing until its first query.
    const client = realPostgres(
      "postgres://rolodeck_ingest:secret@localhost:5432/rolodeck?user=postgres",
    );

    expect(client.options.user).toBe("rolodeck_ingest");
    expect(client.options.connection).toMatchObject({ user: "postgres" });
  });
});
