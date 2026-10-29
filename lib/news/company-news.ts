import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";
import type { MatchArticle, MatchSubject } from "./match";

/**
 * Whether a post on a company's own site is news, and what a hit from the history search's
 * `site` query is therefore worth.
 *
 * The `site` query is the precise half of the history search (docs/adr/0018): the host has
 * already been checked to be the Company Profile's own domain, so the post is by the company,
 * about the company, beyond doubt. What `scoreNewsMatch` then does with it is score it 0,
 * because a company's own post rarely puts its own name in its own headline. Keeping those at 0
 * threw away the articles News was most certain about, which docs/adr/0024 is the decision to
 * stop doing.
 *
 * Being certain who a post is by is not a reason to show it, though. Jack's condition, verbatim:
 * "the blog has to be actual news, not just an opinion piece about something in the company for
 * example". So an own-site post reaches the News page only when it reports that something
 * happened at the company — a raise, a launch, an acquisition, a hire, a release. An essay,
 * an opinion piece, a tutorial or a thought-leadership post is stored and never shown.
 *
 * The test is a declared rule anyone can read, like `scoreNewsMatch` itself and for the same
 * reason: what matters is that a stored score can be explained by reading this file. No
 * classifier, no model, no new host.
 */

/** As much of an own-site hit as the rule reads: its headline, and its link. */
export type OwnSitePost = {
  readonly title: string;
  readonly url: string;
};

/**
 * Announcement vocabulary: a headline carrying one of these says something happened. Matched
 * whole-word, anywhere in the headline, in the style of `COMPANY_CONTEXT_TERMS` in `match.ts`.
 *
 * Deliberately concrete. A term that appears in most company writing ("product", "customers",
 * "today") would make every essay an announcement, which is exactly the failure this rule
 * exists to avoid.
 */
const NEWS_TERMS: readonly string[] = [
  "announc\\w*",
  "introducing",
  "unveil\\w*",
  "launch(?:es|ed|ing)?",
  // The Launch HN post itself, which is a company announcing itself. See docs/adr/0023.
  "launch hn",
  "rais(?:e|es|ed|ing)",
  "funding",
  "seed round",
  "series [a-e]",
  "acquir(?:e|es|ed|ing)",
  "acquisition",
  "merg(?:es|ed|er)",
  "partner(?:s|ed|ing)?",
  "partnership",
  "welcom(?:e|es|ing)",
  "appoint(?:s|ed|ing)?",
  "join(?:s|ing)? (?:us|the team)",
  "generally available",
  "general availability",
  "now available",
  "now live",
  "out now",
  "is here",
  "releas(?:e|es|ed|ing)",
  "ships?",
  "shipped",
  // The act, not the state: "open-sourcing Agent OS" is an announcement, "open source" on its
  // own is a word every engineering blog uses. An office or a waitlist opening is caught by the
  // "announcing" and "introducing" most such headlines carry, and not guessed at here.
  "open[- ]?sourcing",
  "now open",
  "milestone",
  // A compliance certification a company has just earned, which is the one kind of thing it
  // writes about itself that is unambiguously an event.
  "soc ?2",
  "hipaa",
  "iso ?27001",
];

/**
 * Opinion, essay and tutorial vocabulary. Any of these and the post is not news, whatever else
 * the headline says: "Why we're announcing a new pricing model" is a position paper that
 * happens to contain an announcement word, and the matcher cannot tell the difference, so the
 * rule declares which signal wins rather than leaving it to the order terms were listed in.
 */
const NOT_NEWS_TERMS: readonly string[] = [
  "how we",
  "why we",
  "what we learned",
  "lessons (?:from|learned|of)",
  "the case (?:for|against)",
  "in defen[cs]e of",
  "thoughts on",
  "my take",
  "our take",
  "a (?:short )?(?:guide|primer|introduction) to",
  "guide to",
  "primer on",
  "deep dive",
  "deep-dive",
  "tutorial",
  "how-?to",
  "walkthrough",
  "best practices",
  "anti-?patterns?",
  "rethinking",
  "the future of",
  "notes on",
  "reflections on",
];

/**
 * Words a headline may not begin with and still be news. An interrogative or a bare gerund
 * opens a question or a how-to — "Is RAG dead?", "Building a fast tokenizer in Rust" — and
 * neither reports that anything happened. Checked only at the start of the headline, because
 * "Acme is now generally available" opens with a name and is news.
 */
const NOT_NEWS_OPENERS: readonly string[] = [
  "why",
  "how",
  "what",
  "when",
  "where",
  "who",
  "which",
  "is",
  "are",
  "was",
  "do",
  "does",
  "should",
  "can",
  "could",
  "building",
  "designing",
  "writing",
  "debugging",
  "scaling",
  "understanding",
  "choosing",
  "benchmarking",
  "inside",
  "on",
];

/**
 * Path segments that say a post is news, where the company has a part of its site for it:
 * `/press/`, `/newsroom/`, `/changelog/`. `blog` is deliberately not here — a company's blog is
 * where its announcements live as well as its essays, so the path says nothing either way and
 * the headline decides.
 */
