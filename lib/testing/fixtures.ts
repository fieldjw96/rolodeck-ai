import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FormDFiling } from "../ingest/sec-form-d";
import { captureSchema, type Capture } from "../ingest/scraped-profile";
import type { CompanyPage } from "../ingest/yc-company-page";

// Vitest runs with the project root as the working directory. `import.meta.url` would be
// more direct, but it is an http URL under the jsdom environment these tests run in. Same
// reasoning as lib/testing/sources.ts.
const FIXTURES_DIR = path.join(process.cwd(), "db", "fixtures");

/**
 * One captured document and the provenance recorded beside it. The bytes are read as they were
 * committed, with no normalising of any kind: a fixture that has been tidied up on the way in
 * tests the tidying, not the source.
 *
 * The sibling `.meta.json` goes through `captureSchema` rather than being trusted, so a fixture
 * added later without a source URL or a capture date fails the suite instead of producing
 * Profiles that cannot be traced back to anything.
 */
async function readFixture(
  slug: string,
  extension: string,
): Promise<{ text: string; capture: Capture }> {
  const [text, meta] = await Promise.all([
    readFile(path.join(FIXTURES_DIR, `${slug}.${extension}`), "utf8"),
    readFile(path.join(FIXTURES_DIR, `${slug}.meta.json`), "utf8"),
  ]);

  return { text, capture: captureSchema.parse(JSON.parse(meta)) };
}

export type CompanyFixture = CompanyPage & { readonly slug: string };

/** One captured Y Combinator company page. */
export async function readCompanyFixture(
  slug: string,
): Promise<CompanyFixture> {
  const { text, capture } = await readFixture(slug, "html");
  return { slug, html: text, capture };
}

export function readCompanyFixtures(
  slugs: readonly string[],
): Promise<CompanyFixture[]> {
  return Promise.all(slugs.map(readCompanyFixture));
}

export type FilingFixture = FormDFiling & { readonly slug: string };

/** One captured SEC Form D, as EDGAR served its `primary_doc.xml`. */
export async function readFilingFixture(slug: string): Promise<FilingFixture> {
  const { text, capture } = await readFixture(slug, "xml");
  return { slug, xml: text, capture };
}

export function readFilingFixtures(
  slugs: readonly string[],
): Promise<FilingFixture[]> {
  return Promise.all(slugs.map(readFilingFixture));
}
