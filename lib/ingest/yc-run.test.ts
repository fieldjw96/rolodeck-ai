// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IngestReport } from "../../db/ingest";
import { profiles } from "../../db/schema";
import { createScratchDb, type ScratchDb } from "../../db/testing/scratch-db";
import { readCompanyFixtures, type CompanyFixture } from "../testing/fixtures";
import type { ScrapedProfile } from "./scraped-profile";
import type { YcClient } from "./yc-fetch";
import {
  fetchCompanyProfiles,
  persistYcProfiles,
  runYcIngest,
  summariseYcRun,
  YC_SOURCE,
  ycRunFailure,
  type YcRun,
} from "./yc-run";
import type { YcCompanyEntry } from "./yc-sitemap";

const JACK = "11111111-1111-1111-1111-111111111111";
const TODAY = "2026-09-16";

/**
 * The five YC company pages already committed for `yc-company-page.test.ts`, served by a client
 * that stands in for the network. Three parse; `yc-dropbox` lists no tags and is rejected on
 * `sector`, and `yc-lawdingo` has no team size and is rejected on `stage` (docs/adr/0007).
 */
const SLUGS = ["stripe", "razorpay", "buxfer", "dropbox", "lawdingo"];

let fixtures: CompanyFixture[];
let scratch: ScratchDb;
const ownerIdBefore = process.env.ROLODECK_OWNER_ID;

const pageUrl = (slug: string) =>
  `https://www.ycombinator.com/companies/${slug}`;

const entries = (slugs: readonly string[]): YcCompanyEntry[] =>
  slugs.map((slug) => ({ url: pageUrl(slug), slug, lastmod: TODAY }));

/** Answers with a fixture's bytes for its page, `sitemap` for the sitemap, and 404 for the rest. */
function fixtureClient(sitemap?: string): YcClient & { requested: string[] } {
  const requested: string[] = [];

  return {
    requested,
    get: async (url) => {
      requested.push(url);

      if (url === "https://www.ycombinator.com/companies/sitemap.xml") {
        if (sitemap === undefined) throw new Error(`${url} answered 503`);
        return sitemap;
      }

      const fixture = fixtures.find(
        (candidate) => pageUrl(candidate.slug.replace(/^yc-/, "")) === url,
      );

      if (fixture === undefined) {
        throw new Error(`${url} answered 404`);
      }

      return fixture.html;
    },
  };
}

