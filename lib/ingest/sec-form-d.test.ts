// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { profileInputSchema } from "../../db/profile-input";
import { readFilingFixture, type FilingFixture } from "../testing/fixtures";
import {
  ASSET_HOLDING_INDUSTRY_GROUPS,
  parseFormDFiling,
  parseFormDFilings,
  SEC_FORM_D_SOURCE,
  type FormDFiling,
} from "./sec-form-d";
import { toProfileProvenance } from "./scraped-profile";

/**
 * Every fixture under `db/fixtures/` is a real filing, fetched from the URL its `.meta.json`
 * sibling records and committed byte-for-byte. They differ in the ways this parser can
 * actually tell apart:
 *
 * - `elder-swamp-club`   — San Francisco, and the filing names a Series Seed.
 * - `sporty-and-rich`    — a Series A, and an `&amp;` in the issuer's own name.
 * - `point2-technology`  — "Senior Series B Preferred Stock", so a round with a word in front.
 * - `krina-ai`           — a real Californian filing naming no round at all. It stays in the
 *                          suite because it is the docs/adr/0007 fallback path when a headcount
 *                          is known and, with none, a Profile whose stage is `not-stated` —
 *                          where before docs/adr/0015 it was a rejection.
 * - `maitrics`           — an operating company whose only security is a SAFE, the commonest
 *                          early-stage answer, which docs/adr/0009 declines to read as a round.
 * - `horsley-bridge-growth-15`, `rtp-cabana-2026`, `hz-seasons-at-horsetooth-crossing` — a
 *                          pooled investment fund, an investing vehicle and a residential
 *                          property, each Californian, each rejected as not a company at all.
 * - `communion`          — a real filing from a New York issuer, so the California filter has
 *                          something to actually exclude.
 */
const CALIFORNIAN_WITH_A_ROUND = [
  ["sec-form-d-elder-swamp-club", "Elder Swamp Club, Inc.", "seed"],
  ["sec-form-d-sporty-and-rich", "SPORTY & RICH INC", "series-a"],
  ["sec-form-d-point2-technology", "Point2 Technology Inc.", "series-b-plus"],
] as const;

const NO_ROUND = "sec-form-d-krina-ai";
const SAFE_ONLY = "sec-form-d-maitrics";
const HOLDS_ASSETS = [
  ["sec-form-d-horsley-bridge-growth-15", "Pooled Investment Fund"],
  ["sec-form-d-rtp-cabana-2026", "Investing"],
  ["sec-form-d-hz-seasons-at-horsetooth-crossing", "Residential"],
] as const;
const OUT_OF_STATE = "sec-form-d-communion";

const SLUGS = [
  ...CALIFORNIAN_WITH_A_ROUND.map(([slug]) => slug),
  NO_ROUND,
  SAFE_ONLY,
  ...HOLDS_ASSETS.map(([slug]) => slug),
  OUT_OF_STATE,
];

const fixtures = new Map<string, FilingFixture>();

const fixture = (slug: string): FilingFixture => {
  const found = fixtures.get(slug);
  if (found === undefined) throw new Error(`fixture ${slug} was not loaded`);
  return found;
};

beforeAll(async () => {
  for (const slug of SLUGS) {
    fixtures.set(slug, await readFilingFixture(slug));
  }
});

const CAPTURE = {
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml",
  capturedAt: "2026-09-09",
} as const;

/** A filing of our own, for the shape-change paths no real filing shows today. */
const filingWith = (
  primaryIssuer: string,
  offeringData: string,
  teamSize?: number,
): FormDFiling => ({
  xml: `<?xml version="1.0"?><edgarSubmission><submissionType>D</submissionType>
        <primaryIssuer>${primaryIssuer}</primaryIssuer>
        <offeringData>${offeringData}</offeringData></edgarSubmission>`,
  capture: CAPTURE,
  teamSize,
});

const CALIFORNIAN_ISSUER =
  "<entityName>Sprocket, Inc.</entityName><issuerAddress><city>SAN FRANCISCO</city><stateOrCountry>CA</stateOrCountry></issuerAddress>";

const TECHNOLOGY =
  "<industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup>";

