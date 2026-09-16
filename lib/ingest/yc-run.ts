import type { Database } from "../../db/connection";
import { persistProfiles, type IngestReport } from "../../db/ingest";
import { wroteNothing } from "./form-d-run";
import { toProfileProvenance, type ScrapedProfile } from "./scraped-profile";
import { parseCompanyPage } from "./yc-company-page";
import { YC_SITEMAP_URL, type YcClient } from "./yc-fetch";
import {
  parseYcSitemap,
  selectCompanyPages,
  type CompanyPageSelection,
  type YcCompanyEntry,
  type YcSitemap,
} from "./yc-sitemap";

/**
 * Everything `scripts/ingest-ycombinator.ts` does that is worth testing: discover, select, fetch,
 * parse, write. The script itself is argv in, stdout out, and an exit code — the same split
 * `form-d-run.ts` makes for the SEC Form D Source.
 */

export const YC_SOURCE = "ycombinator";

/** One company page that did not become a Profile, and the URL it came from. */
export type YcPageFailure =
  | { readonly kind: "fetch"; readonly url: string; readonly reason: string }
  | {
      readonly kind: "parse";
      readonly url: string;
      /** The field `parseCompanyPage` stopped on. */
      readonly field: string;
      readonly reason: string;
    };

export type YcPageBatch = {
  readonly profiles: readonly ScrapedProfile[];
  readonly failures: readonly YcPageFailure[];
};

/**
 * Fetches and parses each page in turn. A page that will not fetch, or that `parseCompanyPage`
 * rejects, is counted with its URL and carried on past: one dead company page in hundreds
 * should cost one Profile, not the run.
 */
export async function fetchCompanyProfiles(
  client: YcClient,
  pages: readonly YcCompanyEntry[],
  capturedAt: string,
): Promise<YcPageBatch> {
  const profiles: ScrapedProfile[] = [];
  const failures: YcPageFailure[] = [];

  for (const page of pages) {
    let html: string;

    try {
      html = await client.get(page.url);
    } catch (error) {
      failures.push({
        kind: "fetch",
        url: page.url,
        reason: error instanceof Error ? error.message : "unknown",
      });
      continue;
    }

    const result = parseCompanyPage(html, { sourceUrl: page.url, capturedAt });

    if (result.success) {
      profiles.push(result.profile);
    } else {
      failures.push({
        kind: "parse",
        url: page.url,
        field: result.rejection.field,
        reason: result.rejection.reason,
      });
    }
  }

  return { profiles, failures };
}

/** Writes a batch through the one write path every Source shares, under this Source's slug. */
export function persistYcProfiles(
  db: Database,
  profiles: readonly ScrapedProfile[],
): Promise<IngestReport> {
  return persistProfiles(db, {
    source: YC_SOURCE,
    candidates: profiles.map((profile) => ({
      input: profile.input,
      provenance: toProfileProvenance(profile.attribution),
    })),
  });
}

export type YcRun = {
  readonly sitemap: YcSitemap;
  readonly selection: CompanyPageSelection;
  readonly batch: YcPageBatch;
  readonly report: IngestReport;
};

/**
 * One whole run for the day `today`. A sitemap that cannot be fetched or read throws, so the run
 * fails before any company page is requested.
 */
export async function runYcIngest(
  client: YcClient,
  db: Database,
  today: string,
): Promise<YcRun> {
  const sitemap = parseYcSitemap(await client.get(YC_SITEMAP_URL));
  const selection = selectCompanyPages(sitemap.companies, today);
  const batch = await fetchCompanyProfiles(client, selection.pages, today);
  const report = await persistYcProfiles(db, batch.profiles);

  return { sitemap, selection, batch, report };
}

/**
 * Why the run should fail, or undefined when it should not. Every page failing is its own
 * message, because it is the likeliest way this Source breaks — YC changing its page payload, or
 * refusing this client — and "wrote nothing" alone would hide which. A run that fetched pages
 * fine but wrote nothing fails too, by the rule every company Source shares: see `wroteNothing`.
 */
export function ycRunFailure({
  selection,
  batch,
  report,
}: YcRun): string | undefined {
  if (selection.pages.length > 0 && batch.profiles.length === 0) {
    return (
      `Every one of the ${selection.pages.length} YC company pages this run picked failed. ` +
      "Either YC is refusing this client or its pages changed shape — the failures above name " +
      "the field each one stopped on."
    );
  }

  if (wroteNothing(report)) {
    return (
      "This run wrote no Profiles at all. Check the rejections above: a page that parses but " +
      "cannot be written is a Profile shape the parser no longer agrees with."
    );
  }

  return undefined;
}

/** What the run did, in the order an operator wants to read it. */
export function summariseYcRun({
  sitemap,
  selection,
  batch,
  report,
}: YcRun): string {
  const lines = [
    `Read ${sitemap.companies.length + sitemap.excluded} sitemap entries: ${sitemap.companies.length} company pages, ${sitemap.excluded} not.`,
  ];

  if (sitemap.unusableLastmod.length > 0) {
    lines.push(
      `  ${sitemap.unusableLastmod.length} company pages had no usable lastmod, first ${sitemap.unusableLastmod[0]}.`,
    );
  }

  lines.push(
    `Picked ${selection.pages.length} pages: ${selection.recent} changed since ${selection.recentSince}, ` +
      `${selection.pages.length - selection.recent} from the rotation starting at #${selection.rotationStart} in slug order.`,
  );

  if (selection.recentOverflow > 0) {
    lines.push(
      `  ${selection.recentOverflow} more pages changed since ${selection.recentSince} than the recent lane holds; the rotation reaches them.`,
    );
  }

  lines.push(
    `Parsed ${batch.profiles.length}, failed ${batch.failures.length}.`,
  );

  // Named, not counted: a rising number against one field is how a page that has quietly
  // changed shape announces itself, and the URL is where to go and look.
  for (const failure of batch.failures) {
    lines.push(
      failure.kind === "fetch"
        ? `  ${failure.url} could not be fetched: ${failure.reason}`
        : `  ${failure.url} rejected on ${failure.field}: ${failure.reason}`,
    );
  }

  lines.push(
    `Wrote ${report.inserted} new Profiles and updated ${report.updated}.`,
  );

  for (const rejection of report.rejections) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}
