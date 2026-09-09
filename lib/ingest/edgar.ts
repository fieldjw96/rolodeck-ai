import { z } from "zod";

import type { IngestRejection } from "../../db/profile-input";
import { issueField } from "../zod/issues";
import {
  CALIFORNIA,
  parseFormDFilings,
  type FormDBatch,
  type FormDFiling,
} from "./sec-form-d";
import { createEdgarThrottle, type Throttle } from "./throttle";

/**
 * The one module under `lib/ingest` that touches the network.
 *
 * Everything else here parses bytes a caller already has, which is what lets the parsers be
 * tested offline against the captures in `db/fixtures/` and is asserted as a rule by
 * `yc-company-page.test.ts`. Fetching is kept to this file so that rule stays a rule with one
 * named exception rather than becoming a comment nobody checks.
 *
 * Two things make EDGAR different from an ordinary scrape, and both live here:
 *
 * - The SEC answers 403 to a request with no `User-Agent`, and blocks clients whose agent it
 *   cannot contact. The contact is required, not defaulted.
 * - The SEC publishes ten requests a second and enforces it. Every request goes through a
 *   throttle that waits rather than refuses, because a refusal is no use to a caller that has
 *   to make the request eventually anyway.
 */

const EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data";

/**
 * The contact the SEC asks every automated client to declare. Read from the environment rather
 * than compiled in: the address has to be one the operator actually reads, and a personal
 * address baked into a public repository is neither that nor something anyone else running
 * this should be sending on their behalf.
 */
const contactSchema = z
  .string()
  .regex(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    "must be an email address the SEC can reach you at",
  );

export function edgarUserAgent(contact: string): string {
  const parsed = contactSchema.safeParse(contact);

  if (!parsed.success) {
    throw new Error(
      `SEC_EDGAR_CONTACT ${parsed.error.issues[0]!.message}, so no request may be made: ` +
        "the SEC refuses anonymous clients and blocks ones it cannot contact.",
    );
  }

  return `rolodeck-ai (${parsed.data})`;
}

export type EdgarClient = {
  /** The response body as text, throttled and identified. Throws on any non-2xx. */
  readonly get: (url: string) => Promise<string>;
};

export type EdgarClientOptions = {
  /** An address the SEC can reach the operator at. Required; see `edgarUserAgent`. */
  readonly contact: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly throttle?: Throttle;
};

export function createEdgarClient({
  contact,
  fetch = globalThis.fetch,
  throttle = createEdgarThrottle(),
}: EdgarClientOptions): EdgarClient {
  // Built before anything is fetched, so a run with no contact configured fails at the first
  // line rather than after a hundred requests the SEC was quietly refusing.
  const userAgent = edgarUserAgent(contact);

  return {
    get: async (url) => {
      await throttle.acquire();

      const response = await fetch(url, {
        headers: { "User-Agent": userAgent },
      });

      if (!response.ok) {
        throw new Error(`EDGAR answered ${response.status} for ${url}`);
      }

      return response.text();
    },
  };
}

/**
 * EDGAR's full-text search, which is what makes "recent Form D filings from Californian
 * issuers" one query rather than a crawl of the daily index.
 *
 * `locationCodes` is the parameter the index honours. `locationCode`, singular, is accepted,
 * returns 200, and is silently dropped from the filter — which is exactly why
 * `parseFormDFiling` checks the issuer's address again on the filing itself.
 */
export function searchUrl(since: string, until: string, from: number): string {
  const query = new URLSearchParams({
    q: "",
    forms: "D",
    startdt: since,
    enddt: until,
    locationCodes: CALIFORNIA,
  });

  if (from > 0) {
    query.set("from", String(from));
  }

  return `${EDGAR_SEARCH_URL}?${query.toString()}`;
}

/**
 * The archive path for a filing's primary document. A CIK is stored without its leading zeros
 * and an accession number without its dashes, which is EDGAR's convention and not ours.
 */
export function filingUrl(
  cik: string,
  accession: string,
  document: string,
): string {
  return `${EDGAR_ARCHIVES_URL}/${cik.replace(/^0+(?=\d)/, "")}/${accession.replace(/-/g, "")}/${document}`;
}

const searchHitSchema = z.looseObject({
  // "0002144996-26-000003:primary_doc.xml" — the accession number and the document in it.
  _id: z.string(),
  _source: z.looseObject({
    adsh: z.string(),
    ciks: z.array(z.string()).min(1),
  }),
});

const searchResponseSchema = z.looseObject({
  hits: z.looseObject({
    total: z.looseObject({ value: z.number() }),
    hits: z.array(searchHitSchema),
  }),
});

/** EDGAR serves at most a hundred hits per request, and pages with `from`. */
const SEARCH_PAGE_SIZE = 100;

export type FormDFetchOptions = {
  /** Inclusive filing dates, as `YYYY-MM-DD`. */
  readonly since: string;
  readonly until: string;
  /** How many filings to read at most. Every one costs a second EDGAR request. */
  readonly limit?: number;
  /** The capture date stamped on every Profile's provenance. Injectable for the tests. */
  readonly today?: string;
};

/**
 * Fetches recent Californian Form D filings and returns the Profiles readable from them.
 *
 * One request per page of search results and one per filing, all through the client's throttle,
 * so a run stays inside ten a second however many filings come back. A filing EDGAR will not
 * serve is counted as a rejection naming `document` rather than aborting the run: one 404 in a
 * hundred should cost one Profile, not the batch.
 */
export async function fetchCaliforniaFormDProfiles(
  client: EdgarClient,
  { since, until, limit = SEARCH_PAGE_SIZE, today }: FormDFetchOptions,
): Promise<FormDBatch> {
  const capturedAt = today ?? new Date().toISOString().slice(0, 10);
  const filings: FormDFiling[] = [];
  const rejections: IngestRejection[] = [];

  let from = 0;

  while (filings.length + rejections.length < limit) {
    const body = await client.get(searchUrl(since, until, from));
    const page = searchResponseSchema.safeParse(JSON.parse(body));

    if (!page.success) {
      // A search that has changed shape is the failure this Source most needs to be loud
      // about: quietly, it reads as "no company in California is raising this week".
      const issue = page.error.issues[0]!;
      throw new Error(
        `EDGAR search response changed shape at ${issueField(issue)}: ${issue.message}`,
      );
    }

    const hits = page.data.hits.hits;

    if (hits.length === 0) {
      break;
    }

    for (const hit of hits) {
      if (filings.length + rejections.length >= limit) {
        break;
      }

      const [accession, document] = hit._id.split(":");

      if (accession === undefined || document === undefined) {
        rejections.push({
          field: "document",
          reason: `could not read an accession and a document from ${hit._id}`,
          raw: hit,
        });
        continue;
      }

      const sourceUrl = filingUrl(hit._source.ciks[0]!, accession, document);

      try {
        filings.push({
          xml: await client.get(sourceUrl),
          capture: { sourceUrl, capturedAt },
        });
      } catch (error) {
        rejections.push({
          field: "document",
          reason: `could not fetch ${sourceUrl}: ${error instanceof Error ? error.message : "unknown"}`,
          raw: hit,
        });
      }
    }

    from += hits.length;

    if (from >= page.data.hits.total.value) {
      break;
    }
  }

  const batch = parseFormDFilings(filings);

  return { ...batch, rejections: [...rejections, ...batch.rejections] };
}
