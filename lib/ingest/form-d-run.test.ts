// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import type { IngestReport } from "../../db/ingest";
import {
  DEFAULT_LIMIT,
  parseFormDArgs,
  readEdgarContact,
  summariseRun,
  wroteNothing,
} from "./form-d-run";

const TODAY = "2026-09-09";

const report = (over: Partial<IngestReport> = {}): IngestReport => ({
  inserted: 0,
  updated: 0,
  rejected: 0,
  rejections: [],
  ...over,
});

describe("parseFormDArgs", () => {
  it("defaults to the last seven days, up to a hundred filings", () => {
    expect(parseFormDArgs([], TODAY)).toEqual({
      since: "2026-09-02",
      until: TODAY,
      limit: DEFAULT_LIMIT,
      today: TODAY,
    });
  });

  it("counts back over a month boundary rather than off the end of one", () => {
    expect(parseFormDArgs([], "2026-03-03").since).toBe("2026-02-24");
  });

  it("takes an explicit window and size", () => {
    expect(
      parseFormDArgs(
        ["--since", "2026-01-01", "--until", "2026-01-31", "--limit", "5"],
        TODAY,
      ),
    ).toEqual({
      since: "2026-01-01",
      until: "2026-01-31",
      limit: 5,
      today: TODAY,
    });
  });

  it("counts back from an explicit --until, not from today", () => {
    expect(parseFormDArgs(["--until", "2026-01-31"], TODAY).since).toBe(
      "2026-01-24",
    );
  });

  it.each([
    [["--since", "yesterday"], "must be a YYYY-MM-DD date"],
    [["--until", "2026-13-45"], "must be a YYYY-MM-DD date"],
    [["--since"], "--since needs a value"],
    [["--since", "--limit", "5"], "--since needs a value"],
    [["--limit"], "--limit needs a value"],
    [["--limit", "0"], "--limit must be a positive whole number"],
    [["--limit", "2.5"], "--limit must be a positive whole number"],
    [["--limit", "lots"], "--limit must be a positive whole number"],
    [["--since", "2026-09-09", "--until", "2026-09-01"], "is after"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseFormDArgs(argv, TODAY)).toThrow(message);
  });
});

describe("readEdgarContact", () => {
  const original = process.env.SEC_EDGAR_CONTACT;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SEC_EDGAR_CONTACT;
    } else {
      process.env.SEC_EDGAR_CONTACT = original;
    }
  });

  it("reads the address the SEC is to be given", () => {
    process.env.SEC_EDGAR_CONTACT = "  ops@example.com  ";

    expect(readEdgarContact()).toBe("ops@example.com");
  });

  it.each([[undefined], [""], ["   "]])(
    "refuses to run anonymously when it is %j",
    (value) => {
      if (value === undefined) {
        delete process.env.SEC_EDGAR_CONTACT;
      } else {
        process.env.SEC_EDGAR_CONTACT = value;
      }

      expect(() => readEdgarContact()).toThrow("SEC_EDGAR_CONTACT is not set");
    },
  );
});

/**
 * The Ticket's own words: a scraper whose selectors have gone stale returns zero rows and
 * reports success, which is the failure this project keeps meeting.
 */
describe("wroteNothing", () => {
  it("fails a run that put nothing in the table", () => {
    expect(wroteNothing(report())).toBe(true);
    expect(wroteNothing(report({ rejected: 40, rejections: [] }))).toBe(true);
  });

  it("passes a second run of a healthy pipeline, which inserts nothing", () => {
    // Ingest is idempotent on (owner_id, source, name_key) — docs/adr/0008 — so re-running a
    // Source updates rather than inserts. Failing on `inserted === 0` alone would cry wolf.
    expect(wroteNothing(report({ inserted: 0, updated: 12 }))).toBe(false);
  });

  it("passes a first run", () => {
    expect(wroteNothing(report({ inserted: 12 }))).toBe(false);
  });

  // scripts/fetch-show-hn.ts imports this rather than defining its own: a week whose
  // companies were all seen before, and a manual re-run straight after a scheduled one, must
  // both pass rather than fail on `inserted === 0` alone.
  it("passes a show-hn run where every company already existed", () => {
    expect(wroteNothing(report({ inserted: 0, updated: 5 }))).toBe(false);
  });
});

describe("summariseRun", () => {
  it("names the field every rejection stopped on", () => {
    const summary = summariseRun(
      {
        profiles: [],
        filtered: 2,
        rejections: [
          {
            field: "industryGroup",
            reason: "the issuer holds assets",
            raw: null,
          },
        ],
      },
      report({
        inserted: 1,
        rejections: [
          { field: "provenance.website", reason: "must be null", raw: null },
        ],
      }),
    );

    expect(summary).toContain("Read 3 filings from EDGAR.");
    expect(summary).toContain("2 outside California, 1 rejected.");
    expect(summary).toContain("Wrote 1 new Profiles and updated 0.");
    expect(summary).toContain(
      "rejected on industryGroup: the issuer holds assets",
    );
    expect(summary).toContain("rejected on provenance.website: must be null");
  });
});