describe("parseFormDFiling, against captured filings", () => {
  it.each(CALIFORNIAN_WITH_A_ROUND)(
    "turns %s into a validated Profile",
    (slug, name, stage) => {
      const result = parseFormDFiling(fixture(slug));

      expect(result.outcome).toBe("profile");
      if (result.outcome !== "profile") return;

      expect(result.profile.input.name).toBe(name);
      expect(result.profile.input.stage).toBe(stage);
      expect(() =>
        profileInputSchema.parse(result.profile.input),
      ).not.toThrow();
    },
  );

  it("maps the filing's raw industry group text onto the controlled Sector list", () => {
    // "Retailing" is the raw `industryGroupType` this filing states; see the description test
    // below, which composes its prose from that same raw text.
    const result = parseFormDFiling(fixture("sec-form-d-sporty-and-rich"));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.sector).toBe("consumer-marketplace");
  });

  it("composes a description out of the facts the filing states", () => {
    const result = parseFormDFiling(fixture("sec-form-d-elder-swamp-club"));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.description).toBe(
      "Other issuer in San Francisco, CA. Raising $6,999,995 in a private placement, " +
        "of which $6,249,998 has been sold. First sale 2026-07-08.",
    );
  });

  it("carries the filing's stated city and state as a scraped location", () => {
    const result = parseFormDFiling(fixture("sec-form-d-elder-swamp-club"));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.location).toBe("San Francisco, CA");
    expect(result.profile.attribution.location).toEqual({
      ...fixture("sec-form-d-elder-swamp-club").capture,
      provenance: "scraped",
    });
  });

  it("carries no website, because a Form D states none", () => {
    const result = parseFormDFiling(fixture("sec-form-d-sporty-and-rich"));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.website).toBeUndefined();
    expect(result.profile.attribution.website).toBeNull();
  });

  it("records the source URL and capture date its .meta.json sibling gave", () => {
    const result = parseFormDFiling(fixture("sec-form-d-point2-technology"));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.attribution.name).toEqual({
      ...fixture("sec-form-d-point2-technology").capture,
      provenance: "scraped",
    });
  });

  it("filters out an issuer whose address is not Californian", () => {
    expect(parseFormDFiling(fixture(OUT_OF_STATE))).toEqual({
      outcome: "filtered",
      stateOrCountry: "NY",
    });
  });
});

/**
 * The Ticket's provenance decision, on the two paths that reach it. A Form D that names its
 * round replaces docs/adr/0007's headcount guess with a fact and says so; one that names none
 * falls back to that guess and keeps saying `enriched`. See docs/adr/0009.
 */
describe("where `stage` comes from, and what it is attributed", () => {
  it("marks a stage the filing named as scraped", () => {
    const result = parseFormDFiling(fixture("sec-form-d-elder-swamp-club"));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.stage).toBe("seed");
    expect(result.profile.attribution.stage.provenance).toBe("scraped");
  });

  it("falls back to the adr/0007 headcount band, and marks that enriched", () => {
    // The same real filing, which names no round, with a headcount the pipeline knew from
    // elsewhere: a team of eight reads as `seed` — the proxy adr/0007 admits is poor.
    const result = parseFormDFiling({ ...fixture(NO_ROUND), teamSize: 8 });

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.stage).toBe("seed");
    expect(result.profile.attribution.stage.provenance).toBe("enriched");
  });

  it.each([NO_ROUND, SAFE_ONLY])(
    "keeps %s, which names no round and has no headcount, with its stage `not-stated` and enriched",
    (slug) => {
      const result = parseFormDFiling(fixture(slug));

      expect(result.outcome).toBe("profile");
      if (result.outcome !== "profile") return;

      expect(result.profile.input.stage).toBe("not-stated");
      // The filing did not state it; this pipeline wrote the marker. See docs/adr/0015.
      expect(result.profile.attribution.stage).toEqual({
        ...fixture(slug).capture,
        provenance: "enriched",
      });
      expect(() =>
        profileInputSchema.parse(result.profile.input),
      ).not.toThrow();
    },
  );

  it("reads a SAFE as no round, per adr/0009, and still keeps the company", () => {
    const result = parseFormDFiling(fixture(SAFE_ONLY));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.name).toBe("MaiTRICS, Inc.");
    expect(result.profile.input.location).toBe("Burlingame, CA");
    expect(result.profile.input.description).toBe(
      "Other Technology issuer in Burlingame, CA. Raising $1,500,000 in a private placement, " +
        "of which $816,500 has been sold. First sale 2025-08-11.",
    );
  });

  it("still prefers the filing's own round over a headcount that disagrees", () => {
    const result = parseFormDFiling({
      ...fixture("sec-form-d-point2-technology"),
      teamSize: 2,
    });

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;

    expect(result.profile.input.stage).toBe("series-b-plus");
    expect(result.profile.attribution.stage.provenance).toBe("scraped");
  });

  it("puts both kinds of stage into the one provenance column", () => {
    const stated = parseFormDFiling(fixture("sec-form-d-sporty-and-rich"));
    const inferred = parseFormDFiling({ ...fixture(NO_ROUND), teamSize: 40 });

    expect(stated.outcome).toBe("profile");
    expect(inferred.outcome).toBe("profile");
    if (stated.outcome !== "profile" || inferred.outcome !== "profile") return;

    expect(toProfileProvenance(stated.profile.attribution)).toEqual({
      name: "scraped",
      description: "enriched",
      sector: "scraped",
      stage: "scraped",
      website: null,
      location: "scraped",
      founders: null,
      links: null,
    });
    expect(toProfileProvenance(inferred.profile.attribution).stage).toBe(
      "enriched",
    );
  });
});