const NEWS_PATH_SEGMENTS: readonly string[] = [
  "news",
  "newsroom",
  "press",
  "press-release",
  "press-releases",
  "announcement",
  "announcements",
  "changelog",
  "release-notes",
];

/** Path segments that say a post is not news, for the same reason the terms above do. */
const NOT_NEWS_PATH_SEGMENTS: readonly string[] = [
  "essay",
  "essays",
  "opinion",
  "guide",
  "guides",
  "tutorial",
  "tutorials",
  "how-to",
  "howto",
  "docs",
  "documentation",
  "learn",
];

/** Letters and digits in any script, as `match.ts` draws the same boundary. */
const WORD_CHAR = "[\\p{L}\\p{N}]";

/** A whole-word, case-insensitive pattern for one term. */
const wholeWord = (source: string): RegExp =>
  new RegExp(`(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})`, "iu");

const termPatterns = (terms: readonly string[]): readonly RegExp[] =>
  terms.map(wholeWord);

const NEWS_PATTERNS = termPatterns(NEWS_TERMS);
const NOT_NEWS_PATTERNS = termPatterns(NOT_NEWS_TERMS);
/**
 * A hyphen counts as part of the opening word here, although `WORD_CHAR` does not include one:
 * "On-prem is here" opens with a product name, not with the preposition that makes "On
 * abstraction" an essay.
 */
const NOT_NEWS_OPENER_PATTERNS = NOT_NEWS_OPENERS.map(
  (opener) => new RegExp(`^(?:${opener})(?!${WORD_CHAR}|-)`, "iu"),
);

const matchesAny = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

/**
 * The lower-cased path segments of a url, or none when it does not parse. Pure and total: this
 * is called with urls a Zod schema has already accepted, and does not rely on that.
 */
function pathSegments(url: string): Set<string> {
  try {
    return new Set(
      new URL(url).pathname
        .toLowerCase()
        .split("/")
        .filter((segment) => segment !== ""),
    );
  } catch {
    return new Set();
  }
}

const hasSegment = (
  segments: ReadonlySet<string>,
  named: readonly string[],
): boolean => named.some((segment) => segments.has(segment));

/**
 * Whether an own-site post reports that something happened at the company.
 *
 * The rule, in order:
 *
 * 1. An opinion, essay or tutorial signal — a term, an opening word, or a path segment — and the
 *    answer is no, whatever else the headline says. A headline that is a question is one of
 *    those signals in its own right.
 * 2. Otherwise an announcement signal, in the headline or in the path, and the answer is yes.
 * 3. Otherwise no. A post that says nothing about being an announcement is not treated as one:
 *    the News page is for things that happened, and the quiet default keeps essays off it.
 */
export function isCompanyNews(post: OwnSitePost): boolean {
  const title = post.title.replace(/\s+/g, " ").trim();
  const segments = pathSegments(post.url);

  if (
    title.endsWith("?") ||
    matchesAny(NOT_NEWS_PATTERNS, title) ||
    matchesAny(NOT_NEWS_OPENER_PATTERNS, title) ||
    hasSegment(segments, NOT_NEWS_PATH_SEGMENTS)
  ) {
    return false;
  }

  return (
    matchesAny(NEWS_PATTERNS, title) || hasSegment(segments, NEWS_PATH_SEGMENTS)
  );
}

/**
 * The highest confidence an own-site post that is not news may carry: just under the threshold,
 * written in terms of it so retuning the threshold moves both. Rounded for the reason
 * `scoreNewsMatch` rounds: 0.6 − 0.01 is 0.59 only once rounded.
 */
export const BELOW_NEWS_DISPLAY_THRESHOLD =
  Math.round((NEWS_DISPLAY_THRESHOLD - 0.01) * 100) / 100;

/**
 * What a hit from the history search's `site` query is worth against the Company Profile it was
 * searched for, given that the host is already known to be that company's own.
 *
 * News is shown: `scoreNewsMatch`'s score, or the display threshold, whichever is higher. A post
 * that also names the company scores higher than the threshold and keeps that score; one that
 * does not — which is most of them — is lifted to exactly the threshold rather than to 1,
 * because knowing who wrote it is not knowing how much it matters.
 *
 * Anything else is capped just below the threshold: stored with what the matcher made of it, so
 * a retune can reach it, and never shown. A post the matcher scored 0 stays 0 and so is counted
 * rather than stored, per docs/adr/0022 — the article itself is kept in `news_articles` either
 * way, which is the half of docs/adr/0024 that matters.
 */
export function ownSiteConfidence(
  subject: MatchSubject,
  article: MatchArticle & OwnSitePost,
): number {
  const scored = scoreNewsMatch(subject, article);

  return isCompanyNews(article)
    ? Math.max(scored, NEWS_DISPLAY_THRESHOLD)
    : Math.min(scored, BELOW_NEWS_DISPLAY_THRESHOLD);
}
