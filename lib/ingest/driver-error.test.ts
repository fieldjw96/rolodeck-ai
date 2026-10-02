// @vitest-environment node
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { describeDriverError, describeFailure } from "./driver-error";

const { PostgresError } = postgres;

/** What `DrizzleQueryError` actually looks like: `message` is the query, `cause` is the reason. */
function drizzleQueryError(cause: unknown): Error {
  const error = new Error(
    'Failed query: insert into "events" ("id") values ($1)\nparams: some-source',
  );
  error.cause = cause;
  return error;
}

const NOT_NULL_VIOLATION = Object.assign(
  new PostgresError(
    'null value in column "external_id" violates not-null constraint',
  ),
  {
    code: "23502",
    severity: "ERROR",
    severity_local: "ERROR",
    table_name: "events",
    column_name: "external_id",
    detail: "Failing row contains (1, techmeme-events, null, ...).",
  },
);

const CHECK_CONSTRAINT_VIOLATION = Object.assign(
  new PostgresError(
    'new row for relation "profiles" violates check constraint "profiles_provenance_covers_every_field"',
  ),
  {
    code: "23514",
    severity: "ERROR",
    severity_local: "ERROR",
    table_name: "profiles",
    constraint_name: "profiles_provenance_covers_every_field",
    detail: "Failing row contains (...).",
  },
);

const CONNECTION_FAILURE = Object.assign(
  new Error("write ECONNREFUSED 127.0.0.1:5432"),
  { code: "ECONNREFUSED", errno: "ECONNREFUSED", address: "127.0.0.1" },
);

describe("describeDriverError", () => {
  it("finds a PostgresError holding a NOT NULL violation, naming the column", () => {
    const report = describeDriverError(drizzleQueryError(NOT_NULL_VIOLATION));

    expect(report).toContain("code: 23502");
    expect(report).toContain("column: external_id");
    expect(report).toContain("table: events");
    expect(report).toContain(
      "message: null value in column",
    );
    expect(report).toContain("detail: Failing row contains");
  });

  it("finds a PostgresError holding a check-constraint violation, naming the constraint", () => {
    const report = describeDriverError(
      drizzleQueryError(CHECK_CONSTRAINT_VIOLATION),
    );

    expect(report).toContain("code: 23514");
    expect(report).toContain(
      "constraint: profiles_provenance_covers_every_field",
    );
    expect(report).toContain("table: profiles");
  });

  it("finds a connection failure, which carries a code and nothing else", () => {
    const report = describeDriverError(drizzleQueryError(CONNECTION_FAILURE));

    expect(report).toContain("code: ECONNREFUSED");
    expect(report).toContain("message: write ECONNREFUSED");
    expect(report).not.toContain("constraint:");
    expect(report).not.toContain("column:");
    expect(report).not.toContain("table:");
  });

  it("walks more than one level of cause to find the driver error", () => {
    const wrapped = drizzleQueryError(
      new Error("transaction failed", { cause: NOT_NULL_VIOLATION }),
    );

    expect(describeDriverError(wrapped)).toContain("code: 23502");
  });

  it("finds nothing for an error with no cause at all", () => {
    expect(describeDriverError(new Error("plain failure"))).toBeUndefined();
  });

  it("finds nothing for an error whose cause is never a driver error", () => {
    const error = new Error("outer");
    error.cause = new Error("inner, but still not the driver's");

    expect(describeDriverError(error)).toBeUndefined();
  });

  it("never reads the query or its parameters, only the driver error's own fields", () => {
    const query = drizzleQueryError(NOT_NULL_VIOLATION) as Error & {
      query?: string;
      params?: readonly string[];
    };
    query.query = 'insert into "events" ("id") values ($1)';
    query.params = ["a-param-value-that-must-never-appear-in-the-report"];

    const report = describeDriverError(query);

    expect(report).not.toContain("a-param-value-that-must-never-appear");
  });
});

describe("describeFailure", () => {
  it("appends the driver's reason, on its own line, prefixed so it survives a keyword filter", () => {
    const message = describeFailure(drizzleQueryError(NOT_NULL_VIOLATION));

    expect(message).toContain(
      'Failed query: insert into "events" ("id") values ($1)',
    );
    expect(message).toContain("\npostgres error — ");
    expect(message).toContain("code: 23502");
  });

  it("is just the message when there is no cause at all", () => {
    expect(describeFailure(new Error("503 Service Unavailable"))).toBe(
      "503 Service Unavailable",
    );
  });

  it("is just the message when the cause chain never reaches a driver error", () => {
    const error = new Error("outer");
    error.cause = new Error("inner");

    expect(describeFailure(error)).toBe("outer");
  });

  it("stringifies something thrown that was never an Error", () => {
    expect(describeFailure("just a string")).toBe("just a string");
  });
});
