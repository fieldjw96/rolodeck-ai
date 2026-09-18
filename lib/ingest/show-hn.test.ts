import { beforeAll, describe, expect, it } from "vitest";

import { profileInputSchema } from "../../db/profile-input";
import { readShowHnFixture, type ShowHnFixture } from "../testing/fixtures";
import {
  parseShowHnPost,
  parseShowHnPosts,
  showHnSearchResponseSchema,
  toProfileProvenance,
  type ScrapedProfile,
} from "./show-hn";

/**
 * Every fixture under `db/fixtures/show-hn-*.json` is a real Algolia search response, captured
 * with `curl` against the single story id its `.meta.json` sibling records, and committed
 * byte-for-byte. Together they cover what Ticket #49 asks this parser to tell apart:
 *
 * - `show-hn-unblur`               — a company URL and text a sector can be read from.
 * - `show-hn-gbdl`                 — a URL to a GitHub repository, not a company.
 * - `show-hn-laserdisc`            — a URL to a YouTube video, not a company.
 * - `show-hn-whiteboard-animator`  — a text post carrying no URL at all.
 * - `show-hn-auralfret`            — a company URL whose post names no derivable sector.
 */
const ACCEPTED = ["show-hn-unblur"] as const;
const REJECTED = [
  "show-hn-gbdl",
  "show-hn-laserdisc",
  "show-hn-whiteboard-animator",
  "show-hn-auralfret",
] as const;

const fixtures = new Map<string, ShowHnFixture>();

const fixture = (slug: string): ShowHnFixture => {
  const found = fixtures.get(slug);
  if (found === undefined) throw new Error(`fixture ${slug} was not loaded`);
  return found;
};

const parsed = (slug: string): ScrapedProfile => {
  const result = parseShowHnPost(fixture(slug).hit, fixture(slug).capture);
  if (!result.success) {
    throw new Error(
      `${slug} was rejected on ${result.rejection.field}: ${result.rejection.reason}`,
    );
  }
  return result.profile;
};

beforeAll(async () => {
  for (const slug of [...ACCEPTED, ...REJECTED]) {
    fixtures.set(slug, await readShowHnFixture(slug));
  }
});

const CAPTURE = {
  query: "https://hn.algolia.com/api/v1/search?tags=story_1",
  capturedAt: "2026-09-09",
} as const;

