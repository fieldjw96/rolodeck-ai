import {
  parseProfileInput,
  type IngestRejection,
} from "../../db/profile-input";
import { decodeEntities } from "./entities";
import { sectorFromRawText } from "./sector";
import {
  attribute,
  type Capture,
  type ScrapedProfile,
  type ScrapedProfileResult,
} from "./scraped-profile";

/**
 * Parses AngelPad's own "Alumni Portfolio" page into validated `ProfileInput` records.
 *
 * Parsing only: nothing here fetches, and nothing here writes, which is what lets this be
 * tested offline against the capture in `db/fixtures/`. The page lists every alumnus AngelPad
 * has ever admitted, not one current batch, but admission to AngelPad happens at the same
 * point for all of them — which is what `stage: pre-seed` records here regardless of what a
 * company has gone on to become. See `south-park-commons.ts` for the same judgement made about
 * a differently-shaped page.
 *
 * Per CLAUDE.md, scraped data is hostile, and this page is a real example of it: each entry's
 * write-up was pasted into a WordPress portfolio widget as a whole HTML document, so it is
 * nested, unescaped, inside the page's own markup rather than written as page prose. The
 * pattern below reads through that rather than around it, and a page where it stops matching
 * fails with no records and one rejection saying so, rather than a handful of accidental
 * matches read from the wrong place.
 *
 * The page's own intro claims "over 150 companies in the portfolio"; what a plain fetch of it
 * actually server-renders is the widget's first page of results (an Isotope grid with an
 * admin-ajax.php pagination endpoint for the rest). That is still real, still parseable HTML
 * and a real batch of Profiles — around forty of them — not the client-rendered empty grid
 * Alchemist's portfolio page ships.
 */

export const ANGELPAD_SOURCE = "angelpad";

/**
 * The portfolio grid's own filter categories, read off the filter bar at the top of the page
 * and kept as a fixed table rather than parsed fresh from it: category labels are UI copy
 * ("Ads", "Gig Economy"), and an entry's `data-filter` attribute also carries values that are
 * not categories at all — an AngelPad batch code (`ap1f`), or `featured` — which this table
 * exists to tell apart from an actual sector. An entry whose filters match none of these is
 * rejected naming `sector`, the same as a page that stopped stating one at all.
 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  "ad-tech": "Ads",
  "big-data": "Data",
  "dev-tools": "Dev Tools",
  exited: "Exited",
  sharing: "Gig Economy",
  health: "Health",
  hr: "HR",
  marketing: "Marketing",
  marketplace: "Marketplace",
  mobilef: "Mobile",
  mobility: "Mobility",
  saasf: "SaaS",
};

/**
 * One portfolio entry: its filter tags, its title link, and the nested document its write-up
 * was pasted into. Anchored on `gw-gopf-col-wrap" data-filter="` rather than a bare
 * `data-filter="`, because the filter *bar* above the grid carries its own `data-filter`
 * attributes (one category per span) that would otherwise be the nearest match for the first
 * entry on the page and misattribute its sector. `[\s\S]*?` between the filter tags and the
 * title is what lets this survive the image markup every entry carries between the two without
 * needing to model it; matched non-greedily and restarted after each match, an entry's own
 * filters are always the nearest ones before its own title.
 */
const ITEM_PATTERN =
  /gw-gopf-col-wrap" data-filter="([^"]*)"[\s\S]*?gw-gopf-post-title"><b><a[^>]*>([^<]*)<\/a><\/b>\s*<!DOCTYPE[^>]*><html><body[^>]*>([\s\S]*?)<\/body><\/html>/g;

/** A trimmed value, or undefined when there was nothing worth carrying. */
function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/** Strips the write-up's own markup (`<br>`, `<b>`) down to the text it wraps. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function sectorOf(filterAttribute: string): string | undefined {
  for (const token of filterAttribute.split(/\s+/)) {
    const label = CATEGORY_LABELS[token];
    if (label !== undefined) {
      return label;
    }
  }
  return undefined;
}

function parseEntry(
  filterAttribute: string,
  rawName: string,
  descriptionHtml: string,
  capture: Capture,
): ScrapedProfileResult {
  const input = parseProfileInput({
    name: trimmed(decodeEntities(rawName)),
    description: trimmed(textOf(descriptionHtml)),
    // The filter attribute is free text; the column takes the controlled vocabulary, so it
    // is mapped here as every other Source does. See `lib/ingest/sector.ts`.
    sector:
      sectorOf(filterAttribute) === undefined
        ? undefined
        : sectorFromRawText(sectorOf(filterAttribute)!),
    // Never stated by the page: AngelPad's own admission bar. See the module comment.
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
        // The page's own link is AngelPad's write-up of the company, not reliably the
        // company's own site — it is `http://Iterable.com` for one entry and
        // `https://angelpad.com/b/p/postmates/` for the next. Attributing either
        // indiscriminately as a company's website would misrecord it, so this Source
        // states none.
        website: null,
        // Never stated by AngelPad's own page.
        location: null,
        // This Source states no team and no company links, and must not guess at either.
        founders: null,
        links: null,
      },
    },
  };
}

export type AngelPadBatch = {
  readonly profiles: readonly ScrapedProfile[];
  readonly rejections: readonly IngestRejection[];
};

/**
 * Parses the whole "Alumni Portfolio" page: every entry the widget's markup carries, into a
 * Profile or a named rejection.
 *
 * Never throws. A page carrying no entries at all — the widget renamed, or the page stopped
 * being this layout entirely — is one rejection naming `gw-gopf-post-title` rather than a
 * batch that silently came back empty.
 */
export function parseAngelPadPortfolio(
  html: string,
  capture: Capture,
): AngelPadBatch {
  const profiles: ScrapedProfile[] = [];
  const rejections: IngestRejection[] = [];

  ITEM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ITEM_PATTERN.exec(html)) !== null) {
    const [, filterAttribute = "", rawName = "", descriptionHtml = ""] = match;
    const result = parseEntry(
      filterAttribute,
      rawName,
      descriptionHtml,
      capture,
    );

    if (result.success) {
      profiles.push(result.profile);
    } else {
      rejections.push(result.rejection);
    }
  }

  if (profiles.length === 0 && rejections.length === 0) {
    return {
      profiles,
      rejections: [
        {
          field: "gw-gopf-post-title",
          reason: "no portfolio entries found in the page",
          raw: html,
        },
      ],
    };
  }

  return { profiles, rejections };
}
