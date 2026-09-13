import { z } from "zod";

import {
  parseProfileInput,
  type IngestRejection,
  type ProfileInput,
} from "../../db/profile-input";
import type {
  ProfileProvenance,
  Provenance,
  ProvenancedField,
} from "../../db/provenance";
import { issueField } from "../zod/issues";
import { sectorFromRawText } from "./sector";

/**
 * Parses Show HN posts, read from Algolia's Hacker News Search API, into validated
 * `ProfileInput` records.
 *
 * Parsing only: nothing here fetches, and nothing here writes — same split as
 * `yc-company-page.ts`, and for the same reason: it is what lets this whole module be tested
 * offline against the captures in `db/fixtures/`. Reading the API live is `scripts/fetch-show-hn.ts`.
 *
 * Per CLAUDE.md, scraped data is hostile: every field crosses a Zod schema on the way in, and
 * a post this cannot confidently read as a company is rejected by name rather than guessed at.
 *
 * `stage` is fixed at `pre-seed` for every record this module produces, attributed `enriched`
 * rather than `scraped`. A Show HN post states nothing about funding at all — unlike a YC page,
 * which at least states headcount for `stage` to be derived from (docs/adr/0007) — so this is
 * not a per-company inference but a population assumption: most things posted to Show HN are
 * pre-seed or pre-company, so most of what this Source finds probably is too, and nothing on
 * any one post confirms it. `enriched` is what keeps that visible rather than folklore, and it
 * is what lets a later Source that finds a real funding round overwrite this one field.
 */

/**
 * Where a fixture, or a live fetch, came from. Algolia's API is stateless per request, so
 * nothing in the response itself records what was asked for — which is what the `.meta.json`
 * sibling of each fixture supplies, the same role `yc-company-page.ts`'s `Capture` plays.
 */
export const captureSchema = z.strictObject({
  query: z.string().min(1),
  capturedAt: z.iso.date(),
});

export type Capture = z.infer<typeof captureSchema>;

/** Per-field provenance, carrying the query and day a record was read. See CONTEXT.md. */
export type FieldProvenance = Capture & {
  readonly provenance: Provenance;
};

/**
 * `website` is the one optional Profile field, so it is the one entry that can be null here —
 * a post with no company URL at all never reaches this shape, since it is rejected before one
 * is built. Kept nullable anyway so this type says the same thing `yc-company-page.ts`'s does.
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

export type ShowHnResult =
  | { readonly success: true; readonly profile: ScrapedProfile }
  | { readonly success: false; readonly rejection: IngestRejection };

/**
 * The shape of one hit in an Algolia HN search response, loose about everything this parser
 * does not use — points, comment counts, tags, timestamps — and strict about the four fields it
 * does. `url` and `story_text` are both optional: a Show HN post is either a link post (has a
 * `url`), a text post (has `story_text` and no `url`), or occasionally both.
 */
const showHnHitSchema = z.looseObject({
  objectID: z.string(),
  title: z.string(),
  url: z.string().nullish(),
  story_text: z.string().nullish(),
});

/**
 * The shape of the whole search response this module reads: an array of hits, however many.
 * Exported so `scripts/fetch-show-hn.ts` can check the top-level shape of what it fetched
 * before handing individual hits to `parseShowHnPost`, which validates each of those itself.
 */
export const showHnSearchResponseSchema = z.looseObject({
  hits: z.array(z.unknown()),
});

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const MAX_CODE_POINT = 0x10ffff;

/** Decodes the entities the API escapes `story_text` with. See `yc-company-page.ts`'s twin. */
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
 * `story_text` carries the author's own HTML — `<p>` for paragraph breaks, `<a href>` for
 * links they typed as plain URLs. None of it is a field this parser reads structurally, so it
 * is flattened to plain text rather than parsed: a description with the markup stripped out is
 * still the author's own words, which is what keeps this `scraped` rather than `enriched`.
 */