const sitemapListing = (slugs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"> <url><loc>https://www.ycombinator.com/companies/industry/fintech</loc></url>${slugs
    .map(
      (slug) =>
        `<url><loc>${pageUrl(slug)}</loc><lastmod>${TODAY}</lastmod></url>`,
    )
    .join("")}</urlset>`;

beforeAll(async () => {
  fixtures = await readCompanyFixtures(SLUGS.map((slug) => `yc-${slug}`));
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
  process.env.ROLODECK_OWNER_ID = ownerIdBefore;
});

beforeEach(async () => {
  process.env.ROLODECK_OWNER_ID = JACK;
  await scratch.reset();
  await scratch.db.delete(profiles);
});

describe("fetchCompanyProfiles", () => {
  it("parses the pages that parse, and counts every other one with its URL, without stopping", async () => {
    const batch = await fetchCompanyProfiles(
      fixtureClient(),
      entries([...SLUGS, "gone"]),
      TODAY,
    );

    expect(batch.profiles.map((profile) => profile.input.name).sort()).toEqual([
      "Buxfer",
      "Razorpay",
      "Stripe",
    ]);
    expect(batch.failures).toEqual([
      {
        kind: "parse",
        url: pageUrl("dropbox"),
        field: "sector",
        reason: expect.any(String),
      },
      {
        kind: "parse",
        url: pageUrl("lawdingo"),
        field: "stage",
        reason: expect.any(String),
      },
      {
        kind: "fetch",
        url: pageUrl("gone"),
        reason: `${pageUrl("gone")} answered 404`,
      },
    ]);
  });

  it("stamps each Profile with the page it came from, and stage as enriched", async () => {
    const batch = await fetchCompanyProfiles(
      fixtureClient(),
      entries(["stripe"]),
      TODAY,
    );
    const stripe = batch.profiles[0]!;

    expect(stripe.attribution.name).toEqual({
      sourceUrl: pageUrl("stripe"),
      capturedAt: TODAY,
      provenance: "scraped",
    });
    expect(stripe.attribution.stage).toEqual({
      sourceUrl: pageUrl("stripe"),
      capturedAt: TODAY,
      provenance: "enriched",
    });
  });
});

describe("persistYcProfiles, against a real database", () => {
  it("inserts the first time and updates the second, under the ycombinator Source", async () => {
    const batch = await fetchCompanyProfiles(
      fixtureClient(),
      entries(SLUGS),
      TODAY,
    );

    const first = await persistYcProfiles(scratch.db, batch.profiles);
    const second = await persistYcProfiles(scratch.db, batch.profiles);

    expect(first).toEqual({
      inserted: 3,
      updated: 0,
      rejected: 0,
      rejections: [],
    });
    expect(second).toEqual({
      inserted: 0,
      updated: 3,
      rejected: 0,
      rejections: [],
    });

    const rows = await scratch.db.select().from(profiles);

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.source))).toEqual(
      new Set([YC_SOURCE]),
    );
    expect(rows.map((row) => row.provenance.stage)).toEqual([
      "enriched",
      "enriched",
      "enriched",
    ]);
  });
});

describe("runYcIngest", () => {
  it("discovers from the sitemap, fetches only company pages, and writes what parsed", async () => {
    const client = fixtureClient(sitemapListing([...SLUGS, "gone"]));

    const run = await runYcIngest(client, scratch.db, TODAY);

    expect(client.requested[0]).toBe(
      "https://www.ycombinator.com/companies/sitemap.xml",
    );
    expect(client.requested.some((url) => url.includes("/industry/"))).toBe(
      false,
    );
    expect(run.selection.pages).toHaveLength(6);
    expect(run.report.inserted).toBe(3);
    expect(run.batch.failures).toHaveLength(3);
    expect(ycRunFailure(run)).toBeUndefined();

    const again = await runYcIngest(
      fixtureClient(sitemapListing([...SLUGS, "gone"])),
      scratch.db,
      TODAY,
    );

    expect(again.report).toMatchObject({ inserted: 0, updated: 3 });
  });

  it("throws, before fetching any company page, when the sitemap cannot be read", async () => {
    const client = fixtureClient("<html><body>Not found</body></html>");

    await expect(runYcIngest(client, scratch.db, TODAY)).rejects.toThrow(
      "YC sitemap changed shape at urlset",
    );
    expect(client.requested).toHaveLength(1);
  });

  it("throws when the sitemap cannot be fetched", async () => {
    await expect(
      runYcIngest(fixtureClient(), scratch.db, TODAY),
    ).rejects.toThrow("sitemap.xml answered 503");
  });
});

const report = (over: Partial<IngestReport> = {}): IngestReport => ({
  inserted: 0,
  updated: 0,
  rejected: 0,
  rejections: [],
  ...over,
});

/**
 * A run of `pages` picked pages, `parsed` of which became Profiles. Only the counts matter to
 * `ycRunFailure`, so the parsed Profiles are placeholders.
 */
function runOf(pages: number, parsed: number, written: IngestReport): YcRun {
  const picked = entries(
    Array.from({ length: pages }, (_, index) => `company-${index}`),
  );

  return {
    sitemap: { companies: picked, excluded: 0, unusableLastmod: [] },
    selection: {
      pages: picked,
      recent: 0,
      recentSince: "2026-09-15",
      rotationStart: 0,
    },
    batch: {
      profiles: Array.from({ length: parsed }, () => ({}) as ScrapedProfile),
      failures: [],
    },
    report: written,
  };
}

describe("ycRunFailure", () => {
  it("fails a run where every page picked failed, saying so", () => {
    expect(ycRunFailure(runOf(2, 0, report()))).toContain(
      "Every one of the 2 YC company pages",
    );
  });

  it("fails a run that parsed pages but wrote nothing", () => {
    expect(ycRunFailure(runOf(2, 2, report({ rejected: 2 })))).toContain(
      "wrote no Profiles",
    );
  });

  it("passes a run where some pages failed and the rest were written", () => {
    expect(ycRunFailure(runOf(2, 1, report({ inserted: 1 })))).toBeUndefined();
  });

  it("passes a second run of the same pages, which only updates", () => {
    expect(ycRunFailure(runOf(2, 2, report({ updated: 2 })))).toBeUndefined();
  });
});

describe("summariseYcRun", () => {
  it("names every failed page by URL, and the field a rejected one stopped on", async () => {
    const batch = await fetchCompanyProfiles(
      fixtureClient(),
      entries(["stripe", "lawdingo", "gone"]),
      TODAY,
    );

    const summary = summariseYcRun({
      sitemap: {
        companies: entries(["stripe", "lawdingo", "gone"]),
        excluded: 110,
        unusableLastmod: [pageUrl("gone")],
      },
      selection: {
        pages: entries(["stripe", "lawdingo", "gone"]),
        recent: 1,
        recentSince: "2026-09-15",
        rotationStart: 42,
      },
      batch,
      report: report({
        inserted: 1,
        rejections: [{ field: "website", reason: "Invalid URL", raw: null }],
      }),
    });

    expect(summary).toContain(
      "Read 113 sitemap entries: 3 company pages, 110 not.",
    );
    expect(summary).toContain("1 company pages had no usable lastmod");
    expect(summary).toContain(
      "Picked 3 pages: 1 changed since 2026-09-15, 2 from the rotation starting at #42",
    );
    expect(summary).toContain("Parsed 1, failed 2.");
    expect(summary).toContain(`${pageUrl("lawdingo")} rejected on stage:`);
    expect(summary).toContain(
      `${pageUrl("gone")} could not be fetched: ${pageUrl("gone")} answered 404`,
    );
    expect(summary).toContain("Wrote 1 new Profiles and updated 0.");
    expect(summary).toContain("rejected on website: Invalid URL");
  });
});
