import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { profileInputSchema } from "../../db/profile-input";
import { readCompanyFixture, type CompanyFixture } from "../testing/fixtures";
import { toProfileProvenance, type ScrapedProfile } from "./scraped-profile";
import {
  parseCompanyPage,
  parseCompanyPages,
  type CompanyPage,
} from "./yc-company-page";

/**
 * Every fixture under `db/fixtures/` was captured with `curl` from the URL its `.meta.json`
 * sibling records, and is committed byte-for-byte. They differ from each other in the ways
 * this parser can actually tell apart:
 *
 * - `yc-stripe`   — every field present, several industry tags, a large team.
 * - `yc-razorpay` — a description several thousand characters long.
 * - `yc-buxfer`   — a blank long description, so the one-liner is what a Profile gets, and a
 *                   team of one, which is the bottom of the stage ladder.
 * - `yc-dropbox`  — a real page that lists no industries at all, so its sector is `other`
 *                   rather than the company rejected, attributed `enriched`.
 * - `yc-lawdingo` — a real page with no team size, so there is no `stage` to derive, and the
 *                   Profile's stage is `not-stated` rather than the company rejected.
 */
const CLEAN = [
  "yc-stripe",
  "yc-razorpay",
  "yc-buxfer",
  "yc-lawdingo",
  "yc-dropbox",
] as const;

const fixtures = new Map<string, CompanyFixture>();

const fixture = (slug: string): CompanyFixture => {
  const found = fixtures.get(slug);
  if (found === undefined) throw new Error(`fixture ${slug} was not loaded`);
  return found;
};

const parsed = (slug: string): ScrapedProfile => {
  const result = parseCompanyPage(fixture(slug).html, fixture(slug).capture);
  if (!result.success) {
    throw new Error(
      `${slug} was rejected on ${result.rejection.field}: ${result.rejection.reason}`,
    );
  }
  return result.profile;
};