function plainTextFrom(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** A trimmed value, or undefined when the source held nothing worth carrying. */
function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

function rejected(field: string, reason: string, raw: unknown): ShowHnResult {
  return { success: false, rejection: { field, reason, raw } };
}

function attribute(capture: Capture, provenance: Provenance): FieldProvenance {
  return { ...capture, provenance };
}

const SHOW_HN_TITLE_PREFIX = /^\s*show\s*hn\s*:\s*/i;

/**
 * Show HN titles are conventionally "Show HN: Name – description", using an en or em dash as
 * the separator most of the time and a plain " - " occasionally. Splitting on the first one
 * found is what turns "Name" and "description" into two fields; a title with neither has no
 * separator to find, and the whole remainder is read as the name, with no title-derived
 * description — which `describe` below falls back past, to `story_text` or a rejection.
 */
function splitTitle(title: string): { name: string; tail: string | undefined } {
  const withoutPrefix = title.replace(SHOW_HN_TITLE_PREFIX, "").trim();
  const dashSplit = /^(.*?)[–—](.*)$/.exec(withoutPrefix);
  const hyphenSplit = dashSplit ? null : /^(.*?)\s-\s(.*)$/.exec(withoutPrefix);
  const match = dashSplit ?? hyphenSplit;

  if (match?.[1] !== undefined && match[2] !== undefined) {
    const name = trimmed(match[1]);
    const tail = trimmed(match[2]);
    if (name !== undefined) {
      return { name, tail };
    }
  }

  return { name: withoutPrefix, tail: undefined };
}

/**
 * Hosts that a Show HN URL sometimes points to which are not, themselves, a company: the
 * source code for the thing rather than the thing, a video demonstrating it, or a post about
 * it written somewhere that publishes anyone's writing. Per Ticket #49, none of these count as
 * "a URL to a company site", so a post linking to one is skipped and counted rather than
 * ingested with a website field that is not the company's own.
 *
 * This is a denylist, not a proof: a company that hosts its actual product on a subdomain of
 * one of these (rare) reads as rejected, and a bespoke domain that happens to be a placeholder
 * page reads as accepted. Both are the same judgement call CLAUDE.md leaves to a human for a
 * scraped field that "changes shape" outright; here the shape is simply ambiguous by nature,
 * and erring toward rejecting a possible company is the safer of the two mistakes, matching
 * the sector rule below.
 */
const CODE_HOST_DOMAINS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "sourceforge.net",
  "sr.ht",
  "codeberg.org",
  "gitee.com",
]);

const VIDEO_HOST_DOMAINS = new Set([
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "loom.com",
  "tiktok.com",
]);

const CONTENT_HOST_DOMAINS = new Set([
  "medium.com",
  "substack.com",
  "dev.to",
  "hashnode.dev",
  "blogspot.com",
  "wordpress.com",
  "notion.site",
  "notion.so",
  "tumblr.com",
  "reddit.com",
  "twitter.com",
  "x.com",
  "news.ycombinator.com",
]);

function matchesHost(hostname: string, domains: ReadonlySet<string>): boolean {
  const host = hostname.toLowerCase();
  return [...domains].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

type UrlClassification =
  | { readonly isCompany: true; readonly url: string }
  | { readonly isCompany: false; readonly reason: string };

/** Decides whether a post's URL is to a company site, per the rule Ticket #49 sets. */
function classifyUrl(rawUrl: string): UrlClassification {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { isCompany: false, reason: "is not a valid URL" };
  }

  if (matchesHost(parsed.hostname, CODE_HOST_DOMAINS)) {
    return {
      isCompany: false,
      reason: "links to a code repository, not a company",
    };
  }

  if (matchesHost(parsed.hostname, VIDEO_HOST_DOMAINS)) {
    return {
      isCompany: false,
      reason: "links to a demo video, not a company",
    };
  }

  if (matchesHost(parsed.hostname, CONTENT_HOST_DOMAINS)) {
    return {
      isCompany: false,
      reason: "links to a blog post, not a company",
    };
  }

  return { isCompany: true, url: rawUrl };
}

/**
 * Keyword to sector, checked in order against the post's title and text and stopping at the
 * first match. Order matters where a post's own words could fit more than one — payroll is
 * both HR and Fintech, and Fintech is listed first, so it wins consistently rather than by
 * whichever key iterates first.
 *
 * Deliberately not exhaustive. A post whose words match nothing here is rejected naming
 * `sector` rather than filed under some catch-all, per Ticket #49: guessing a sector with no
 * confidence is worse than not ingesting the post at all.
 */
