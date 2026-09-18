/**
 * A `robots.txt`, read the way RFC 9309 says a crawler must read one. Pure: the caller fetches
 * the file, and `lib/ingest/team-page-fetch.ts` is the one that does.
 *
 * Every other Source in this repo reads a site chosen by hand, whose `robots.txt` was checked
 * by a person and noted beside it. The team-page enrichment reads whatever site a Company
 * Profile names, so there is no person in that loop and this is the check instead: fetched per
 * host, before anything else on that host, and obeyed. See docs/adr/0016.
 *
 * What it supports is what RFC 9309 requires: `user-agent` groups (consecutive lines form one
 * group, and every group naming the same agent is merged), `allow` and `disallow`, `*` as a
 * wildcard and `$` as an end anchor, the longest matching rule winning and `allow` winning a
 * tie. Anything else, `crawl-delay` and `sitemap` included, is ignored.
 */

type Rule = { readonly allow: boolean; readonly pattern: string };

export type RobotsPolicy = {
  /** Whether `path` (path plus query, beginning `/`) may be fetched. */
  readonly allows: (path: string) => boolean;
};

/** Everything allowed: what RFC 9309 says an unavailable (4xx) `robots.txt` means. */
export const ALLOW_ALL: RobotsPolicy = { allows: () => true };

/** Nothing allowed. */
export const DISALLOW_ALL: RobotsPolicy = { allows: () => false };

/**
 * RFC 9309 lets a crawler stop reading after 500 KiB. Measured in characters here, which is at
 * least as generous as bytes.
 */
const MAX_ROBOTS_LENGTH = 500 * 1024;

/**
 * `productToken` is the name this client goes by, matched case-insensitively against each
 * group's `user-agent` lines. A group for this client replaces the `*` group entirely rather
 * than adding to it, as the RFC says.
 */
export function parseRobots(text: string, productToken: string): RobotsPolicy {
  const token = productToken.toLowerCase();
  const named: Rule[] = [];
  const wildcard: Rule[] = [];
  let sawNamedGroup = false;

  let agents: string[] = [];
  let inRules = false;

  for (const rawLine of text.slice(0, MAX_ROBOTS_LENGTH).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");

    if (colon === -1) {
      continue;
    }

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      // A user-agent line after rules starts a new group.
      if (inRules) {
        agents = [];
        inRules = false;
      }
      const agent = value.toLowerCase();
      agents.push(agent);
      // A group naming this client counts even with no rules in it, so an empty `disallow:`
      // under our own name still overrides a `*` group that refuses everyone.
      if (agent === token) {
        sawNamedGroup = true;
      }
      continue;
    }

    if (key !== "allow" && key !== "disallow") {
      continue;
    }

    inRules = true;

    // An empty `disallow` disallows nothing, and an empty `allow` allows nothing extra.
    if (value === "") {
      continue;
    }

    const rule: Rule = { allow: key === "allow", pattern: value };

    if (agents.includes(token)) {
      named.push(rule);
    }
    if (agents.includes("*")) {
      wildcard.push(rule);
    }
  }

  const rules = sawNamedGroup ? named : wildcard;

  return {
    allows: (path) => {
      let best: Rule | undefined;

      for (const rule of rules) {
        if (!matches(rule.pattern, path)) {
          continue;
        }

        if (
          best === undefined ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }

      return best?.allow ?? true;
    },
  };
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** A rule is a path prefix, where `*` matches any run of characters and a final `$` anchors. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map(escapeRegExp).join(".*");

  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}
