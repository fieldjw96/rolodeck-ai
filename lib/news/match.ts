import { sectorSchema, type Sector } from "../../db/profile-input";

/**
 * How sure News has to be that an article is about a Kept Company Profile before the owner is
 * shown it. The one place this number lives: the read path in `db/news.ts` imports it, and
 * nothing else compares a `confidence` against a literal.
 *
 * 0.6 is the score of the weakest article this rule can be said to have *placed*: the name
 * mentioned in the headline plus one term from the company's own Sector. The article just
 * below it — the name in the headline plus generic business words ("raises", "CEO"), with no
 * Sector evidence — is exactly what a bigger company sharing the name also produces, so it is
 * stored and not shown. See docs/adr/0010, and expect this to be retuned: every candidate is
 * stored with its score so that retuning is a change to this constant rather than a re-fetch.
 */
export const NEWS_DISPLAY_THRESHOLD = 0.6;

/** The two things about a Company Profile the rule reads. */
export type MatchSubject = {
  readonly name: string;
  readonly sector: string;
};

/** The two things about an article the rule reads. A feed item carries a headline and a
 * standfirst and not the body, so the rule is written against those. */
export type MatchArticle = {
  readonly title: string;
  readonly description: string | null;
};

/**
 * The weights, named so a test failure and a retune both talk about the same things. Chosen so
 * that the largest possible score is 0.95, not 1: nothing a headline and a standfirst say makes
 * a match certain.
 */
export const MATCH_WEIGHTS = {
  /** The name, as a proper noun, in the headline: the article is about it, or about a namesake. */
  titleMention: 0.4,
  /** The name, as a proper noun, only in the standfirst: it may be one company among several. */
  descriptionMention: 0.25,
  /** One term from the company's own Sector, somewhere other than inside the name itself. */
  sectorEvidence: 0.2,
  /** Two or more distinct Sector terms. */
  strongSectorEvidence: 0.3,
  /** The vocabulary of a company being written about: funding, founders, launches. */
  companyContext: 0.15,
  /** A name unlikely to be an ordinary word: more than one word, an internal capital, a digit. */
  distinctiveName: 0.1,
} as const;

/**
 * A mention in lower case — "ramp up", "a notion of" — is far more often the ordinary word than
 * the company, so it counts for this fraction of a proper-noun mention rather than nothing.
 */
const LOWER_CASE_MENTION_FACTOR = 0.5;

/**
 * Terms that say an article is about a company working in a given Sector. Deliberately short
 * and concrete: a term that appears in most business writing ("platform", "technology") would
 * turn every namesake into Sector evidence. `other` has none, which caps a Company Profile in
 * `other` below the threshold unless its name is distinctive and the article reads as company
 * news — the honest consequence of not knowing what it does.
 */
const SECTOR_TERMS: Readonly<Record<Sector, readonly string[]>> = {
  "ai-ml": [
    "ai",
    "artificial intelligence",
    "machine learning",
    "llms?",
    "language models?",
    "generative",
    "neural",
    "inference",
    "ai agents?",
  ],
  "developer-tools": [
    "developers?",
    "devtools",
    "apis?",
    "sdks?",
    "open[- ]source",
    "coding",
    "github",
    "software engineers?",
  ],
  "data-infrastructure": [
    "data",
    "databases?",
    "analytics",
    "pipelines?",
    "data warehouses?",
    "infrastructure",
    "cloud",
  ],
  "saas-enterprise": [
    "saas",
    "enterprises?",
    "b2b",
    "workflows?",
    "productivity",
    "crm",
    "business software",
  ],
  fintech: [
    "fintech",
    "payments?",
    "banking",
    "banks?",
    "cards?",
    "lending",
    "loans?",
    "expenses?",
    "invoic\\w*",
    "treasury",
    "stablecoins?",
    "financial",
  ],
  "health-bio": [
    "health\\s?care",
    "health",
    "medical",
    "clinical",
    "patients?",
    "biotech",
    "drugs?",
    "therap\\w*",
    "fda",
    "hospitals?",
  ],
  security: [
    "security",
    "cyber\\w*",
    "breach\\w*",
    "vulnerabilit\\w*",
    "ransomware",
    "threats?",
    "identity",
    "compliance",
  ],
  "hardware-robotics": [
    "robot\\w*",
    "hardware",
    "chips?",
    "semiconductors?",
    "drones?",
    "autonomous",
    "manufacturing",
    "aerospace",
    "satellites?",
  ],
  "climate-energy": [
    "climate",
    "carbon",
    "energy",
    "solar",
    "batter(?:y|ies)",
    "emissions",
    "grid",
    "renewables?",
  ],
  "consumer-marketplace": [
    "marketplaces?",
    "consumers?",
    "shoppers?",
    "e-?commerce",
    "retail\\w*",
    "sellers?",
    "buyers?",
  ],
  "vertical-saas": [
    "restaurants?",
    "construction",
    "law firms?",
    "legal",
    "recruiting",
    "hiring",
    "schools?",
    "insurance",
    "real estate",
    "logistics",
  ],
  other: [],
};

/** Written about as a company, rather than merely named. */
const COMPANY_CONTEXT_TERMS: readonly string[] = [
  "start-?ups?",
  "raise[sd]?",
  "raising",
  "funding",
  "seed round",
  "series [a-e]",
  "valuation",
  "investors?",
  "venture",
  "co-?founders?",
  "founders?",
  "ceo",
  "launch(?:es|ed)?",
  "acquire[sd]?",
  "acquisition",
];