describe("parseShowHnPost, against captured posts", () => {
  it("turns a post with a company URL and a readable sector into a validated Profile", () => {
    const { input } = parsed("show-hn-unblur");

    expect(input.name).toBe("Unblur");
    expect(input.description).toContain("spending");
    // Derived keyword category "Fintech", mapped onto the controlled vocabulary.
    expect(input.sector).toBe("fintech");
    expect(input.stage).toBe("pre-seed");
    expect(input.website).toBe("https://unblur.money");
  });

  it("passes profileInputSchema for every accepted post", () => {
    expect(
      profileInputSchema.safeParse(parsed("show-hn-unblur").input).success,
    ).toBe(true);
  });

  it("rejects a post linking to a GitHub repository, naming website", () => {
    const result = parseShowHnPost(
      fixture("show-hn-gbdl").hit,
      fixture("show-hn-gbdl").capture,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("website");
    expect(result.rejection.reason).toContain("code repository");
  });

  it("rejects a post linking to a demo video, naming website", () => {
    const result = parseShowHnPost(
      fixture("show-hn-laserdisc").hit,
      fixture("show-hn-laserdisc").capture,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("website");
    expect(result.rejection.reason).toContain("demo video");
  });

  it("rejects a text post that carries no URL at all, naming website", () => {
    const result = parseShowHnPost(
      fixture("show-hn-whiteboard-animator").hit,
      fixture("show-hn-whiteboard-animator").capture,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("website");
    expect(result.rejection.reason).toContain("no URL");
  });

  it("rejects a post with a company URL but no derivable sector, naming sector, rather than guessing one", () => {
    const result = parseShowHnPost(
      fixture("show-hn-auralfret").hit,
      fixture("show-hn-auralfret").capture,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("sector");
  });
});

describe("provenance", () => {
  it("attributes name, description and website to the query and day it was read", () => {
    const { attribution } = parsed("show-hn-unblur");
    const { capture } = fixture("show-hn-unblur");

    for (const field of ["name", "description", "website"] as const) {
      expect(attribution[field]).toEqual({ ...capture, provenance: "scraped" });
    }
  });

  it("writes a null location, and no null provenance to attribute it, because a Show HN post states none", () => {
    const result = parsed("show-hn-unblur");

    expect(result.input.location).toBeUndefined();
    expect(result.attribution.location).toBeNull();
  });

  it("marks sector enriched, because it is derived from the post's own words, not stated", () => {
    expect(parsed("show-hn-unblur").attribution.sector.provenance).toBe(
      "enriched",
    );
  });

  it("marks stage enriched, because no Show HN post states a funding round", () => {
    const { attribution } = parsed("show-hn-unblur");

    expect(attribution.stage.provenance).toBe("enriched");
    expect(attribution.stage).toEqual({
      ...fixture("show-hn-unblur").capture,
      provenance: "enriched",
    });
  });

  it("narrows attribution to the shape the profiles column takes", () => {
    expect(toProfileProvenance(parsed("show-hn-unblur").attribution)).toEqual({
      name: "scraped",
      description: "scraped",
      sector: "enriched",
      stage: "enriched",
      website: "scraped",
      location: null,
      founders: null,
      links: null,
    });
  });
});

describe("parseShowHnPost, against a post that has changed shape", () => {
  it("names title when it is missing", () => {
    const result = parseShowHnPost(
      { objectID: "1", url: "https://sprocket.example" },
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("title");
  });

  it("names url when it has changed type", () => {
    const result = parseShowHnPost(
      { objectID: "1", title: "Show HN: Sprocket", url: 12345 },
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("url");
  });

  it("rejects a post whose URL is not a valid URL, naming website", () => {
    const result = parseShowHnPost(
      {
        objectID: "1",
        title: "Show HN: Sprocket – developer tooling API for warehouses",
        url: "not a url",
      },
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("website");
  });

  it("rejects a post linking to a blog post, naming website", () => {
    const result = parseShowHnPost(
      {
        objectID: "1",
        title: "Show HN: Sprocket – developer tooling for warehouse APIs",
        url: "https://sprocket.medium.com/announcing-sprocket",
      },
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("website");
    expect(result.rejection.reason).toContain("blog post");
  });

  it("rejects a post whose URL is not http(s), naming website", () => {
    const result = parseShowHnPost(
      {
        objectID: "1",
        title: "Show HN: Sprocket – a developer API for build pipelines",
        url: "ftp://sprocket.example/releases",
      },
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("website");
  });

  it("rejects a post with a company URL but no story text or title tail, naming description", () => {
    const result = parseShowHnPost(
      {
        objectID: "1",
        title: "Show HN: Sprocket",
        url: "https://sprocket.example",
      },
      CAPTURE,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.rejection.field).toBe("description");
  });

  it("ignores keys the payload gains, so a new field is not an outage", () => {
    const result = parseShowHnPost(
      {
        objectID: "1",
        title: "Show HN: Sprocket – a developer API for build pipelines",
        url: "https://sprocket.example",
        points: 42,
        num_comments: 7,
        some_new_field: { hn: "added this" },
      },
      CAPTURE,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.input.sector).toBe("developer-tools");
  });

  it("decodes numeric hex entities, the form the API escapes an apostrophe with", () => {
    const result = parseShowHnPost(
      {
        objectID: "1",
        title: "Show HN: Sprocket",
        url: "https://sprocket.example",
        story_text: "It&#x27;s a developer API for build pipelines.",
      },
      CAPTURE,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.input.description).toBe(
      "It's a developer API for build pipelines.",
    );
  });

  it("decodes and flattens the HTML story_text carries", () => {
    const result = parseShowHnPost(
      {
        objectID: "1",
        title: "Show HN: Sprocket",
        url: "https://sprocket.example",
        story_text:
          '<p>Developer tooling for &quot;R&amp;D&quot; teams.<p>See our <a href="https://sprocket.example/docs">API docs</a>.',
      },
      CAPTURE,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.input.description).toBe(
      'Developer tooling for "R&D" teams. See our API docs .',
    );
    expect(result.profile.input.sector).toBe("developer-tools");
  });
});

describe("parseShowHnPosts", () => {
  it("reports how many candidates were rejected, and the field that failed each", () => {
    const batch = parseShowHnPosts(
      [...ACCEPTED, ...REJECTED].map((slug) => fixture(slug).hit),
      CAPTURE,
    );

    expect(batch.profiles).toHaveLength(ACCEPTED.length);
    expect(batch.rejections).toHaveLength(REJECTED.length);
    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "website",
      "website",
      "website",
      "sector",
    ]);
  });

  it("returns an empty batch for no posts", () => {
    expect(parseShowHnPosts([], CAPTURE)).toEqual({
      profiles: [],
      rejections: [],
    });
  });
});

describe("showHnSearchResponseSchema", () => {
  it("accepts the shape every captured response has", () => {
    expect(
      showHnSearchResponseSchema.safeParse({ hits: [{ objectID: "1" }] })
        .success,
    ).toBe(true);
  });

  it("rejects a response with no hits array", () => {
    expect(showHnSearchResponseSchema.safeParse({}).success).toBe(false);
  });
});
