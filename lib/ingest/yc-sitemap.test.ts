// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { readYcSitemapFixture, type SitemapFixture } from "../testing/fixtures";
import {
  MAX_PAGES_PER_RUN,
  parseYcSitemap,
  RECENT_PAGES_PER_RUN,
  ROTATION_PAGES_PER_RUN,
  selectCompanyPages,
  type YcCompanyEntry,
  type YcSitemap,
} from "./yc-sitemap";

/**
 * `db/fixtures/yc-sitemap.xml` is YC's whole company sitemap, captured with `curl` from the URL its
 * `.meta.json` sibling records and committed byte-for-byte. On that day it held 6336 entries:
 * 6226 company pages, each with a `YYYY-MM-DD` `lastmod`, and 110 `/companies/industry/<slug>`
 * listings with no `lastmod` at all. A company entry with an absent or malformed `lastmod` is
 * exercised by editing named entries of that capture in the test, not by committing an edited copy.
 */
let fixture: SitemapFixture;
let sitemap: YcSitemap;

beforeAll(async () => {
  fixture = await readYcSitemapFixture();
  sitemap = parseYcSitemap(fixture.xml);
});

const urlset = (entries: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;

const url = (loc: string, lastmod?: string): string =>
  `<url><loc>${loc}</loc>${lastmod === undefined ? "" : `<lastmod>${lastmod}</lastmod>`}</url>`;

describe("the captured sitemap fixture", () => {
  it("records where and when it was captured", () => {
    expect(fixture.capture).toEqual({
      sourceUrl: "https://www.ycombinator.com/companies/sitemap.xml",
      capturedAt: "2026-09-16",
    });
  });

  it("holds company entries, industry entries, and entries with no lastmod", () => {
    expect(fixture.xml).toContain(
      "<url><loc>https://www.ycombinator.com/companies/stripe</loc><lastmod>",
    );

    // Every entry the capture serves without a lastmod, and it is all 110 industry listings.
    // No company entry in it lacks one, or has one that is not a bare date: YC's live sitemap
    // still said so when this was re-checked on 2026-09-16.
    const undated = fixture.xml.match(/<url><loc>[^<]*<\/loc><\/url>/g) ?? [];
    expect(undated).toHaveLength(110);
    expect(undated).toContain(
      "<url><loc>https://www.ycombinator.com/companies/industry/fintech</loc></url>",
    );
    expect(
      undated.filter((entry) => !entry.includes("/companies/industry/")),
    ).toEqual([]);
  });
});

/**
 * The capture as served, with the named company entries' `<lastmod>` replaced. Every other byte
 * is the committed fixture's. No real capture of this sitemap has a company entry whose lastmod
 * is absent or malformed, and committing an edited copy as a fixture would be a fixture that
 * tests the editing rather than the source, so the edit is made here, where it is visible.
 */
function captureWithLastmod(
  xml: string,
  replacements: Readonly<Record<string, string | undefined>>,
): string {
  let edited = xml;

  for (const [slug, lastmod] of Object.entries(replacements)) {
    const entry = new RegExp(
      `<url><loc>https://www\\.ycombinator\\.com/companies/${slug}</loc><lastmod>[^<]*</lastmod></url>`,
    );
    const before = edited;
    edited = edited.replace(
      entry,
      url(`https://www.ycombinator.com/companies/${slug}`, lastmod),
    );

    // A slug the capture does not date would make this a no-op and the test vacuous.
    expect(edited, slug).not.toBe(before);
  }

  return edited;
}

describe("parseYcSitemap, against the captured sitemap", () => {
  it("returns every company page and excludes every industry listing", () => {
    expect(sitemap.companies).toHaveLength(6226);
    expect(sitemap.excluded).toBe(110);
    expect(
      sitemap.companies.filter((company) => company.url.includes("/industry")),
    ).toEqual([]);
  });

  it("carries each company page's lastmod", () => {
    const stripe = sitemap.companies.find(
      (company) => company.slug === "stripe",
    );

    expect(stripe?.url).toBe("https://www.ycombinator.com/companies/stripe");
    expect(stripe?.lastmod).toBe("2026-03-25");
    expect(sitemap.unusableLastmod).toEqual([]);
  });

  it("does not let an industry entry's absent lastmod reach unusableLastmod", () => {
    expect(
      sitemap.unusableLastmod.filter((entry) => entry.includes("/industry")),
    ).toEqual([]);
    expect(sitemap.companies.every((company) => company.lastmod !== null)).toBe(
      true,
    );
  });

  it("keeps a company entry whose lastmod is absent or malformed, with lastmod null, and names it", () => {
    const edited = parseYcSitemap(
      captureWithLastmod(fixture.xml, {
        stripe: undefined,
        dropbox: "last tuesday",
        razorpay: "2026-02-31",
      }),
    );

    expect(edited.companies).toHaveLength(6226);
    expect(edited.excluded).toBe(110);
    expect(edited.unusableLastmod).toEqual(
      expect.arrayContaining([
        "https://www.ycombinator.com/companies/stripe",
        "https://www.ycombinator.com/companies/dropbox",
        "https://www.ycombinator.com/companies/razorpay",
      ]),
    );
    expect(edited.unusableLastmod).toHaveLength(3);

    for (const slug of ["stripe", "dropbox", "razorpay"]) {
      expect(
        edited.companies.find((company) => company.slug === slug)?.lastmod,
      ).toBeNull();
    }

    // Undated, those pages still reach a run: never the recent lane, but in the rotation.
    const undated = new Set(["stripe", "dropbox", "razorpay"]);
    const days = Math.ceil(6226 / ROTATION_PAGES_PER_RUN);
    const reached = new Set<string>();

    for (let day = 0; day < days; day += 1) {
      const date = new Date(Date.UTC(2026, 8, 16 + day))
        .toISOString()
        .slice(0, 10);
      const selection = selectCompanyPages(edited.companies, date);

      for (const page of selection.pages.slice(0, selection.recent)) {
        expect(undated.has(page.slug)).toBe(false);
      }
      for (const page of selection.pages) {
        if (undated.has(page.slug)) {
          reached.add(page.slug);
        }
      }
    }

    expect([...reached].sort()).toEqual(["dropbox", "razorpay", "stripe"]);
  });

  it("returns only /companies/ followed by exactly one non-empty segment", () => {
    for (const company of sitemap.companies) {
      expect(company.url).toMatch(
        /^https:\/\/www\.ycombinator\.com\/companies\/[^/?#]+$/,
      );
    }
  });
});

describe("parseYcSitemap, on entries the capture does not contain", () => {
  it("keeps a company page whose lastmod is absent or malformed, with lastmod null, and names it", () => {
    const result = parseYcSitemap(
      urlset(
        url("https://www.ycombinator.com/companies/absent") +
          url(
            "https://www.ycombinator.com/companies/malformed",
            "last tuesday",
          ) +
          url(
            "https://www.ycombinator.com/companies/impossible",
            "2026-02-31",
          ) +
          url("https://www.ycombinator.com/industry/absent"),
      ),
    );

    expect(result.companies).toEqual([
      {
        url: "https://www.ycombinator.com/companies/absent",
        slug: "absent",
        lastmod: null,
      },
      {
        url: "https://www.ycombinator.com/companies/malformed",
        slug: "malformed",
        lastmod: null,
      },
      {
        url: "https://www.ycombinator.com/companies/impossible",
        slug: "impossible",
        lastmod: null,
      },
    ]);
    expect(result.unusableLastmod).toEqual([
      "https://www.ycombinator.com/companies/absent",
      "https://www.ycombinator.com/companies/malformed",
      "https://www.ycombinator.com/companies/impossible",
    ]);
  });

  it("reduces a W3C datetime lastmod to its UTC day", () => {
    const result = parseYcSitemap(
      urlset(
        url(
          "https://www.ycombinator.com/companies/late",
          "2026-09-15T23:30:00-07:00",
        ),
      ),
    );

    expect(result.companies[0]?.lastmod).toBe("2026-09-16");
  });

  it.each([
    [
      "an industry listing",
      "https://www.ycombinator.com/companies/industry/fintech",
    ],
    ["the directory itself", "https://www.ycombinator.com/companies"],
    ["an empty segment", "https://www.ycombinator.com/companies/"],
    ["a trailing slash", "https://www.ycombinator.com/companies/stripe/"],
    [
      "a query string robots.txt disallows",
      "https://www.ycombinator.com/companies/stripe?page=2",
    ],
    ["a fragment", "https://www.ycombinator.com/companies/stripe#jobs"],
    ["another host", "https://example.com/companies/stripe"],
    ["plain http", "http://www.ycombinator.com/companies/stripe"],
    [
      "a page outside /companies",
      "https://www.ycombinator.com/launches/stripe",
    ],
  ])("excludes %s", (_, loc) => {
    const result = parseYcSitemap(
      urlset(url(loc) + url("https://www.ycombinator.com/companies/kept")),
    );

    expect(result.companies.map((company) => company.slug)).toEqual(["kept"]);
    expect(result.excluded).toBe(1);
  });

  it("lists a slug that appears twice once", () => {
    const result = parseYcSitemap(
      urlset(
        url("https://www.ycombinator.com/companies/twice", "2026-09-01") +
          url("https://www.ycombinator.com/companies/twice", "2026-09-02"),
      ),
    );

    expect(result.companies).toHaveLength(1);
    expect(result.excluded).toBe(1);
  });
});

describe("parseYcSitemap, against a sitemap that has changed shape", () => {
  it("rejects a document that is not XML", () => {
    expect(() => parseYcSitemap("<urlset><url><loc>")).toThrow(
      "YC sitemap is not XML",
    );
    expect(() => parseYcSitemap("")).toThrow("YC sitemap is not XML");
  });

  it("rejects a document with no urlset, naming urlset", () => {
    expect(() =>
      parseYcSitemap(
        "<sitemapindex><sitemap><loc>https://www.ycombinator.com/companies/sitemap</loc></sitemap></sitemapindex>",
      ),
    ).toThrow("YC sitemap changed shape at urlset");
  });

  it("rejects a urlset with no entries, naming urlset", () => {
    expect(() => parseYcSitemap(urlset(""))).toThrow(
      "YC sitemap changed shape at urlset",
    );
  });

  it("rejects an entry with no loc, naming the entry's loc", () => {
    expect(() =>
      parseYcSitemap(
        urlset(
          url("https://www.ycombinator.com/companies/fine") +
            "<url><lastmod>2026-09-16</lastmod></url>",
        ),
      ),
    ).toThrow("YC sitemap changed shape at urlset.url.1.loc");
  });

  it("rejects an entry whose loc is not a URL, naming it", () => {
    expect(() => parseYcSitemap(urlset(url("stripe")))).toThrow(
      "YC sitemap changed shape at urlset.url.0.loc",
    );
  });

  it("rejects a sitemap that lists no company page at all, rather than reading as zero companies", () => {
    expect(() =>
      parseYcSitemap(
        urlset(url("https://www.ycombinator.com/companies/industry/fintech")),
      ),
    ).toThrow("not one was a company page");
  });
});

describe("selectCompanyPages", () => {
  const TODAY = "2026-09-16";

  it("bounds a run well under the whole sitemap it would otherwise fetch", () => {
    // The captured sitemap at one request a second is over 100 minutes; a bounded run at the
    // same rate is under ten.
    expect(sitemap.companies.length / 60).toBeGreaterThan(100);
    expect(MAX_PAGES_PER_RUN / 60).toBeLessThan(10);
    expect(RECENT_PAGES_PER_RUN + ROTATION_PAGES_PER_RUN).toBe(
      MAX_PAGES_PER_RUN,
    );
  });

  it("picks at most MAX_PAGES_PER_RUN pages, none twice", () => {
    const { pages } = selectCompanyPages(sitemap.companies, TODAY);

    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBeLessThanOrEqual(MAX_PAGES_PER_RUN);
    expect(new Set(pages.map((page) => page.slug)).size).toBe(pages.length);
  });

  it("is deterministic: the same sitemap on the same day picks the same pages in the same order", () => {
    const shuffled = [...sitemap.companies].reverse();

    expect(selectCompanyPages(shuffled, TODAY)).toEqual(
      selectCompanyPages(sitemap.companies, TODAY),
    );
  });

  it("picks pages changed since yesterday first, newest first, up to its share", () => {
    const selection = selectCompanyPages(sitemap.companies, TODAY);
    const recent = selection.pages.slice(0, selection.recent);

    expect(selection.recentSince).toBe("2026-09-15");
    expect(selection.recent).toBeGreaterThan(0);
    expect(selection.recent).toBeLessThanOrEqual(RECENT_PAGES_PER_RUN);

    for (const page of recent) {
      expect(page.lastmod! >= "2026-09-15").toBe(true);
    }

    const dates = recent.map((page) => page.lastmod!);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("makes progress: successive days' rotation windows are contiguous, and walk the whole sitemap", () => {
    const total = sitemap.companies.length;
    const days = Math.ceil(total / ROTATION_PAGES_PER_RUN);
    const seen = new Set<string>();
    let previousStart: number | undefined;

    for (let day = 0; day < days; day += 1) {
      const date = new Date(Date.UTC(2026, 8, 16 + day))
        .toISOString()
        .slice(0, 10);
      const selection = selectCompanyPages(sitemap.companies, date);

      if (previousStart !== undefined) {
        expect(selection.rotationStart).toBe(
          (previousStart + ROTATION_PAGES_PER_RUN) % total,
        );
      }
      previousStart = selection.rotationStart;

      for (const page of selection.pages) {
        seen.add(page.slug);
      }
    }

    expect(seen.size).toBe(total);
  });

  it("does not re-fetch the same head of the list on the next day", () => {
    const monday = selectCompanyPages(sitemap.companies, "2026-09-14");
    const tuesday = selectCompanyPages(sitemap.companies, "2026-09-15");

    const rotation = (selection: typeof monday) =>
      new Set(selection.pages.slice(selection.recent).map((page) => page.slug));

    const overlap = [...rotation(monday)].filter((slug) =>
      rotation(tuesday).has(slug),
    );
    expect(overlap).toEqual([]);
  });

  it("does not fetch a recently changed page a second time from the rotation", () => {
    const entries: YcCompanyEntry[] = ["a", "b", "c"].map((slug) => ({
      url: `https://www.ycombinator.com/companies/${slug}`,
      slug,
      lastmod: slug === "b" ? TODAY : "2020-01-01",
    }));

    const selection = selectCompanyPages(entries, TODAY);

    expect(selection.recent).toBe(1);
    expect(selection.pages.map((page) => page.slug).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(selection.pages[0]?.slug).toBe("b");
  });

  it("never picks a page with no lastmod for the recent lane", () => {
    const entries: YcCompanyEntry[] = [
      {
        url: "https://www.ycombinator.com/companies/undated",
        slug: "undated",
        lastmod: null,
      },
    ];

    const selection = selectCompanyPages(entries, TODAY);

    expect(selection.recent).toBe(0);
    expect(selection.pages).toEqual(entries);
  });

  it("refuses a date it cannot count from", () => {
    expect(() => selectCompanyPages(sitemap.companies, "today")).toThrow(
      "must be YYYY-MM-DD",
    );
  });
});
