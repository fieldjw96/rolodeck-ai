// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { profileInputSchema } from "../../db/profile-input";
import {
  readAcceleratorFixture,
  type AcceleratorFixture,
} from "../testing/fixtures";
import { ANGELPAD_SOURCE, parseAngelPadPortfolio } from "./angelpad";
import { toProfileProvenance } from "./scraped-profile";

/**
 * `db/fixtures/angelpad-portfolio.html` was captured with `curl` from the URL its
 * `.meta.json` sibling records, and is committed byte-for-byte. It is AngelPad's own "Alumni
 * Portfolio" page, allowed by its `robots.txt` for every client but AhrefsBot — see the pull
 * request description.
 *
 * Each entry's write-up on this page is pasted into the widget as a whole nested HTML
 * document (its own `<!DOCTYPE>`, `<html>` and `<body>`), which is real and not a fixture this
 * suite invented — see the module comment in `angelpad.ts`.
 */
let fixture: AcceleratorFixture;

beforeAll(async () => {
  fixture = await readAcceleratorFixture("angelpad-portfolio");
});

describe("parseAngelPadPortfolio, against the captured page", () => {
  it("turns every portfolio entry into a validated Profile", () => {
    const batch = parseAngelPadPortfolio(fixture.html, fixture.capture);

    // The page's own intro claims "over 150 companies in the portfolio", but the grid this
    // widget server-renders is one page of an Isotope/AJAX-paginated list — the rest loads on
    // scroll, which this parser does not run JavaScript to trigger. Forty-odd real, validated
    // Profiles from the page as captured is still a real batch, not an empty one.
    expect(batch.profiles.length).toBeGreaterThan(20);

    for (const profile of batch.profiles) {
      expect(profileInputSchema.safeParse(profile.input).success).toBe(true);
    }
  });

  it("reads a company's write-up out of its nested document", () => {
    const { profiles } = parseAngelPadPortfolio(fixture.html, fixture.capture);

    const postmates = profiles.find(
      (profile) => profile.input.name === "Postmates",
    );
    expect(postmates?.input.description).toContain(
      "original food delivery company",
    );
    expect(postmates?.input.description).toContain("Acquired by Uber Eats");
    // The nested document's own <b> and <br> tags are stripped, not carried into the text.
    expect(postmates?.input.description).not.toMatch(/<[^>]+>/);

    const iterable = profiles.find(
      (profile) => profile.input.name === "Iterable",
    );
    expect(iterable?.input.description).toContain(
      "Personalization for Marketers",
    );
  });

  it("maps a filter code to the category label the filter bar itself shows", () => {
    const { profiles } = parseAngelPadPortfolio(fixture.html, fixture.capture);

    const postmates = profiles.find(
      (profile) => profile.input.name === "Postmates",
    );
    expect(postmates?.input.sector).toBe("consumer-marketplace");

    const iterable = profiles.find(
      (profile) => profile.input.name === "Iterable",
    );
    expect(iterable?.input.sector).toBe("saas-enterprise");
  });

  it("records every alumnus as pre-seed, regardless of how far it has since gone", () => {
    const { profiles } = parseAngelPadPortfolio(fixture.html, fixture.capture);

    // Postmates was acquired by Uber Eats for $2.65 billion; the Profile still records the
    // point AngelPad actually admitted it.
    const postmates = profiles.find(
      (profile) => profile.input.name === "Postmates",
    );
    expect(postmates?.input.stage).toBe("pre-seed");
  });

  it("carries no website: the page's own link is AngelPad's write-up, not reliably the company's site", () => {
    const { profiles } = parseAngelPadPortfolio(fixture.html, fixture.capture);

    for (const profile of profiles) {
      expect(profile.input.website).toBeUndefined();
      expect(profile.attribution.website).toBeNull();
    }
  });
});

describe("provenance", () => {
  it("attributes name, description and sector to the page, and stage to our own rule", () => {
    const { profiles } = parseAngelPadPortfolio(fixture.html, fixture.capture);
    const first = profiles[0]!;

    expect(first.attribution.name).toEqual({
      ...fixture.capture,
      provenance: "scraped",
    });
    expect(first.attribution.stage).toEqual({
      ...fixture.capture,
      provenance: "enriched",
    });
  });

  it("narrows to the shape the profiles column takes", () => {
    const { profiles } = parseAngelPadPortfolio(fixture.html, fixture.capture);

    expect(toProfileProvenance(profiles[0]!.attribution)).toEqual({
      name: "scraped",
      description: "scraped",
      sector: "scraped",
      stage: "enriched",
      website: null,
      location: null,
    });
  });
});

describe("the Source slug", () => {
  it("is a lowercase slug persistProfiles will accept", () => {
    expect(ANGELPAD_SOURCE).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("parseAngelPadPortfolio, against a page that has changed shape", () => {
  const CAPTURE = {
    sourceUrl: "https://angelpad.com/portfolio/",
    capturedAt: "2026-09-10",
  } as const;

  it("rejects a page carrying no portfolio entries at all, naming the widget's own class", () => {
    const batch = parseAngelPadPortfolio(
      "<html><body>Not found</body></html>",
      CAPTURE,
    );

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("gw-gopf-post-title");
  });

  const entry = (filter: string, name: string, description: string): string =>
    `<div class="gw-gopf-col-wrap" data-filter="${filter}"><div class="gw-gopf-post-content"><div class="gw-gopf-post-title"><b><a href="https://example.com" target="_self">${name}</a></b> <!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN" "http://www.w3.org/TR/REC-html40/loose.dtd"><html><body data-rsssl=1><p>${description}</p></body></html></div></div></div>`;

  it("names sector when none of an entry's filters is a known category", () => {
    const batch = parseAngelPadPortfolio(
      entry("ap1f featured", "Sprocket", "Developer tooling."),
      CAPTURE,
    );

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("sector");
  });

  it("decodes entities in a name and description written with them", () => {
    const batch = parseAngelPadPortfolio(
      entry("saasf", "R&amp;D Co", "Tooling for &quot;R&amp;D&quot; teams."),
      CAPTURE,
    );

    expect(batch.rejections).toEqual([]);
    expect(batch.profiles[0]?.input.name).toBe("R&D Co");
    expect(batch.profiles[0]?.input.description).toBe(
      'Tooling for "R&D" teams.',
    );
  });
});
