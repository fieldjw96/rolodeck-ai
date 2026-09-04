import { z } from "zod";

import {
  parseProfileInput,
  type IngestRejection,
  type ProfileInput,
  type Stage,
} from "../../db/profile-input";
import type {
  ProfileProvenance,
  Provenance,
  ProvenancedField,
} from "../../db/provenance";
import { issueField } from "../zod/issues";

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
 */

/**
 * Where a fixture, or a live fetch, came from. The HTML itself carries no record of when it
 * was retrieved, so provenance only survives if the caller supplies it alongside — which is
 * what the `.meta.json` sibling of each fixture is for.
 */
export const captureSchema = z.strictObject({
  sourceUrl: z.url({ protocol: /^https?$/ }),
  capturedAt: z.iso.date(),
});

export type Capture = z.infer<typeof captureSchema>;

/**
 * Provenance for one Profile field, per CONTEXT.md: carried per field rather than per
 * Profile, and recording not just *what kind* of value it is but the page and the day it
 * came from, so a Profile stays auditable long after the source page has moved on.
 */
export type FieldProvenance = Capture & {
  readonly provenance: Provenance;
};

/**
 * A field with no value has no provenance: `website` is the one optional Profile field, so
 * it is the one entry that can be null here. This mirrors the shape the `profiles` check
 * constraint enforces — see docs/adr/0003.
 */
export type ProfileAttribution = Readonly<
  Record<Exclude<ProvenancedField, "website">, FieldProvenance>
> & {
  readonly website: FieldProvenance | null;
};

export type ScrapedProfile = {
  readonly input: ProfileInput;
  readonly attribution: ProfileAttribution;
};

export type CompanyPageResult =
  | { readonly success: true; readonly profile: ScrapedProfile }
  | { readonly success: false; readonly rejection: IngestRejection };

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

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * Decodes the entities Rails' escaper emits, in a single pass. The pass matters: unescaping
 * `&amp;` first would turn a literal `&amp;quot;` in the company's own description into a
 * quote character and corrupt the JSON around it.
 *
 * An entity this does not recognise, or a numeric one outside Unicode, is left as written
 * rather than thrown on — a parser whose job is to reject loudly must still reach the point
 * where it can say which field was wrong.
 */
function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      if (!entity.startsWith("#")) {
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
      }

      const hex = entity.startsWith("#x") || entity.startsWith("#X");
      const code = Number.parseInt(
        hex ? entity.slice(2) : entity.slice(1),
        hex ? 16 : 10,
      );

      return Number.isInteger(code) && code >= 0 && code <= MAX_CODE_POINT
        ? String.fromCodePoint(code)
        : match;
    },
  );
}

/**
 * `stage` is the one Profile field a YC company page does not state. The page carries batch,
 * founding year, status and headcount, but never a funding round, so the value is derived
 * from team size — the only signal on the page that moves in step with stage — against the
 * conventional headcount bands.
 *
 * Because it is derived rather than read, it is attributed `enriched` and not `scraped`: a
 * Profile must never claim YC said something YC did not. A page with no usable team size
 * yields no stage at all, and the candidate is rejected naming `stage`, rather than being
 * filled in with a guess. See docs/adr/0007.
 */
const STAGE_BY_MINIMUM_TEAM_SIZE = [
  [500, "growth"],
  [100, "series-b-plus"],
  [25, "series-a"],
  [5, "seed"],
  [1, "pre-seed"],
] as const satisfies ReadonlyArray<readonly [number, Stage]>;

function stageFromTeamSize(
  teamSize: number | null | undefined,
): Stage | undefined {
  if (typeof teamSize !== "number" || !Number.isFinite(teamSize)) {
    return undefined;
  }

  return STAGE_BY_MINIMUM_TEAM_SIZE.find(
    ([minimum]) => teamSize >= minimum,
  )?.[1];
}

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

function attribute(capture: Capture, provenance: Provenance): FieldProvenance {
  return { ...capture, provenance };
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
    payload = JSON.parse(decodeHtmlEntities(match[1]));
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
  const candidate: Record<string, unknown> = {
    name: trimmed(company.name),
    // The long description is the page's own prose about the company; the one-liner is the
    // same thing at a length that still says something, and is what a Profile falls back to
    // rather than being rejected for a field the page does carry in another slot.
    description:
      trimmed(company.long_description) ?? trimmed(company.one_liner),
    // YC's `tags` are its industry labels, most general first, which is what `sector` means
    // here. A page that lists none has no sector, and is rejected for it.
    sector: trimmed(company.tags[0]),
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

/**
 * Narrows per-field attribution to the shape the `profiles.provenance` jsonb column takes,
 * dropping the source URL and capture date the column has no room for. The bridge lives here
 * so that the richer record is what ingest works with and the column stays exactly as
 * docs/adr/0003 defines it.
 */
export function toProfileProvenance(
  attribution: ProfileAttribution,
): ProfileProvenance {
  return {
    name: attribution.name.provenance,
    description: attribution.description.provenance,
    sector: attribution.sector.provenance,
    stage: attribution.stage.provenance,
    website: attribution.website?.provenance ?? null,
  };
}
