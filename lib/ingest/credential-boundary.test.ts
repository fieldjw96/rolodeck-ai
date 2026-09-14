// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import {
  importSpecifiers,
  readSourceFiles,
  resolveImport,
  type SourceFile,
} from "../testing/sources";

/**
 * Ingest holds one credential, and it is not the secret key. See docs/adr/0013.
 *
 * `lib/supabase/client-boundary.test.ts` asks which files may name the secret key. This asks the
 * narrower question the ADR depends on: starting from each ingest entry point and following every
 * import that exists at runtime, does anything it loads name the secret key, or reach for the
 * app's own connection? A script that is clean itself but imports a module that reads the key
 * is exactly the case a per-file allowlist cannot see.
 */

/** Every name the secret key has gone by. */
const SECRET_KEY_NAMES = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

/**
 * The modules that hold the app's own credentials: the secret key's reader and client, and the
 * `authenticated`-role connection that `DATABASE_URL` builds.
 */
const APP_CREDENTIAL_MODULES = [
  "lib/supabase/env",
  "lib/supabase/admin",
  "db/connection",
];

/** Entry points that ingest but predate the `ingest-` prefix. */
const OTHER_INGEST_ENTRY_POINTS = ["scripts/fetch-show-hn.ts"];

const TYPE_ONLY_IMPORT = /\bimport\s+type\s[^;]*?from\s*["'][^"']+["']\s*;?/g;

/**
 * The modules a file loads when it runs. `import type` is dropped because TypeScript erases it:
 * `db/ingest.ts` names `Database` from `db/connection` without ever loading that module, and
 * counting it would make the rule below impossible to satisfy for no benefit.
 */
function runtimeImports(file: SourceFile): string[] {
  return importSpecifiers(file.text.replace(TYPE_ONLY_IMPORT, ""))
    .map((specifier) => resolveImport(file.path, specifier))
    .filter((resolved): resolved is string => resolved !== null);
}

let byModule: Map<string, SourceFile>;
let entryPoints: string[];

beforeAll(async () => {
  const sources = await readSourceFiles(["app", "lib", "db", "scripts"]);

  byModule = new Map(
    sources.map((file) => [file.path.replace(/\.(?:ts|tsx|mts)$/, ""), file]),
  );
  entryPoints = [
    ...sources
      .map((file) => file.path)
      .filter((path) => /^scripts\/ingest-[^/]+\.ts$/.test(path)),
    ...OTHER_INGEST_ENTRY_POINTS,
  ].sort();
});

/** Every file `entry` loads at runtime, itself included. */
function loadedBy(entry: string): SourceFile[] {
  const seen = new Set<string>();
  const pending = [entry.replace(/\.ts$/, "")];
  const loaded: SourceFile[] = [];

  while (pending.length > 0) {
    const next = pending.pop()!;

    if (seen.has(next)) {
      continue;
    }

    seen.add(next);
    const file = byModule.get(next) ?? byModule.get(`${next}/index`);

    // Failing rather than skipping: an import this walk cannot follow is a module whose
    // contents it would otherwise be vouching for unread.
    if (file === undefined) {
      throw new Error(`${entry} imports ${next}, which this check cannot read`);
    }

    loaded.push(file);
    pending.push(...runtimeImports(file));
  }

  return loaded;
}

function offenders(predicate: (file: SourceFile) => boolean): string[] {
  return entryPoints.flatMap((entry) =>
    loadedBy(entry)
      .filter(predicate)
      .map((file) => `${entry} loads ${file.path}`),
  );
}

describe("ingest's credential boundary", () => {
  it("finds every ingest entry point, so a rule below cannot pass by finding nothing", () => {
    expect(entryPoints).toEqual(
      expect.arrayContaining([
        "scripts/fetch-show-hn.ts",
        "scripts/ingest-accelerator-batches.ts",
        "scripts/ingest-events.ts",
        "scripts/ingest-news.ts",
        "scripts/ingest-sec-form-d.ts",
        "scripts/ingest-seed.ts",
      ]),
    );
  });

  it("follows imports far enough to see a module that does name the secret key", () => {
    const loaded = loadedBy("scripts/provision-account.ts").map(
      (file) => file.path,
    );

    expect(loaded).toEqual(
      expect.arrayContaining(["lib/supabase/admin.ts", "lib/supabase/env.ts"]),
    );
  });

  it("has no ingest entry point loading anything that names the secret key", () => {
    expect(
      offenders((file) =>
        SECRET_KEY_NAMES.some((name) => file.text.includes(name)),
      ),
    ).toEqual([]);
  });

  it("has no ingest entry point loading the app's own connection or its environment", () => {
    expect(
      offenders((file) =>
        APP_CREDENTIAL_MODULES.includes(file.path.replace(/\.ts$/, "")),
      ),
    ).toEqual([]);
  });

  it("has no ingest entry point reading DATABASE_URL, even directly", () => {
    expect(
      offenders((file) =>
        /process\.env(?:\.|\[\s*["'])DATABASE_URL\b/.test(file.text),
      ),
    ).toEqual([]);
  });

  it("connects every ingest entry point through ingest's own connection", () => {
    const withoutIt = entryPoints.filter(
      (entry) =>
        !loadedBy(entry).some(
          (file) => file.path === "db/ingest-connection.ts",
        ),
    );

    expect(withoutIt).toEqual([]);
  });

  it("reads ROLODECK_INGEST_DATABASE_URL in exactly one place", () => {
    const readers = [...byModule.values()]
      .filter(
        (file) =>
          !file.path.endsWith(".test.ts") &&
          file.text.includes("process.env.ROLODECK_INGEST_DATABASE_URL"),
      )
      .map((file) => file.path);

    expect(readers).toEqual(["lib/ingest/env.ts"]);
  });
});

describe("the runtime import scanner", () => {
  it("drops type-only imports and keeps everything that loads a module", () => {
    const file: SourceFile = {
      path: "db/example.ts",
      text: [
        'import type { Database } from "./connection";',
        'import type {\n  A,\n  B,\n} from "./types";',
        'import { type Profile, profiles } from "./schema";',
        'import "./side-effect";',
        'export { persistProfiles } from "./ingest";',
      ].join("\n"),
    };

    expect(runtimeImports(file)).toEqual([
      "db/schema",
      "db/side-effect",
      "db/ingest",
    ]);
  });
});
