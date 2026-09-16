/**
 * Greps the built output for anything that must never leave the server.
 *
 * `lib/supabase/client-boundary.test.ts` asks the same question of the source, which is the
 * cheaper check and the one that names the offending line. This asks it of the artefact
 * actually served to a browser, which is the only place the answer is authoritative: Next
 * inlines `NEXT_PUBLIC_` variables at build time, and a rename or a stray import can put a
 * value in a chunk without any single source file looking wrong.
 *
 * Run after `npm run build`. See docs/adr/0006.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The variables that carry a secret. Names, not values: a name in a client chunk means Next
 * either inlined the value or is about to be asked to, and either way the build is wrong.
 * `SUPABASE_SERVICE_ROLE_KEY` is Supabase's older name for the secret key and is here so that
 * reaching for the old name is caught too. `ROLODECK_INGEST_DATABASE_URL` is ingest's own
 * connection (docs/adr/0013); `SUPABASE_DB_URL` is the name it replaced, kept for the reason the
 * old secret-key name is.
 */
const SECRET_VARIABLES = [
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "ROLODECK_INGEST_DATABASE_URL",
  "SUPABASE_DB_URL",
];

/**
 * What a browser is served. `.next/static` is the client bundle; the prerendered documents
 * under `.next/server/app` are sent to a browser verbatim and can carry an inlined value in a
 * script tag. Everything else under `.next/server` is server code, where these names belong.
 */
const CLIENT_ROOTS = [
  { root: ".next/static", extensions: null },
  {
    root: ".next/server/app",
    extensions: new Set([".html", ".rsc", ".body", ".json"]),
  },
] as const;

type Leak = { file: string; variable: string; kind: "name" | "value" };

async function filesUnder(
  root: string,
  extensions: ReadonlySet<string> | null,
): Promise<string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => null);

  if (entries === null) {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (extensions === null || extensions.has(path.extname(entry.name))),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * A value is only worth grepping for if it is long enough to be distinctive; a two-character
 * secret would match half the bundle and say nothing. Values are compared, never printed.
 */
function secretValues(): Map<string, string> {
  const values = new Map<string, string>();

  for (const variable of SECRET_VARIABLES) {
    const value = process.env[variable];

    if (value !== undefined && value.length >= 12) {
      values.set(variable, value);
    }
  }

  return values;
}

async function main(): Promise<void> {
  const values = secretValues();
  const leaks: Leak[] = [];
  let scanned = 0;

  for (const { root, extensions } of CLIENT_ROOTS) {
    for (const file of await filesUnder(root, extensions)) {
      const text = await readFile(file, "utf8").catch(() => null);

      if (text === null) {
        // A font or an image. Nothing that could hold an inlined string.
        continue;
      }

      scanned += 1;

      for (const variable of SECRET_VARIABLES) {
        if (text.includes(variable)) {
          leaks.push({ file, variable, kind: "name" });
        }
      }

      for (const [variable, value] of values) {
        if (text.includes(value)) {
          leaks.push({ file, variable, kind: "value" });
        }
      }
    }
  }

  // A check that passes because it found nothing to look at is worse than no check: it reports
  // a clean bundle on a build that never happened.
  if (scanned === 0) {
    throw new Error(
      "No built client output found. Run `npm run build` before this check.",
    );
  }

  if (leaks.length > 0) {
    // The variable is named and the value never is, so the failure is readable in a CI log
    // that anybody can see.
    for (const leak of leaks) {
      console.error(
        leak.kind === "value"
          ? `${leak.file}: contains the value of ${leak.variable}`
          : `${leak.file}: names ${leak.variable}`,
      );
    }

    throw new Error(
      `${leaks.length} secret(s) reachable from the browser. Nothing here may leave the server.`,
    );
  }

  console.log(
    `Checked ${scanned} client file(s) for ${SECRET_VARIABLES.length} secret variable(s): none present.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