/** Letters and digits in any script, so a boundary is never drawn inside "Zoë" or "Nº1". */
const WORD_CHAR = "[\\p{L}\\p{N}]";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word, case-insensitive pattern for one term or one name. */
function wholeWord(source: string, flags = "iu"): RegExp {
  return new RegExp(`(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})`, flags);
}

const termPatterns = (terms: readonly string[]): readonly RegExp[] =>
  terms.map((term) => wholeWord(term));

const SECTOR_PATTERNS: Readonly<Record<Sector, readonly RegExp[]>> =
  Object.fromEntries(
    Object.entries(SECTOR_TERMS).map(([sector, terms]) => [
      sector,
      termPatterns(terms),
    ]),
  ) as Record<Sector, readonly RegExp[]>;

const COMPANY_CONTEXT_PATTERNS = termPatterns(COMPANY_CONTEXT_TERMS);

/**
 * The name as a pattern: escaped, since "Fig." and "C++ Labs" are names, and with its internal
 * whitespace loosened so a line-wrapped or double-spaced mention still counts.
 */
function namePattern(name: string): RegExp {
  const source = name.trim().split(/\s+/).map(escapeRegExp).join("\\s+");

  return wholeWord(source, "giu");
}

/**
 * How strongly `text` mentions `name`: 1 for a proper-noun mention, a fraction for a lower-case
 * one, 0 for none. A mention is a proper noun when it is spelled exactly as the Company Profile
 * spells it, or starts with a capital — which is also what a sentence-initial "Ramp up" does,
 * and is why a title mention alone never reaches the threshold.
 */
function mentionStrength(name: string, text: string): number {
  let strength = 0;

  for (const match of text.matchAll(namePattern(name))) {
    const mention = match[0];
    const first = mention.charAt(0);

    if (
      mention === name.trim() ||
      (first !== first.toLowerCase() && first === first.toUpperCase())
    ) {
      return 1;
    }

    strength = LOWER_CASE_MENTION_FACTOR;
  }

  return strength;
}

const countMatching = (patterns: readonly RegExp[], text: string): number =>
  patterns.filter((pattern) => pattern.test(text)).length;

function sectorPatterns(sector: string): readonly RegExp[] {
  const parsed = sectorSchema.safeParse(sector);
  return parsed.success ? SECTOR_PATTERNS[parsed.data] : [];
}

/** More than one word, a capital after a lower-case letter ("PostHog"), or a digit ("11x"). */
function isDistinctiveName(name: string): boolean {
  const trimmed = name.trim();
  return (
    /\s/.test(trimmed) || /\p{Ll}\p{Lu}/u.test(trimmed) || /\d/.test(trimmed)
  );
}

/**
 * How confident News is that `article` is about `subject`, from 0 to 0.95, rounded to two
 * decimal places.
 *
 * The rule, in order:
 *
 * 1. No mention of the company's name in the headline or standfirst scores 0 and nothing else is
 *    considered. A provider's search is looser than a whole-word mention — it may match inside
 *    a longer word, or on content this rule never sees — so a result is not itself a mention.
 * 2. A mention scores `titleMention` in the headline or `descriptionMention` only in the
 *    standfirst, halved when every mention is lower case.
 * 3. Sector evidence — terms from the company's own Sector, counted with the name's own words
 *    removed, so "Acme Robotics" is not its own evidence of robotics — adds `sectorEvidence` for
 *    one distinct term and `strongSectorEvidence` for two or more.
 * 4. Company context — funding, founders, launches — adds `companyContext`.
 * 5. A distinctive name adds `distinctiveName`: "Mercury" is a planet, an element and a car
 *    before it is a bank, and "Mercury Robotics" is none of those.
 *
 * Additive rather than learned, on purpose: Jack has accepted that matching is noisy, and what
 * matters is that each stored score can be explained by reading this function.
 */
export function scoreNewsMatch(
  subject: MatchSubject,
  article: MatchArticle,
): number {
  // A blank name would compile to a pattern that matches the empty string everywhere, and read
  // as a mention in every article. `profileInputSchema` refuses one; this does not rely on it.
  if (subject.name.trim() === "") {
    return 0;
  }

  const description = article.description ?? "";
  const titleStrength = mentionStrength(subject.name, article.title);
  const descriptionStrength = mentionStrength(subject.name, description);

  const mention =
    titleStrength > 0
      ? MATCH_WEIGHTS.titleMention * titleStrength
      : MATCH_WEIGHTS.descriptionMention * descriptionStrength;

  if (mention === 0) {
    return 0;
  }

  const text = `${article.title}\n${description}`;
  const withoutName = text.replace(namePattern(subject.name), " ");

  const sectorTerms = countMatching(
    sectorPatterns(subject.sector),
    withoutName,
  );
  const sector =
    sectorTerms >= 2
      ? MATCH_WEIGHTS.strongSectorEvidence
      : sectorTerms === 1
        ? MATCH_WEIGHTS.sectorEvidence
        : 0;

  const context =
    countMatching(COMPANY_CONTEXT_PATTERNS, withoutName) > 0
      ? MATCH_WEIGHTS.companyContext
      : 0;

  const distinctive = isDistinctiveName(subject.name)
    ? MATCH_WEIGHTS.distinctiveName
    : 0;

  // Rounded so a score is a number a person can read in a table and compare to the threshold
  // exactly: 0.4 + 0.2 is 0.6000000000000001 in floating point, and 0.6 once rounded.
  return Math.round((mention + sector + context + distinctive) * 100) / 100;
}
