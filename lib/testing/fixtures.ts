import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { captureSchema, type CompanyPage } from "../ingest/yc-company-page";
import { captureSchema as showHnCaptureSchema } from "../ingest/show-hn";

// Vitest runs with the project root as the working directory. `import.meta.url` would be
// more direct, but it is an http URL under the jsdom environment these tests run in. Same
// reasoning as lib/testing/sources.ts.
const FIXTURES_DIR = path.join(process.cwd(), "db", "fixtures");

export type CompanyFixture = CompanyPage & { readonly slug: string };

/**
 * One captured company page and the provenance recorded beside it. The HTML is read as it
 * was committed, with no normalising of any kind: a fixture that has been tidied up on the
 * way in tests the tidying, not the source.
 *
 * The sibling `.meta.json` goes through `captureSchema` rather than being trusted, so a
 * fixture added later without a source URL or a capture date fails the suite instead of
 * producing Profiles that cannot be traced back to anything.
 */
export async function readCompanyFixture(
  slug: string,
): Promise<CompanyFixture> {
  const [html, meta] = await Promise.all([
    readFile(path.join(FIXTURES_DIR, `${slug}.html`), "utf8"),
    readFile(path.join(FIXTURES_DIR, `${slug}.meta.json`), "utf8"),
  ]);

  return { slug, html, capture: captureSchema.parse(JSON.parse(meta)) };
}

export function readCompanyFixtures(
  slugs: readonly string[],
): Promise<CompanyFixture[]> {
  return Promise.all(slugs.map(readCompanyFixture));
}

export type ShowHnFixture = {
  readonly slug: string;
  /** The one hit each fixture response carries; `parseShowHnPost` validates it itself. */
  readonly hit: unknown;
  readonly capture: z.infer<typeof showHnCaptureSchema>;
};

/**
 * Every real search response committed under `db/fixtures/show-hn-*.json` was captured with
 * `curl` against a single story's Algolia id, so it holds exactly one hit. The wrapper is
 * checked only for that shape here — `hits` is an array with something in it — because the hit
 * itself is hostile input `parseShowHnPost` is the one place that validates.
 */
const showHnResponseSchema = z.object({ hits: z.array(z.unknown()).min(1) });

export async function readShowHnFixture(slug: string): Promise<ShowHnFixture> {
  const [json, meta] = await Promise.all([
    readFile(path.join(FIXTURES_DIR, `${slug}.json`), "utf8"),
    readFile(path.join(FIXTURES_DIR, `${slug}.meta.json`), "utf8"),
  ]);

  const response = showHnResponseSchema.parse(JSON.parse(json));

  return {
    slug,
    hit: response.hits[0],
    capture: showHnCaptureSchema.parse(JSON.parse(meta)),
  };
}
