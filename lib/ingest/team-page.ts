import { decodeEntities } from "./entities";

/**
 * Reading a company's own site for the people behind it: which of its pages to read, and what
 * text a page states. Pure, like every parser under `lib/ingest`: the fetching is
 * `team-page-fetch.ts`, and the reading of the text is a model's, checked by `team-answer.ts`.
 * See docs/adr/0016.
 *
 * Unlike every other parser here this cannot know the page's shape, because no two companies'
 * team pages share one. So it does not try. It reduces a page to the text a visitor reads, and
 * that one string is both what the model is shown and what every name it returns is checked
 * against, so the check cannot pass on anything the model was not given.
 */

/** The elements whose content no visitor reads as text. */
const INVISIBLE_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
];

/** Elements that end a line of text, so a name in one cell does not run into the next. */
const BLOCK_BOUNDARY =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|section|article|header|footer|nav|tr|td|th|table|dt|dd|blockquote|figure|figcaption|main|aside)\b[^>]*>/gi;

/**
 * The visible text of an HTML document, with whitespace collapsed so a name broken across
 * source lines, or spaced by `&nbsp;`, reads as it does on screen.
 */
export function visibleText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, " ");

  for (const element of INVISIBLE_ELEMENTS) {
    text = text.replace(
      new RegExp(`<${element}\\b[\\s\\S]*?<\\/${element}\\s*>`, "gi"),
      " ",
    );
  }

  text = text.replace(BLOCK_BOUNDARY, "\n").replace(/<[^>]*>/g, " ");

  return normaliseWhitespace(decodeEntities(text));
}

/**
 * Collapses every run of whitespace, including a non-breaking space and the zero-width
 * characters site builders scatter through text, to one space; line breaks survive as one
 * newline so the model still sees the page's structure.
 */
export function normaliseWhitespace(text: string): string {
  return text
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
}

/**
 * Words in a link's path or text that mark a page as likely to name the team. Deliberately
 * narrow: every page read is a request to someone else's server and a longer model prompt.
 */
const TEAM_PAGE_WORDS =
  /\b(?:about|team|people|founders?|leadership|who-we-are|our-story)\b/i;

/** The subset that names the team outright, rather than the company in general. */
const NAMES_THE_TEAM = /\b(?:team|people|founders?|leadership)\b/i;

/**
 * How many pages beyond the homepage one company may cost. A team is almost always on one page,
 * linked from the homepage, and often the homepage itself states it; two covers a site that
 * splits "About" from "Team" without letting one company's navigation become a crawl.
 */
export const MAX_TEAM_PAGES_PER_COMPANY = 2;

/**
 * The pages on the company's own site that its homepage links to and that look like they name
 * the team, best first, at most `MAX_TEAM_PAGES_PER_COMPANY`.
 *
 * Only links on the homepage's own site survive: a link to a social network, a directory or
 * anywhere else is never followed, per the Ticket. `sameSite` is the rule `team-page-fetch.ts`
 * holds redirects to as well, so the two cannot disagree about what "own site" means.
 */
export function teamPageLinks(html: string, homepageUrl: string): string[] {
  const homepage = new URL(homepageUrl);
  const found = new Map<string, number>();

  for (const match of html.matchAll(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
  )) {
    const href = decodeEntities(match[1] ?? match[2] ?? "").trim();
    const label = visibleText(match[3] ?? "");

    let url: URL;
    try {
      url = new URL(href, homepage);
    } catch {
      continue;
    }

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !sameSite(url, homepage)
    ) {
      continue;
    }

    url.hash = "";
    url.search = "";
    const key = url.toString();

    if (url.pathname === "/") {
      continue;
    }

    // "Team" beats "About", which beats nothing.
    const says = `${url.pathname.replace(/[/_]/g, " ")} ${label}`;
    const score = NAMES_THE_TEAM.test(says)
      ? 2
      : TEAM_PAGE_WORDS.test(says)
        ? 1
        : 0;

    if (score > (found.get(key) ?? 0)) {
      found.set(key, score);
    }
  }

  return [...found.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_TEAM_PAGES_PER_COMPANY)
    .map(([url]) => url);
}

/**
 * Whether two URLs are on the same site: the same host, allowing for a leading `www.` on
 * either. Stricter than a registrable domain on purpose: `blog.example.com` is often a hosted
 * platform, and a subdomain's page is not the company's own statement of its team any more
 * reliably than a directory's is.
 */
export function sameSite(a: URL, b: URL): boolean {
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
  return bare(a.hostname) === bare(b.hostname);
}