describe("a filing whose issuer holds assets rather than building a product", () => {
  it.each(HOLDS_ASSETS)(
    "rejects %s, a Californian %s, naming `industryGroup` and not `stage`",
    (slug, group) => {
      const result = parseFormDFiling(fixture(slug));

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;

      expect(result.rejection.field).toBe("industryGroup");
      expect(result.rejection.reason).toContain(group);
    },
  );

  it.each(ASSET_HOLDING_INDUSTRY_GROUPS)(
    "rejects every listed group, %s, however the filing cases it",
    (group) => {
      const result = parseFormDFiling(
        filingWith(
          CALIFORNIAN_ISSUER,
          `<industryGroup><industryGroupType> ${group.toUpperCase()} </industryGroupType></industryGroup>`,
        ),
      );

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;
      expect(result.rejection.field).toBe("industryGroup");
    },
  );

  it("still keeps an operating company in a group not listed", () => {
    const result = parseFormDFiling(filingWith(CALIFORNIAN_ISSUER, TECHNOLOGY));

    expect(result.outcome).toBe("profile");
    if (result.outcome !== "profile") return;
    expect(result.profile.input.stage).toBe("not-stated");
  });
});

describe("a filing that cannot be read is rejected, naming the field", () => {
  it.each([
    [
      "malformed XML",
      { xml: "<edgarSubmission><primaryIssuer>", capture: CAPTURE },
      "xml",
    ],
    [
      "a document that is not an EDGAR submission",
      { xml: "<html><body>Page not found</body></html>", capture: CAPTURE },
      "edgarSubmission",
    ],
  ])("rejects %s naming `%s`", (_, filing, field) => {
    const result = parseFormDFiling(filing as FormDFiling);

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.rejection.field).toBe(field);
  });

  it("rejects a filing that has lost its issuer address, naming the path", () => {
    const result = parseFormDFiling(
      filingWith("<entityName>Sprocket, Inc.</entityName>", TECHNOLOGY),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.rejection.field).toBe("primaryIssuer.issuerAddress");
  });

  it("rejects a filing whose address element has become a list", () => {
    const result = parseFormDFiling(
      filingWith(
        "<issuerAddress><stateOrCountry>CA</stateOrCountry><stateOrCountry>NY</stateOrCountry></issuerAddress>",
        TECHNOLOGY,
      ),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.rejection.field).toBe(
      "primaryIssuer.issuerAddress.stateOrCountry",
    );
  });

  it.each([
    [
      "name",
      "<issuerAddress><stateOrCountry>CA</stateOrCountry></issuerAddress>",
      TECHNOLOGY,
    ],
    ["sector", CALIFORNIAN_ISSUER, ""],
  ])(
    "rejects naming the Profile field `%s` when the filing simply omits it",
    (field, primaryIssuer, offeringData) => {
      const result = parseFormDFiling(
        filingWith(
          primaryIssuer,
          `${offeringData}<typesOfSecuritiesOffered><descriptionOfOtherType>Series A Preferred Stock</descriptionOfOtherType></typesOfSecuritiesOffered>`,
        ),
      );

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;
      expect(result.rejection.field).toBe(field);
    },
  );

  it("never writes a partial Profile: a rejection carries no input at all", () => {
    const result = parseFormDFiling(fixture(HOLDS_ASSETS[0][0]));

    expect(result.outcome).toBe("rejected");
    expect(result).not.toHaveProperty("profile");
  });
});

describe("parseFormDFilings, over a batch", () => {
  it("counts profiles, rejections and filtered issuers apart", () => {
    const batch = parseFormDFilings(SLUGS.map(fixture));

    expect(batch.profiles.map((profile) => profile.input.name)).toEqual([
      ...CALIFORNIAN_WITH_A_ROUND.map(([, name]) => name),
      "Krina AI, Inc.",
      "MaiTRICS, Inc.",
    ]);
    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "industryGroup",
      "industryGroup",
      "industryGroup",
    ]);
    expect(batch.filtered).toBe(1);
  });

  it("does not let one unreadable filing abort the rest", () => {
    const batch = parseFormDFilings([
      { xml: "<not xml", capture: CAPTURE },
      fixture("sec-form-d-sporty-and-rich"),
    ]);

    expect(batch.profiles).toHaveLength(1);
    expect(batch.rejections).toHaveLength(1);
  });
});

describe("the Source name", () => {
  it("is the lowercase slug `db/ingest.ts` will accept as half a natural key", () => {
    expect(SEC_FORM_D_SOURCE).toBe("sec-form-d");
  });
});
