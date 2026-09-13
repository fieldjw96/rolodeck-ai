// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import {
  declaresUseClient,
  importSpecifiers,
  readSourceFiles,
  resolveImport,
  type SourceFile,
} from "../testing/sources";

/**
 * The modules that read a session, hold the secret key, or open a connection to Postgres.
 * Nothing that ships to a browser may import any of them: they would carry one request's
 * session into another's bundle, bypass RLS outright, or put a database password in a script
 * tag. CLAUDE.md's rule that nothing in the browser talks to Postgres directly is this list.
 */
const SERVER_ONLY_MODULES = [
  "lib/supabase/server",
  "lib/supabase/admin",
  "lib/auth/session",
  "lib/api/authenticated",
  "db/connection",
];

/** The modules that must carry the `server-only` marker, which makes this a build error too. */
const MUST_BE_MARKED = [
  "lib/supabase/server.ts",
  "lib/auth/session.ts",
  "lib/api/authenticated.ts",
];

/**
 * Where the secret key is allowed to be named: the app's own boundary for reading it, the
 * operator script that spends it, the test harness that stands in for the Admin API, and the
 * build-output check, which has to spell the name out to grep for it. Anything else naming it
 * is the thing this check exists to catch.
 */
const SECRET_KEY_CALLERS = [
  "lib/supabase/env.ts",
  "lib/auth/testing/auth-backend.ts",
  "lib/auth/testing/gotrue-stub.ts",
  "scripts/provision-account.ts",
  "scripts/check-bundle-secrets.ts",
];

/**
 * Where News's provider key is allowed to be named: the one module that reads it, the operator
 * script whose usage line spells it out, and the build-output check. Not a Supabase secret, but
 * it spends a quota on Jack's account and nothing in a browser has any use for it.
 */
const NEWS_API_KEY_CALLERS = [
  "lib/news/gnews.ts",
  "scripts/ingest-news.ts",
  "scripts/check-bundle-secrets.ts",
];

const isTest = (file: SourceFile) => /\.test\.tsx?$/.test(file.path);

let sources: SourceFile[];

beforeAll(async () => {
  sources = await readSourceFiles(
    ["app", "lib", "db", "scripts"],
    ["proxy.ts", "drizzle.config.ts"],
  );
});

function offenders(predicate: (file: SourceFile) => boolean): string[] {
  return sources.filter(predicate).map((file) => file.path);
}

describe("the client bundle boundary", () => {
  it("reads the whole source tree, so a rule below cannot pass by finding nothing", () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.map((file) => file.path)).toContain("proxy.ts");
    expect(sources.map((file) => file.path)).toContain(
      "lib/supabase/server.ts",
    );
  });

  it("has no client component importing a session-reading or secret-key module", () => {
    const importsServerModule = (file: SourceFile) =>
      declaresUseClient(file.text) &&
      importSpecifiers(file.text).some((specifier) => {
        const resolved = resolveImport(file.path, specifier);
        return resolved !== null && SERVER_ONLY_MODULES.includes(resolved);
      });

    expect(offenders(importsServerModule)).toEqual([]);
  });

  it("has no client component naming the secret key", () => {
    expect(
      offenders(
        (file) =>
          declaresUseClient(file.text) &&
          file.text.includes("SUPABASE_SECRET_KEY"),
      ),
    ).toEqual([]);
  });

  it("names the secret key only where it belongs", () => {
    // Tests are exempt: this file has to spell the name out to check for it, and the harness
    // that spends the key against the Admin API is allowlisted above.
    expect(
      offenders(
        (file) =>
          !isTest(file) &&
          file.text.includes("SUPABASE_SECRET_KEY") &&
          !SECRET_KEY_CALLERS.includes(file.path),
      ),
    ).toEqual([]);
  });

  it("names the news provider's API key only where it belongs, and never in a client component", () => {
    expect(
      offenders(
        (file) =>
          !isTest(file) &&
          file.text.includes("GNEWS_API_KEY") &&
          !NEWS_API_KEY_CALLERS.includes(file.path),
      ),
    ).toEqual([]);
    expect(
      offenders(
        (file) =>
          declaresUseClient(file.text) && file.text.includes("GNEWS_API_KEY"),
      ),
    ).toEqual([]);
  });

  it("keeps the RLS-bypassing admin client out of the rendered app", () => {
    const importsAdmin = (file: SourceFile) =>
      file.path.startsWith("app/") &&
      importSpecifiers(file.text).some(
        (specifier) =>
          resolveImport(file.path, specifier) === "lib/supabase/admin",
      );

    expect(offenders(importsAdmin)).toEqual([]);
  });

  it("marks the session-reading modules `server-only`", () => {
    const marked = sources
      .filter((file) => importSpecifiers(file.text).includes("server-only"))
      .map((file) => file.path);

    expect(marked).toEqual(expect.arrayContaining(MUST_BE_MARKED));
  });
});

describe("the client-component detector", () => {
  it.each([
    ['"use client";\nexport const a = 1;\n', true],
    ["'use client'\nexport const a = 1;\n", true],
    ['// a comment first\n"use client";\n', true],
    ['/* a block */\n\n"use client";\n', true],
    ['export const a = 1;\n"use client";\n', false],
    ['const hint = "use client";\n', false],
    ["export const a = 1;\n", false],
  ])("reads %j as %s", (text, expected) => {
    expect(declaresUseClient(text)).toBe(expected);
  });
});

describe("the import scanner", () => {
  it("finds static, dynamic and required specifiers", () => {
    const text = [
      'import { a } from "./a";',
      'import "server-only";',
      'const b = await import("../b");',
      'const c = require("node:fs");',
    ].join("\n");

    expect(importSpecifiers(text)).toEqual([
      "./a",
      "server-only",
      "../b",
      "node:fs",
    ]);
  });

  it("resolves relative specifiers to repo-relative modules and leaves packages alone", () => {
    expect(
      resolveImport("app/login/actions.ts", "../../lib/supabase/server"),
    ).toBe("lib/supabase/server");
    expect(resolveImport("lib/auth/session.ts", "./paths")).toBe(
      "lib/auth/paths",
    );
    expect(resolveImport("proxy.ts", "@supabase/ssr")).toBeNull();
  });
});
