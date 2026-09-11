import { z } from "zod";

import {
  parseProfileInput,
  type IngestRejection,
} from "../../db/profile-input";
import { issueField } from "../zod/issues";
import { decodeEntities } from "./entities";
import {
  attribute,
  type Capture,
  type ScrapedProfile,
  type ScrapedProfileResult,
} from "./scraped-profile";
import { sectorFromRawText } from "./sector";
import { stageFromTeamSize } from "./stage";

/**
 * Parses one Y Combinator company page into a validated `ProfileInput`.
 *
 * Parsing only: nothing here fetches, and nothing here writes. The input is an HTML string
 * a caller has already obtained, which is what lets the whole of this module be tested
 * offline against the captures in `db/fixtures/`. Discovering which companies exist, and
 * inserting what comes out of here, is Ticket #28.
 *
 * Per CLAUDE.md, scraped data is hostile: every field crosses a Zod schema on the way in,
 * a page that has changed shape is rejected by name rather than half-filled, and a rejected
 * candidate is counted rather than dropped.
 *
 * What a parsed Profile is, and how it carries provenance, is shared with every other Source
 * in `scraped-profile.ts`; the headcount bands `stage` comes from are in `stage.ts`.
 */

export type CompanyPageResult = ScrapedProfileResult;

/**
 * The shape a YC company page's embedded payload has to have for a Profile to be readable
 * from it. Deliberately loose about keys we do not use — the payload carries dozens, and a
 * new one is not a reason to stop ingesting — and strict about the ones we do, so a field
 * that disappears or changes type fails here, naming itself, rather than arriving as
 * `undefined` further down.
 */
const ycCompanySchema = z.looseObject({
  name: z.string(),
  one_liner: z.string().nullish(),
  long_description: z.string().nullish(),
  tags: z.array(z.string()),
  website: z.string().nullish(),
  team_size: z.number().nullish(),
});

const ycPagePayloadSchema = z.looseObject({
  props: z.looseObject({ company: ycCompanySchema }),
});

/**
 * A company page is an Inertia app: the server renders the record it would have rendered
 * into the DOM as a JSON payload on a `data-page` attribute instead. That attribute is the
 * whole of the machine-readable content, which is why this parser reads it rather than
 * scraping the surrounding markup — the markup is a rendering of this, not a second source.
 *
 * The value is HTML-escaped inside a double-quoted attribute, so it cannot itself contain a
 * bare `"`, and matching to the next one is safe.
 */
const DATA_PAGE_PATTERN = /\sdata-page="([^"]*)"/;

/** A trimmed value, or undefined when the source held nothing worth carrying. */
function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

function rejected(
  field: string,
  reason: string,
  raw: unknown,
): CompanyPageResult {
  return { success: false, rejection: { field, reason, raw } };
}

/**
 * Parses one company page. Returns the validated record, or a rejection naming the single
 * field that stopped it — whether that field was missing from the page, was not the type the
 * page used to hold, or failed `profileInputSchema` once extracted.
 *
 * Never throws: malformed HTML, absent payload and unparseable JSON are all rejections, so a
 * batch of pages cannot be aborted by one bad member.
 */
export function parseCompanyPage(
  html: string,
  capture: Capture,
): CompanyPageResult {
  const match = DATA_PAGE_PATTERN.exec(html);

  if (match?.[1] === undefined) {
    return rejected(
      "data-page",
      "no Inertia page payload found in the HTML",
      html,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeEntities(match[1]));
  } catch {
    return rejected("data-page", "page payload was not valid JSON", html);
  }

  const page = ycPagePayloadSchema.safeParse(payload);

  if (!page.success) {
    // A failed safeParse always carries at least one issue.
    const issue = page.error.issues[0]!;
    return rejected(issueField(issue), issue.message, payload);
  }

  const company = page.data.props.company;
  const rawSector = trimmed(company.tags[0]);
  const candidate: Record<string, unknown> = {
    name: trimmed(company.name),
    // The long description is the page's own prose about the company; the one-liner is the
    // same thing at a length that still says something, and is what a Profile falls back to
    // rather than being rejected for a field the page does carry in another slot.
    description:
      trimmed(company.long_description) ?? trimmed(company.one_liner),
    // YC's `tags` are its industry labels, most general first, which is what `sector` means
    // here. A page that lists none has no sector, and is rejected for it; one that does is
    // mapped onto the controlled vocabulary. See `lib/ingest/sector.ts`.
    sector: rawSector === undefined ? undefined : sectorFromRawText(rawSector),
    // Derived from headcount, never stated by the page: a YC page carries batch, founding
    // year, status and team size, and no funding round at all. A page with no usable team
    // size yields no stage, and the candidate is rejected naming `stage`. See docs/adr/0007.
    stage: stageFromTeamSize(company.team_size),
  };

  const website = trimmed(company.website);
  if (website !== undefined) {
    candidate.website = website;
  }

  const input = parseProfileInput(candidate);

  if (!input.success) {
    return { success: false, rejection: input.rejection };
  }

  const scraped = attribute(capture, "scraped");

  return {
    success: true,
    profile: {
      input: input.data,
      attribution: {
        name: scraped,
        description: scraped,
        sector: scraped,
        // Derived from headcount, not stated by the page. See above.
        stage: attribute(capture, "enriched"),
        website: input.data.website === undefined ? null : scraped,
      },
    },
  };
}

export type CompanyPage = {
  readonly html: string;
  readonly capture: Capture;
};

/**
 * The result of parsing a batch. `rejections.length` is the rejected-candidate count: a
 * source that has quietly changed shape shows up here as a rising number with a field name
 * attached, rather than as a batch that simply returned fewer Profiles than it used to.
 */
export type CompanyPageBatch = {
  readonly profiles: readonly ScrapedProfile[];
  readonly rejections: readonly IngestRejection[];
};

export function parseCompanyPages(
  pages: Iterable<CompanyPage>,
): CompanyPageBatch {
  const profiles: ScrapedProfile[] = [];
  const rejections: IngestRejection[] = [];

  for (const page of pages) {
    const result = parseCompanyPage(page.html, page.capture);

    if (result.success) {
      profiles.push(result.profile);
    } else {
      rejections.push(result.rejection);
    }
  }

  return { profiles, rejections };
}
