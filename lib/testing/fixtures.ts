import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { FormDFiling } from "../ingest/sec-form-d";
import { captureSchema as showHnCaptureSchema } from "../ingest/show-hn";
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

export type AcceleratorFixture = {
  readonly slug: string;
  readonly html: string;
  readonly capture: Capture;
};

/** One captured accelerator batch page — South Park Commons, AngelPad. */
export async function readAcceleratorFixture(
  slug: string,
): Promise<AcceleratorFixture> {
  const { text, capture } = await readFixture(slug, "html");
  return { slug, html: text, capture };
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
export type ShowHnFixture = {
  readonly slug: string;
  /** The one hit each fixture response carries; `parseShowHnPost` validates it itself. */
  readonly hit: unknown;
  readonly capture: z.infer<typeof showHnCaptureSchema>;
};

/**
 * Every real search response committed under `db/fixtures/show-hn-*.json` was captured with
 * `curl` against a single story's Algolia id, so it holds exactly one hit. The wrapper is
 * checked only for that shape here â `hits` is an array with something in it â because the hit
 * itself is hostile input `parseShowHnPost` is the one place that validates.
 */
const showHnResponseSchema = z.object({ hits: z.array(z.unknown()).min(1) });

/**
 * One captured Algolia Hacker News search response, holding a single Show HN story.
 *
 * This does not go through `readFixture`. A Show HN capture records the *query* that found the
 * story rather than a source URL, because the same story is reachable from several URLs and the
 * query is what makes the capture reproducible â so its `.meta.json` fails the shared
 * `captureSchema`, which requires `sourceUrl`. Both shapes are honest provenance for their own
 * source; forcing one onto the other would mean inventing a URL that was never fetched.
 */
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

export type EventSourceFixture = {
  readonly slug: string;
  readonly text: string;
  readonly capture: Capture;
};

/** One captured events Source document: Techmeme's iCalendar feed, a Luma calendar page. */
export async function readEventSourceFixture(
  slug: string,
  extension: "ics" | "html",
): Promise<EventSourceFixture> {
  const { text, capture } = await readFixture(slug, extension);
  return { slug, text, capture };
}