beforeAll(async () => {
  for (const slug of CLEAN) {
    fixtures.set(slug, await readCompanyFixture(slug));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A minimal page carrying a payload of our choosing. This is for the shape-change paths — a
 * field that changes type, a payload that stops being JSON — which by definition no captured
 * page shows today. Everything about what the source *currently* looks like is asserted
 * against the fixtures above; nothing here stands in for one.
 */
const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const pageWith = (company: unknown): string =>
  `<div id="app" data-page="${htmlEscape(JSON.stringify({ props: { company } }))}"></div>`;

const CAPTURE = {
  sourceUrl: "https://www.ycombinator.com/companies/example",
  capturedAt: "2026-09-03",
} as const;

describe("parseCompanyPage, against captured pages", () => {
  it("turns a captured page into a validated Profile", () => {
    const { input } = parsed("yc-stripe");

    expect(input.name).toBe("Stripe");
    // Raw tag "Banking as a Service", mapped onto the controlled vocabulary.
    expect(input.sector).toBe("fintech");
    expect(input.stage).toBe("growth");
    expect(input.website).toBe("http://stripe.com");
    expect(input.description).toContain(
      "economic infrastructure for the internet",
    );
  });

  it.each(CLEAN)(
    "returns %s only after profileInputSchema accepts it",
    (slug) => {
      expect(profileInputSchema.safeParse(parsed(slug).input).success).toBe(
        true,
      );
    },
  );

  it.each(CLEAN)("leaves no HTML entities in %s's text", (slug) => {
    const { input } = parsed(slug);

    for (const value of [input.name, input.description, input.sector]) {
      expect(value).not.toMatch(/&(?:amp|quot|lt|gt|#\d+);/);
    }
  });

  it("carries a description several thousand characters long without truncating it", () => {
    const { description } = parsed("yc-razorpay").input;

    expect(description.length).toBeGreaterThan(4000);
    expect(description).toContain("Razorpay");
  });

  it("falls back to the one-liner when a page's long description is blank", () => {
    const { input } = parsed("yc-buxfer");

    expect(input.name).toBe("Buxfer");
    expect(input.description).toContain("spending decisions");
    // The bottom of the stage ladder, from a team of one.
    expect(input.stage).toBe("pre-seed");
  });

  it("keeps a page that lists no industries, its sector `other` rather than rejected", () => {
    const { input, attribution } = parsed("yc-dropbox");

    expect(input.name).toBe("Dropbox");
    expect(input.sector).toBe("other");
    // The page stated nothing; this pipeline chose `other`. See docs/adr/0015, which this
    // applies to `sector` the same way it already applies to `stage`.
    expect(attribution.sector).toEqual({
      ...fixture("yc-dropbox").capture,
      provenance: "enriched",
    });
  });

  it("logs a distinct event for an absent tag than for one it does not recognise", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    parseCompanyPage(fixture("yc-dropbox").html, fixture("yc-dropbox").capture);
    const absentEvent = (
      JSON.parse(logSpy.mock.calls[0]![0] as string) as { event: string }
    ).event;

    logSpy.mockClear();

    parseCompanyPage(
      pageWith({
        name: "Sprocket",
        tags: ["Underwater Basket Weaving"],
        one_liner: "Baskets.",
        team_size: 10,
      }),
      CAPTURE,
    );
    const unrecognisedEvent = (
      JSON.parse(logSpy.mock.calls[0]![0] as string) as { event: string }
    ).event;

    expect(absentEvent).toBe("sector_absent");
    expect(unrecognisedEvent).toBe("sector_mapped_to_other");
    expect(absentEvent).not.toBe(unrecognisedEvent);
  });

  it("keeps a page with no team size, its stage `not-stated` rather than guessed", () => {
    const { input, attribution } = parsed("yc-lawdingo");

    expect(input.name).toBe("Lawdingo");
    expect(input.stage).toBe("not-stated");
    // The page did not state it; this pipeline wrote the marker. See docs/adr/0015.
    expect(attribution.stage).toEqual({
      ...fixture("yc-lawdingo").capture,
      provenance: "enriched",
    });
  });

  it("keeps `not-stated` for a team size of zero, which names no band", () => {
    const result = parseCompanyPage(
      pageWith({
        name: "Sprocket",
        tags: ["Robotics"],
        one_liner: "Arms.",
        team_size: 0,
      }),
      CAPTURE,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.input.stage).toBe("not-stated");
  });
});

describe("provenance", () => {
  it("attributes every populated field to the page and day it was captured", () => {
    const { input, attribution } = parsed("yc-stripe");
    const { capture } = fixture("yc-stripe");

    for (const field of ["name", "description", "sector", "website"] as const) {
      expect(attribution[field]).toEqual({ ...capture, provenance: "scraped" });
    }

    expect(capture.sourceUrl).toBe(
      "https://www.ycombinator.com/companies/stripe",
    );
    expect(input.website).toBeDefined();
  });

  it("marks stage enriched, because the page states headcount and never a funding round", () => {
    expect(parsed("yc-stripe").attribution.stage).toEqual({
      ...fixture("yc-stripe").capture,
      provenance: "enriched",
    });
  });

  it("narrows an absent tag's sector to enriched, and a stated one's to scraped", () => {
    expect(toProfileProvenance(parsed("yc-dropbox").attribution).sector).toBe(
      "enriched",
    );
    expect(toProfileProvenance(parsed("yc-stripe").attribution).sector).toBe(
      "scraped",
    );
  });

  it("records no website provenance when the page lists no website", () => {
    // The real capture with one value emptied: the no-website branch is not something any
    // page we hold currently shows, and the assertion below fails loudly if the fixture ever
    // stops containing the value this replaces, rather than quietly testing nothing.
    const withoutWebsite = fixture("yc-stripe").html.replace(
      "website&quot;:&quot;http://stripe.com&quot;",
      "website&quot;:&quot;&quot;",
    );
    expect(withoutWebsite).not.toBe(fixture("yc-stripe").html);

    const result = parseCompanyPage(
      withoutWebsite,
      fixture("yc-stripe").capture,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.input.website).toBeUndefined();
    expect(result.profile.attribution.website).toBeNull();
  });

  it("narrows attribution to the shape the profiles column takes", () => {
    expect(toProfileProvenance(parsed("yc-stripe").attribution)).toEqual({
      name: "scraped",
      description: "scraped",
      sector: "scraped",
      stage: "enriched",
      website: "scraped",
      location: null,
    });
  });

  it("narrows a missing website to a null provenance", () => {
    const { attribution } = parsed("yc-stripe");

    expect(
      toProfileProvenance({ ...attribution, website: null }).website,
    ).toBeNull();
  });
});

describe("parseCompanyPage, against a source that has changed shape", () => {
  it("returns no record and does not throw on empty HTML", () => {
    const batch = parseCompanyPages([{ html: "", capture: CAPTURE }]);

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("data-page");
  });

  it("rejects HTML carrying no page payload", () => {
    const result = parseCompanyPage(
      "<html><body>Not found</body></html>",
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("data-page");
  });

  it("rejects a payload that is no longer JSON", () => {
    const result = parseCompanyPage(
      `<div data-page="{&quot;props&quot;: truncated"></div>`,
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("data-page");
  });

  it.each([
    { changed: "name", company: { tags: ["Fintech"], team_size: 10 } },
    {
      changed: "tags",
      company: { name: "Sprocket", tags: "Fintech", team_size: 10 },
    },
    {
      changed: "team_size",
      company: { name: "Sprocket", tags: ["Fintech"], team_size: "ten" },
    },
  ])(
    "names props.company.$changed when that field changes shape",
    ({ changed, company }) => {
      const result = parseCompanyPage(pageWith(company), CAPTURE);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.rejection.field).toBe(`props.company.${changed}`);
    },
  );

  it("names props.company when the payload carries no company at all", () => {
    const result = parseCompanyPage(
      `<div data-page="${htmlEscape(JSON.stringify({ props: {} }))}"></div>`,
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("props.company");
  });

  it("ignores keys the payload gains, so a new field is not an outage", () => {
    const result = parseCompanyPage(
      pageWith({
        name: "Sprocket",
        one_liner: "Developer tooling for warehouse robotics.",
        tags: ["Robotics"],
        team_size: 10,
        some_new_field: { yc: "added this" },
      }),
      CAPTURE,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.input.stage).toBe("seed");
  });

  it("decodes entities in one pass, so escaped markup in the source's own prose survives", () => {
    const description = 'Tooling for "R&D" teams <at scale>.';
    const result = parseCompanyPage(
      pageWith({
        name: "Sprocket",
        long_description: description,
        tags: ["Robotics"],
        team_size: 10,
      }),
      CAPTURE,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.input.description).toBe(description);
  });

  it("rejects a website the schema will not accept, naming it", () => {
    const result = parseCompanyPage(
      pageWith({
        name: "Sprocket",
        one_liner: "Developer tooling.",
        tags: ["Robotics"],
        team_size: 10,
        website: "javascript:alert(1)",
      }),
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("website");
  });
});

describe("parseCompanyPages", () => {
  it("reports how many candidates were rejected, and the field that failed each", () => {
    // No captured fixture is rejected any longer: a company with no sector or no stage is now
    // kept. A candidate with neither a long description nor a one-liner still has nothing to
    // show on a card, and rejecting it is still right — that is the one way left to fail here.
    const noDescription: CompanyPage = {
      html: pageWith({ name: "Sprocket", tags: ["Robotics"], team_size: 10 }),
      capture: CAPTURE,
    };

    const batch = parseCompanyPages([
      ...CLEAN.map((slug) => fixture(slug)),
      noDescription,
    ]);

    expect(batch.profiles).toHaveLength(CLEAN.length);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "description",
    ]);
  });

  it("returns an empty batch for no pages", () => {
    expect(parseCompanyPages([])).toEqual({ profiles: [], rejections: [] });
  });
});
