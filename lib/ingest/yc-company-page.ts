import { z } from "zod";

import {
  NOT_STATED_STAGE,
  parseProfileInput,
  type IngestRejection,
  type Sector,
} from "../../db/profile-input";
import { logLine } from "../observability/log";
import { issueField } from "../zod/issues";
import { decodeEntities } from "./entities";
import {
  attribute,
  type Capture,
  type FieldProvenance,
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
/**
 * One entry in the page's `founders`. Loose for the same reason the company is: the payload
 * also carries `avatar_thumb_url` and `has_email`, which are deliberately never read. There is
 * no photograph, and YC states only that an email exists for its own introduction flow, never
 * the address.
 */
const ycFounderSchema = z.looseObject({
  full_name: z.string(),
  title: z.string().nullish(),
  founder_bio: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  twitter_url: z.string().nullish(),
});

const ycCompanySchema = z.looseObject({
  name: z.string(),
  one_liner: z.string().nullish(),
  long_description: z.string().nullish(),
  tags: z.array(z.string()),
  website: z.string().nullish(),
  team_size: z.number().nullish(),
  founders: z.array(ycFounderSchema).nullish(),
  linkedin_url: z.string().nullish(),
  twitter_url: z.string().nullish(),
  github_url: z.string().nullish(),
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

/**
 * An object holding only the entries with a value, so that a page's empty string becomes an
 * absent key rather than a value `profileInputSchema` would reject as blank or not a URL.
 */
function stated<T extends Record<string, string | undefined>>(
  entries: T,
): Partial<Record<keyof T, string>> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as Partial<Record<keyof T, string>>;
}

/**
 * The founders as the page states them, or undefined when it states none. Never an empty list:
 * a page with no founders has not said the company has none. See `founderListSchema`.
 *
 * Every founder is kept, whatever else they lack. An empty biography, which Stripe's founders
 * have, is an absent `bio` rather than a reason to drop the founder or the company.
 */
function foundersFrom(
  founders: readonly z.infer<typeof ycFounderSchema>[] | null | undefined,
): Record<string, string>[] | undefined {
  if (founders === null || founders === undefined || founders.length === 0) {
    return undefined;
  }

  return founders.map((founder) =>
    stated({
      // Not trimmed away to nothing silently: a blank name is left in place for
      // `founderSchema` to reject, naming the field.
      name: founder.full_name.trim(),
      role: trimmed(founder.title),
      bio: trimmed(founder.founder_bio),
      linkedin: trimmed(founder.linkedin_url),
      twitter: trimmed(founder.twitter_url),
    }),
  );
}

function rejected(
  field: string,
  reason: string,
  raw: unknown,
): CompanyPageResult {
  return { success: false, rejection: { field, reason, raw } };
}

/**
 * A page that lists no industry tag at all still needs a sector: `other` is what
 * `SECTOR_VALUES` carries for exactly this, per its own comment in `db/profile-input.ts`. This
 * is not the same event `sectorFromRawText` logs for a raw value it does not recognise — a
 * company that stated nothing is not evidence the taxonomy is missing a member, and counting it
 * the same way would pollute the signal that decides when `SECTOR_VALUES` should grow.
 */
function sectorForAbsentTag(): Sector {
  logLine({ level: "info", event: "sector_absent" });
  return "other";
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
    // here. One that states a tag is mapped onto the controlled vocabulary; one that lists none
    // is kept with sector `other` rather than thrown away. See `lib/ingest/sector.ts` and
    // `sectorForAbsentTag` above.
    sector:
      rawSector === undefined
        ? sectorForAbsentTag()
        : sectorFromRawText(rawSector),
    // Derived from headcount, never stated by the page: a YC page carries batch, founding
    // year, status and team size, and no funding round at all. A page with no usable team
    // size yields no stage to derive, and the company is kept with its stage `not-stated`
    // rather than thrown away. See docs/adr/0007 and docs/adr/0015.
    stage: stageFromTeamSize(company.team_size) ?? NOT_STATED_STAGE,
  };

  const website = trimmed(company.website);
  if (website !== undefined) {
    candidate.website = website;
  }

  const founders = foundersFrom(company.founders);
  if (founders !== undefined) {
    candidate.founders = founders;
  }

  const links = stated({
    linkedin: trimmed(company.linkedin_url),
    twitter: trimmed(company.twitter_url),
    github: trimmed(company.github_url),
  });
  if (Object.keys(links).length > 0) {
    candidate.links = links;
  }

  const input = parseProfileInput(candidate);

  if (!input.success) {
    return { success: false, rejection: input.rejection };
  }

  const scraped = attribute(capture, "scraped");
  // The page stated a tag and it was mapped onto the vocabulary: `scraped`. The page stated
  // none and the pipeline chose `other`: `enriched`, same reasoning as `stage` below.
  const sectorProvenance: FieldProvenance =
    rawSector === undefined ? attribute(capture, "enriched") : scraped;

  return {
    success: true,
    profile: {
      input: input.data,
      attribution: {
        name: scraped,
        description: scraped,
        sector: sectorProvenance,
        // Derived from headcount, or `not-stated` for want of one: either way the page did not
        // state it. See above.
        stage: attribute(capture, "enriched"),
        website: input.data.website === undefined ? null : scraped,
        // A YC company page carries no headquarters address at all.
        location: null,
        // Read from the page as it states them, nothing derived, so `scraped` when present.
        founders: input.data.founders === undefined ? null : scraped,
        links: input.data.links === undefined ? null : scraped,
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