const SECTOR_KEYWORDS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "Fintech",
    /\b(fintech|payments?|invoic\w*|banking|bank account|spending|budget\w*|expenses?|crypto\w*|defi|stablecoin\w*|wallet\w*|trading|investing|accounting|payroll|billing)\b/i,
  ],
  [
    "Security",
    /\b(security|cybersecurity|encrypt\w*|vulnerabilit\w*|phishing|malware|penetration testing|firewall)\b/i,
  ],
  [
    "Artificial Intelligence",
    /\b(ai agents?|artificial intelligence|machine learning|\bllms?\b|large language models?|chatbots?|neural networks?|generative ai)\b/i,
  ],
  [
    "Healthcare",
    /\b(health\s?care|patients?|clinical|medical|diagnos\w*|therapy|wellness)\b/i,
  ],
  [
    "Education",
    /\b(education|learners?|online course\w*|classroom\w*|tutor\w*|students?)\b/i,
  ],
  [
    "E-commerce",
    /\b(e-?commerce|online stores?|shopping cart\w*|marketplace\w*|retailers?)\b/i,
  ],
  [
    "Productivity",
    /\b(productivity|task manager\w*|to-?do lists?|project management|note-taking|calendar\w*)\b/i,
  ],
  ["Gaming", /\b(video games?|gaming|puzzle games?|arcade)\b/i],
  ["Robotics", /\b(robot\w*|drones?|autonomous vehicles?)\b/i],
  [
    "Climate",
    /\b(climate|carbon\w*|sustainab\w*|renewable energy|solar power)\b/i,
  ],
  ["Legal", /\b(legal\w*|contract review|compliance|law firms?)\b/i],
  ["Real Estate", /\b(real estate|property management|landlords?|tenants?)\b/i],
  ["HR", /\b(hiring|recruit\w*|human resources)\b/i],
  ["Marketing", /\b(marketing|\bseo\b|advertis\w*|ad campaigns?)\b/i],
  [
    "Logistics",
    /\b(logistics|shipping|supply chain\w*|fleet management|warehouses?)\b/i,
  ],
  [
    "Data & Analytics",
    /\b(analytics|dashboards?|data pipelines?|business intelligence|data warehouses?)\b/i,
  ],
  [
    "Developer Tools",
    /\b(developer tools?|devtools|\bapis?\b|\bsdks?\b|\bides?\b|debuggers?|compilers?|package managers?)\b/i,
  ],
];

function deriveSector(text: string): string | undefined {
  const match = SECTOR_KEYWORDS.find(([, pattern]) => pattern.test(text));
  return match?.[0];
}

/**
 * Parses one Show HN post. Returns the validated record, or a rejection naming the field that
 * stopped it: `website` when the post carries no URL, or one that is not to a company; `sector`
 * when nothing in the post's own words says what kind of company it is; anything
 * `profileInputSchema` itself catches otherwise.
 *
 * Never throws: a hostile or reshaped hit is a rejection, so a batch of posts cannot be
 * aborted by one bad member.
 */
export function parseShowHnPost(
  rawHit: unknown,
  capture: Capture,
): ShowHnResult {
  const parsedHit = showHnHitSchema.safeParse(rawHit);

  if (!parsedHit.success) {
    // A failed safeParse always carries at least one issue.
    const issue = parsedHit.error.issues[0]!;
    return rejected(issueField(issue), issue.message, rawHit);
  }

  const hit = parsedHit.data;
  const rawUrl = trimmed(hit.url);

  if (rawUrl === undefined) {
    return rejected("website", "carries no URL to a company site", rawHit);
  }

  const classification = classifyUrl(rawUrl);
  if (!classification.isCompany) {
    return rejected("website", classification.reason, rawHit);
  }

  const { name, tail } = splitTitle(hit.title);
  const storyText = trimmed(hit.story_text);
  const description =
    (storyText === undefined ? undefined : plainTextFrom(storyText)) ?? tail;

  if (description === undefined) {
    return rejected(
      "description",
      "the post says nothing beyond its title",
      rawHit,
    );
  }

  const sector = deriveSector(`${hit.title} ${storyText ?? ""}`);
  if (sector === undefined) {
    return rejected(
      "sector",
      "no sector could be derived from the post's title or text with any confidence",
      rawHit,
    );
  }

  const candidate: Record<string, unknown> = {
    name,
    description,
    // The keyword category is itself derived text, mapped onto the controlled vocabulary the
    // same way every other Source's raw sector text is. See `lib/ingest/sector.ts`.
    sector: sectorFromRawText(sector),
    // A population assumption, not a fact about this post. See the module docstring.
    stage: "pre-seed",
    website: classification.url,
  };

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
        // Derived from keywords, not stated by the post. See `deriveSector`.
        sector: attribute(capture, "enriched"),
        // A population assumption, not read from this post at all. See the module docstring.
        stage: attribute(capture, "enriched"),
        website: scraped,
      },
    },
  };
}

/**
 * The result of parsing a batch. `rejections.length` is the rejected-candidate count Ticket
 * #49 asks for: how many posts were skipped for lacking a company URL or a derivable sector,
 * kept apart from how many became Profiles.
 */
export type ShowHnBatch = {
  readonly profiles: readonly ScrapedProfile[];
  readonly rejections: readonly IngestRejection[];
};

export function parseShowHnPosts(
  hits: Iterable<unknown>,
  capture: Capture,
): ShowHnBatch {
  const profiles: ScrapedProfile[] = [];
  const rejections: IngestRejection[] = [];

  for (const hit of hits) {
    const result = parseShowHnPost(hit, capture);

    if (result.success) {
      profiles.push(result.profile);
    } else {
      rejections.push(result.rejection);
    }
  }

  return { profiles, rejections };
}

/**
 * Narrows per-field attribution to the shape the `profiles.provenance` column takes. See
 * `yc-company-page.ts`'s twin for why the bridge lives beside the parser rather than the
 * write path.
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
