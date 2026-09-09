// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The module memoises its connection, so each case needs its own copy of it. postgres.js does
 * not dial anything until the first query, which is what makes it safe to build one against a
 * connection string no server is listening on.
 */
async function freshModule() {
  vi.resetModules();
  return import("./connection");
}

const A_CONNECTION_STRING =
  "postgres://rolodeck:secret@localhost:5432/rolodeck";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the app's connection to Postgres", () => {
  it("is made once and handed out again", async () => {
    vi.stubEnv("DATABASE_URL", A_CONNECTION_STRING);

    const { getDb } = await freshModule();

    expect(getDb()).toBe(getDb());
  });

  it.each([
    ["is missing", undefined],
    ["is empty", ""],
    ["is not a URL at all", "localhost:5432"],
    ["points somewhere that is not Postgres", "https://example.com/db"],
  ])("fails naming DATABASE_URL when it %s", async (_description, value) => {
    vi.stubEnv("DATABASE_URL", value);

    const { getDb } = await freshModule();

    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });
});

describe("ingest's connection to Postgres", () => {
  it("is made once and handed out again", async () => {
    vi.stubEnv("SUPABASE_DB_URL", A_CONNECTION_STRING);

    const { getIngestDb } = await freshModule();

    expect(getIngestDb()).toBe(getIngestDb());
  });

  it("is a separate connection from getDb()", async () => {
    vi.stubEnv("DATABASE_URL", A_CONNECTION_STRING);
    vi.stubEnv("SUPABASE_DB_URL", A_CONNECTION_STRING);

    const { getDb, getIngestDb } = await freshModule();

    expect(getIngestDb()).not.toBe(getDb());
  });

  it.each([
    ["is missing", undefined],
    ["is empty", ""],
    ["is not a URL at all", "localhost:5432"],
    ["points somewhere that is not Postgres", "https://example.com/db"],
  ])("fails naming SUPABASE_DB_URL when it %s", async (_description, value) => {
    vi.stubEnv("SUPABASE_DB_URL", value);

    const { getIngestDb } = await freshModule();

    expect(() => getIngestDb()).toThrow(/SUPABASE_DB_URL/);
  });
});
