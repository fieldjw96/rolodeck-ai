// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  MATCH_WEIGHTS,
  NEWS_DISPLAY_THRESHOLD,
  scoreNewsMatch,
  type MatchSubject,
} from "./match";

const RAMP: MatchSubject = { name: "Ramp", sector: "fintech" };
const MERCURY: MatchSubject = { name: "Mercury", sector: "fintech" };

describe("scoreNewsMatch", () => {
  it("scores an obvious match — the name in the headline, the Sector's own terms, and funding news — above the threshold", () => {
    const score = scoreNewsMatch(RAMP, {
      title:
        "Ramp raises $150 million to expand its corporate card and expense platform",
      description: "The fintech startup's valuation climbs to $13 billion.",
    });

    expect(score).toBe(
      MATCH_WEIGHTS.titleMention +
        MATCH_WEIGHTS.strongSectorEvidence +
        MATCH_WEIGHTS.companyContext,
    );
    expect(score).toBeGreaterThanOrEqual(NEWS_DISPLAY_THRESHOLD);
  });

  it("scores an obvious mismatch that shares the name — a planet, not a bank — below the threshold", () => {
    const score = scoreNewsMatch(MERCURY, {
      title: "Mercury is closer to the Sun than ever in new NASA images",
      description: "The smallest planet in the solar system shows its craters.",
    });

    expect(score).toBe(MATCH_WEIGHTS.titleMention);
    expect(score).toBeLessThan(NEWS_DISPLAY_THRESHOLD);
  });

  it("scores an ambiguous case — company news with nothing to say which company — between the two, and does not show it", () => {
    const mismatch = scoreNewsMatch(MERCURY, {
      title: "Mercury is closer to the Sun than ever in new NASA images",
      description: "The smallest planet in the solar system shows its craters.",
    });
    const match = scoreNewsMatch(RAMP, {
      title:
        "Ramp raises $150 million to expand its corporate card and expense platform",
      description: "The fintech startup's valuation climbs to $13 billion.",
    });

    // Mercury the bank, Mercury Insurance and Mercury Systems all name CEOs.
    const ambiguous = scoreNewsMatch(MERCURY, {
      title: "Mercury names a new CEO as it expands",
      description: "The company said the appointment follows a year of growth.",
    });

    expect(ambiguous).toBe(
      MATCH_WEIGHTS.titleMention + MATCH_WEIGHTS.companyContext,
    );
    expect(ambiguous).toBeGreaterThan(mismatch);
    expect(ambiguous).toBeLessThan(match);
    expect(ambiguous).toBeLessThan(NEWS_DISPLAY_THRESHOLD);
  });

  it("scores an article that never names the company as zero, whatever else it shares", () => {
    expect(
      scoreNewsMatch(RAMP, {
        title: "Corporate card startups raise record funding",
        description: "Fintech investors pile into expense management.",
      }),
    ).toBe(0);
  });

  it("counts a mention in lower case for less than a proper noun", () => {
    const lower = scoreNewsMatch(RAMP, {
      title: "Suppliers ramp up as payments slow",
      description: null,
    });
    const proper = scoreNewsMatch(RAMP, {
      title: "Ramp speeds up payments to suppliers",
      description: null,
    });

    expect(lower).toBeLessThan(proper);
    expect(lower).toBeLessThan(NEWS_DISPLAY_THRESHOLD);
  });

  it("reaches exactly the threshold for a standfirst mention with one Sector term and company context", () => {
    const score = scoreNewsMatch(RAMP, {
      title: "Five startups to watch this year",
      description: "Ramp, the corporate card company, leads the list.",
    });

    // 0.25 + 0.2 + 0.15 is 0.6000000000000001 unrounded, which would sit on the wrong side of
    // a comparison anyone reading the stored number expects to be equal.
    expect(score).toBe(0.6);
    expect(score).toBeGreaterThanOrEqual(NEWS_DISPLAY_THRESHOLD);
  });

  it("does not count the company's own name as evidence of its Sector", () => {
    const acme: MatchSubject = {
      name: "Acme Robotics",
      sector: "hardware-robotics",
    };

    const nameOnly = scoreNewsMatch(acme, {
      title: "Acme Robotics opens a new office in Oakland",
      description: null,
    });
    const withEvidence = scoreNewsMatch(acme, {
      title: "Acme Robotics unveils a warehouse robot",
      description: null,
    });

    expect(nameOnly).toBe(
      MATCH_WEIGHTS.titleMention + MATCH_WEIGHTS.distinctiveName,
    );
    expect(withEvidence).toBeCloseTo(
      nameOnly + MATCH_WEIGHTS.sectorEvidence,
      10,
    );
  });

  it("gives a Company Profile in `other`, or with a Sector it does not recognise, no Sector evidence", () => {
    const article = {
      title: "Quiet Co raises a seed round for its payments app",
      description: null,
    };

    const fintech = scoreNewsMatch(
      { name: "Quiet Co", sector: "fintech" },
      article,
    );
    const other = scoreNewsMatch(
      { name: "Quiet Co", sector: "other" },
      article,
    );
    const unknown = scoreNewsMatch(
      { name: "Quiet Co", sector: "Hardware" },
      article,
    );

    // Close to rather than equal: the expected value is itself floating-point arithmetic, while
    // the score under test is already rounded to two places.
    expect(other).toBeCloseTo(fintech - MATCH_WEIGHTS.sectorEvidence, 10);
    expect(unknown).toBe(other);
  });

  it("reads a name full of regular-expression syntax literally", () => {
    const subject: MatchSubject = { name: "Fig (YC S24)", sector: "other" };

    expect(
      scoreNewsMatch(subject, {
        title: "Fig (YC S24) raises a seed round",
        description: null,
      }),
    ).toBe(
      MATCH_WEIGHTS.titleMention +
        MATCH_WEIGHTS.companyContext +
        MATCH_WEIGHTS.distinctiveName,
    );
    expect(
      scoreNewsMatch(subject, { title: "Fig YC S24", description: null }),
    ).toBe(0);
  });

  it("scores a blank name as zero rather than as a mention everywhere", () => {
    expect(
      scoreNewsMatch(
        { name: "  ", sector: "fintech" },
        { title: "Fintech startup raises funding", description: null },
      ),
    ).toBe(0);
  });

  it("does not match a name inside a longer word", () => {
    expect(
      scoreNewsMatch(RAMP, {
        title: "Rampant fraud hits card payments",
        description: null,
      }),
    ).toBe(0);
  });

  it("never scores outside 0 to 1, even with every signal present", () => {
    const score = scoreNewsMatch(
      { name: "PostHog", sector: "developer-tools" },
      {
        title:
          "PostHog raises Series E as developers adopt its open-source SDK",
        description: "The startup's API and GitHub following keep growing.",
      },
    );

    expect(score).toBeGreaterThan(NEWS_DISPLAY_THRESHOLD);
    expect(score).toBeLessThanOrEqual(1);
  });
});
