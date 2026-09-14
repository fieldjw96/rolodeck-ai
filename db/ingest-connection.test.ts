// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The module memoises its connection, so each case needs its own copy of it. postgres.js does
 * not dial anything until the first query, which is what makes it safe to build one against a
 * connection string no server is listening on.
 */
async function freshModule() {
  vi.resetModules();
  return import("./ingest-connection");
}

const AS_THE_INGEST_ROLE =
  "postgres://rolodeck_ingest:secret@localhost:5432/rolodeck";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ingest's connection to Postgres", () => {
  it("is made once and handed out again, needing nothing of the app's own connection", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", AS_THE_INGEST_ROLE);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SECRET_KEY", undefined);

    const { getIngestDb } = await freshModule();

    expect(getIngestDb()).toBe(getIngestDb());
  });

  it("accepts the ingest role through Supabase's pooler, which names the project after a dot", async () => {
    vi.stubEnv(
      "ROLODECK_INGEST_DATABASE_URL",
      "postgresql://rolodeck_ingest.abcdefghijklmnop:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres",
    );

    const { getIngestDb } = await freshModule();

    expect(() => getIngestDb()).not.toThrow();
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
  ])(
    "fails naming ROLODECK_INGEST_DATABASE_URL when it %s",
    async (_description, value) => {
      vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", value);

      const { getIngestDb } = await freshModule();

      expect(() => getIngestDb()).toThrow(/ROLODECK_INGEST_DATABASE_URL/);
    },
  );

  it("does not pick up the variable it replaced, or the app's own", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", undefined);
    vi.stubEnv("SUPABASE_DB_URL", AS_THE_INGEST_ROLE);
    vi.stubEnv("DATABASE_URL", AS_THE_INGEST_ROLE);

    const { getIngestDb } = await freshModule();

    expect(() => getIngestDb()).toThrow(/ROLODECK_INGEST_DATABASE_URL/);
  });

  it("never repeats the password when it refuses a connection string", async () => {
    vi.stubEnv(
      "ROLODECK_INGEST_DATABASE_URL",
      "postgres://postgres:do-not-print-me@localhost:5432/rolodeck",
    );

    const { getIngestDb } = await freshModule();

    expect(() => getIngestDb()).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("do-not-print-me"),
      }),
    );
  });

  it("hands out a new connection after being closed", async () => {
    vi.stubEnv("ROLODECK_INGEST_DATABASE_URL", AS_THE_INGEST_ROLE);

    const { getIngestDb, closeIngestDb } = await freshModule();

    const first = getIngestDb();
    await closeIngestDb();
    const second = getIngestDb();

    expect(second).not.toBe(first);
  });

  it("closing before ever connecting does not throw", async () => {
    const { closeIngestDb } = await freshModule();

    await expect(closeIngestDb()).resolves.toBeUndefined();
  });
});
