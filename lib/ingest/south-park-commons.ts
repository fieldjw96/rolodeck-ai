import { z } from "zod";

import {
  parseProfileInput,
  type IngestRejection,
} from "../../db/profile-input";
import { issueField } from "../zod/issues";
import {
  attribute,
  type Capture,
  type ScrapedProfile,
  type ScrapedProfileResult,
} from "./scraped-profile";

/**
 * Parses South Park Commons's own "Companies" page into validated `ProfileInput` records.
 *
 * Parsing only: nothing here fetches, and nothing here writes, which is what lets this be
 * tested offline against the capture in `db/fixtures/`. South Park Commons runs no batches
 * the way HF0 does — it is a fellowship whose members go on to found companies at any stage —
 * but every company on this page passed through the same admission the Ticket cares about:
 * picked before it had traction to show, which is what `stage: pre-seed` records here. Later
 * growth (the page's own `status` can read "Unicorn") does not change that; South Park Commons
 * is not restating a company's current stage, it is recording the one fact this Source states
 * about all of them, which is that South Park Commons chose to back it early.
 *
 * Per CLAUDE.md, scraped data is hostile: every field crosses a Zod schema, and a page that has
 * changed shape is rejected by name rather than half-filled.
 */

export const SOUTH_PARK_COMMONS_SOURCE = "south-park-commons";

/**
 * The page renders its own list from this payload, embedded as a JSON script tag rather than
 * fetched client-side — an Astro island hydrates a search widget from it, but the full list a
 * crawler sees is already here on first load. Loose about keys this Source has no use for
 * (`id`, `slug`, `founded`, `status`, `location`, the thumbnail fields): the page carries more
 * than a Profile needs, and a new one is not a reason to stop ingesting.
 */
const companySchema = z.looseObject({
  name: z.string(),
  bio: z.string().nullish(),
  industry: z.string().nullish(),
});

const companyDataSchema = z.array(companySchema);

const COMPANY_DATA_PATTERN =
  /<script type="application\/json" id="company-data">([\s\S]*?)<\/script>/;

/** A trimmed value, or undefined when the page held nothing worth carrying. */
function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/**
 * Parses one company record already extracted from the page's payload.
 *
 * Never throws: a record missing a name, a bio or an industry is a rejection naming that
 * field, so one bad record cannot abort a batch of two hundred.
 */
function parseCompany(
  company: z.infer<typeof companySchema>,
  capture: Capture,
): ScrapedProfileResult {
  const input = parseProfileInput({
    name: trimmed(company.name),
    description: trimmed(company.bio),
    sector: trimmed(company.industry),
    // Never stated by the page: South Park Commons's own admission bar, not a round any
    // company here is presently in. See the module comment.
    stage: "pre-seed",
  });

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
        // Derived from the fact of appearing on this page, not read off it. See above.
        stage: attribute(capture, "enriched"),
        website: null,
      },
    },
  };
}

export type SouthParkCommonsBatch = {
  readonly profiles: readonly ScrapedProfile[];
  readonly rejections: readonly IngestRejection[];
};

/**
 * Parses the whole "Companies" page: the embedded payload into records, and every record into
 * a Profile or a named rejection.
 *
 * Never throws: a page with no payload at all, or one that stopped being JSON, is one
 * rejection naming `company-data` rather than a thrown error that aborts the run before it can
 * say why.
 */
export function parseSouthParkCommonsCompanies(
  html: string,
  capture: Capture,
): SouthParkCommonsBatch {
  const match = COMPANY_DATA_PATTERN.exec(html);

  if (match?.[1] === undefined) {
    return {
      profiles: [],
      rejections: [
        {
          field: "company-data",
          reason: "no embedded company-data script found in the page",
          raw: html,
        },
      ],
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return {
      profiles: [],
      rejections: [
        {
          field: "company-data",
          reason: "embedded company-data was not valid JSON",
          raw: match[1],
        },
      ],
    };
  }

  const parsed = companyDataSchema.safeParse(payload);

  if (!parsed.success) {
    // A failed safeParse always carries at least one issue.
    const issue = parsed.error.issues[0]!;
    return {
      profiles: [],
      rejections: [
        { field: issueField(issue), reason: issue.message, raw: payload },
      ],
    };
  }

  const profiles: ScrapedProfile[] = [];
  const rejections: IngestRejection[] = [];

  for (const company of parsed.data) {
    const result = parseCompany(company, capture);

    if (result.success) {
      profiles.push(result.profile);
    } else {
      rejections.push(result.rejection);
    }
  }

  return { profiles, rejections };
}
