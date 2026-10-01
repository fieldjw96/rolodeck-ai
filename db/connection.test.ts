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
  "postgres://rolodeck_app:secret@localhost:5432/rolodeck";

/** The pooler's form, which is how production reaches Supabase: `<role>.<project-ref>`. */
const THROUGH_THE_POOLER =
  "postgres://rolodeck_app.abcdefghijklmnop:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres";

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
    ["directly, as rolodeck_app", A_CONNECTION_STRING],
    ["through the pooler, as rolodeck_app.<project-ref>", THROUGH_THE_POOLER],
  ])("connects with a string that logs in %s", async (_description, value) => {
    vi.stubEnv("DATABASE_URL", value);

    const { getDb } = await freshModule();

    expect(() => getDb()).not.toThrow();
  });

  // The point of Ticket #188: `postgres` bypasses RLS, so every query the app makes would be
  // answered whether or not it went through `asUser()`, and with one account the results look
  // identical either way. The role is the whole guarantee, so the string naming it is checked.
  it.each([
    [
      "postgres, which bypasses RLS",
      "postgres://postgres:secret@localhost:5432/rolodeck",
    ],
    [
      "postgres through the pooler",
      "postgres://postgres.abcdefghijklmnop:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
    ],
    [
      "the ingest role, which is a different credential",
      "postgres://rolodeck_ingest:secret@localhost:5432/rolodeck",
    ],
    ["nobody at all", "postgres://localhost:5432/rolodeck"],
    [
      "rolodeck_app but is sent ?user=postgres at login",
      "postgres://rolodeck_app:secret@localhost:5432/rolodeck?user=postgres",
    ],
  ])("refuses a string that logs in as %s", async (_description, value) => {
    vi.stubEnv("DATABASE_URL", value);

    const { getDb } = await freshModule();

    expect(() => getDb()).toThrow(/DATABASE_URL/);
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

  it("does not fall back to ingest's connection string when its own is missing", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv(
      "ROLODECK_INGEST_DATABASE_URL",
      "postgres://rolodeck_ingest:secret@localhost:5432/rolodeck",
    );

    const { getDb } = await freshModule();

    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });
});
