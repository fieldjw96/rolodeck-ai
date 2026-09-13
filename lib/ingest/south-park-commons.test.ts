// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { profileInputSchema } from "../../db/profile-input";
import {
  readAcceleratorFixture,
  type AcceleratorFixture,
} from "../testing/fixtures";
import { toProfileProvenance } from "./scraped-profile";
import {
  parseSouthParkCommonsCompanies,
  SOUTH_PARK_COMMONS_SOURCE,
} from "./south-park-commons";

/**
 * `db/fixtures/south-park-commons-companies.html` was captured with `curl` from the URL its
 * `.meta.json` sibling records, and is committed byte-for-byte. It is South Park Commons's own
 * "Companies" page, allowed by its `robots.txt` — see the pull request description.
 */
let fixture: AcceleratorFixture;

beforeAll(async () => {
  fixture = await readAcceleratorFixture("south-park-commons-companies");
});

describe("parseSouthParkCommonsCompanies, against the captured page", () => {
  it("turns the embedded company-data payload into validated Profiles", () => {
    const batch = parseSouthParkCommonsCompanies(fixture.html, fixture.capture);

    expect(batch.rejections).toEqual([]);
    // The real page carries well over a hundred companies.
    expect(batch.profiles.length).toBeGreaterThan(100);

    for (const profile of batch.profiles) {
      expect(profileInputSchema.safeParse(profile.input).success).toBe(true);
    }
  });

  it("reads a company's stated bio and industry off the page", () => {
    const { profiles } = parseSouthParkCommonsCompanies(
      fixture.html,
      fixture.capture,
    );

    const compound = profiles.find(
      (profile) => profile.input.name === "Compound",
    );
    expect(compound?.input.description).toBe(
      "Autonomous interest rates, onchain",
    );
    expect(compound?.input.sector).toBe("other");

    const vanta = profiles.find((profile) => profile.input.name === "Vanta");
    expect(vanta?.input.sector).toBe("security");
  });

  it("records every company as pre-seed, regardless of how far it has since grown", () => {
    const { profiles } = parseSouthParkCommonsCompanies(
      fixture.html,
      fixture.capture,
    );

    // The page's own `status` calls this one "Unicorn"; the Profile still records the point
    // South Park Commons actually backed it.
    const compound = profiles.find(
      (profile) => profile.input.name === "Compound",
    );
    expect(compound?.input.stage).toBe("pre-seed");

    for (const profile of profiles) {
      expect(profile.input.stage).toBe("pre-seed");
    }
  });

  it("carries no website: the page's own payload states none", () => {
    const { profiles } = parseSouthParkCommonsCompanies(
      fixture.html,
      fixture.capture,
    );

    for (const profile of profiles) {
      expect(profile.input.website).toBeUndefined();
      expect(profile.attribution.website).toBeNull();
    }
  });
});

describe("provenance", () => {
  it("attributes name, description and sector to the page, and stage to our own rule", () => {
    const { profiles } = parseSouthParkCommonsCompanies(
      fixture.html,
      fixture.capture,
    );
    const first = profiles[0]!;

    expect(first.attribution.name).toEqual({
      ...fixture.capture,
      provenance: "scraped",
    });
    expect(first.attribution.description).toEqual({
      ...fixture.capture,
      provenance: "scraped",
    });
    expect(first.attribution.sector).toEqual({
      ...fixture.capture,
      provenance: "scraped",
    });
    expect(first.attribution.stage).toEqual({
      ...fixture.capture,
      provenance: "enriched",
    });
  });

  it("narrows to the shape the profiles column takes", () => {
    const { profiles } = parseSouthParkCommonsCompanies(
      fixture.html,
      fixture.capture,
    );

    expect(toProfileProvenance(profiles[0]!.attribution)).toEqual({
      name: "scraped",
      description: "scraped",
      sector: "scraped",
      stage: "enriched",
      website: null,
    });
  });
});

describe("the Source slug", () => {
  it("is a lowercase slug persistProfiles will accept", () => {
    expect(SOUTH_PARK_COMMONS_SOURCE).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("parseSouthParkCommonsCompanies, against a page that has changed shape", () => {
  const CAPTURE = {
    sourceUrl: "https://www.southparkcommons.com/companies/",
    capturedAt: "2026-09-10",
  } as const;

  it("rejects a page carrying no company-data payload at all", () => {
    const batch = parseSouthParkCommonsCompanies(
      "<html><body>Not found</body></html>",
      CAPTURE,
    );

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("company-data");
  });

  it("rejects a payload that is no longer JSON", () => {
    const batch = parseSouthParkCommonsCompanies(
      `<script type="application/json" id="company-data">{not json</script>`,
      CAPTURE,
    );

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("company-data");
  });

  it("rejects a payload that is no longer an array", () => {
    const batch = parseSouthParkCommonsCompanies(
      `<script type="application/json" id="company-data">{"name":"Sprocket"}</script>`,
      CAPTURE,
    );

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("(root)");
  });

  it("names a company record missing its bio, rather than half-writing it", () => {
    const batch = parseSouthParkCommonsCompanies(
      `<script type="application/json" id="company-data">[{"name":"Sprocket","industry":"Robotics"}]</script>`,
      CAPTURE,
    );

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("description");
  });

  it("names a company record missing its industry, rather than half-writing it", () => {
    const batch = parseSouthParkCommonsCompanies(
      `<script type="application/json" id="company-data">[{"name":"Sprocket","bio":"Developer tooling for warehouse robotics."}]</script>`,
      CAPTURE,
    );

    expect(batch.profiles).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("sector");
  });

  it("ignores keys the payload gains, so a new field is not an outage", () => {
    const batch = parseSouthParkCommonsCompanies(
      `<script type="application/json" id="company-data">[{"name":"Sprocket","bio":"Developer tooling.","industry":"Robotics","someNewField":{"a":1}}]</script>`,
      CAPTURE,
    );

    expect(batch.rejections).toEqual([]);
    expect(batch.profiles).toHaveLength(1);
    expect(batch.profiles[0]?.input.name).toBe("Sprocket");
  });
});
