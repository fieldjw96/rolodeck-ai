// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  describeLateSource,
  judgeFreshness,
  lateSourceIssueBody,
  lateSourceIssueTitle,
  previousOccurrences,
  SCHEDULE_GRACE_MS,
  type FreshnessInput,
} from "./freshness";

/**
 * The staleness decision, offline against fixed inputs: given a cron, a last-success time and a
 * current time, is this Source late. Nothing here touches the network or the clock, which is
 * the point of keeping the decision apart from fetching the run history.
 *
 * Dates are all in September 2026 and all UTC. 2026-09-14 is a Monday, so 2026-09-17 is a
 * Thursday and 2026-09-20 is the Sunday before the next Monday.
 */

const DAILY = "20 8 * * *"; // ingest-news.yml's own cadence
const WEEKLY_MONDAY = "30 7 * * 1"; // the shape the Monday Sources use

const HOUR_MS = 60 * 60 * 1000;

function judge(overrides: Partial<FreshnessInput> = {}) {
  return judgeFreshness({
    crons: [DAILY],
    lastSuccessAt: new Date("2026-09-17T08:25:00Z"),
    // Old enough that it is never the reason for a verdict unless a test says so.
    workflowCreatedAt: new Date("2026-01-01T00:00:00Z"),
    now: new Date("2026-09-17T16:00:00Z"),
    ...overrides,
  });
}

describe("the grace period", () => {
  it("is long enough to absorb GitHub's scheduling delay and shorter than a day", () => {
    // A daily Source is the shortest cadence here; a grace of a day or more could never report
    // one. The lower bound is the "occasionally hours" GitHub warns about.
    expect(SCHEDULE_GRACE_MS).toBeGreaterThanOrEqual(3 * HOUR_MS);
    expect(SCHEDULE_GRACE_MS).toBeLessThan(24 * HOUR_MS);
  });
});

describe("previousOccurrences", () => {
  it("counts an occurrence landing exactly on the moment asked about", () => {
    expect(
      previousOccurrences([DAILY], new Date("2026-09-17T08:20:00Z"), 1),
    ).toEqual([new Date("2026-09-17T08:20:00Z")]);
  });

  it("walks back one interval at a time", () => {
    expect(
      previousOccurrences([WEEKLY_MONDAY], new Date("2026-09-17T09:00:00Z"), 3),
    ).toEqual([
      new Date("2026-09-14T07:30:00Z"),
      new Date("2026-09-07T07:30:00Z"),
      new Date("2026-08-31T07:30:00Z"),
    ]);
  });

  it("reads step values, lists and ranges rather than pattern-matching the string", () => {
    // A cron a regular expression over "0 8 * * *" would have nothing to say about.
    expect(
      previousOccurrences(
        ["*/15 9-11 * * 1-5"],
        new Date("2026-09-17T10:07:00Z"),
        2,
      ),
    ).toEqual([
      new Date("2026-09-17T10:00:00Z"),
      new Date("2026-09-17T09:45:00Z"),
    ]);

    expect(
      previousOccurrences(
        ["0 6,18 * * *"],
        new Date("2026-09-17T10:00:00Z"),
        2,
      ),
    ).toEqual([
      new Date("2026-09-17T06:00:00Z"),
      new Date("2026-09-16T18:00:00Z"),
    ]);
  });

  it("treats a restricted day-of-month and day-of-week as either, not both", () => {
    // Cron's documented oddity: with both fields restricted the schedule fires on a matching
    // day-of-month OR a matching day-of-week. 2026-09-17 is a Thursday, so the 1st of the month
    // and the most recent Monday are both occurrences.
    expect(
      previousOccurrences(["0 5 1 * 1"], new Date("2026-09-17T10:00:00Z"), 2),
    ).toEqual([
      new Date("2026-09-14T05:00:00Z"),
      new Date("2026-09-07T05:00:00Z"),
    ]);
  });

  it("takes the union when a Source carries more than one cron", () => {
    expect(
      previousOccurrences(
        [DAILY, WEEKLY_MONDAY],
        new Date("2026-09-14T09:00:00Z"),
        3,
      ),
    ).toEqual([
      new Date("2026-09-14T08:20:00Z"),
      new Date("2026-09-14T07:30:00Z"),
      new Date("2026-09-13T08:20:00Z"),
    ]);
  });

  it("refuses a Source with no cron rather than inventing a cadence", () => {
    expect(() => previousOccurrences([], new Date(), 1)).toThrow(/no cron/);
  });
});

describe("judgeFreshness", () => {
  it("is on time when it succeeded at its most recent occurrence", () => {
    expect(judge()).toMatchObject({ verdict: "on-time", late: false });
  });

  it("is on time when the run is late by less than the grace", () => {
    // It is 11:00 and the 08:20 run has not happened; that is two and a half hours, which is
    // ordinary for GitHub's scheduler. The question asked is still yesterday's.
    const freshness = judge({
      lastSuccessAt: new Date("2026-09-16T08:24:00Z"),
      now: new Date("2026-09-17T11:00:00Z"),
    });

    expect(freshness).toMatchObject({ verdict: "on-time", late: false });
    expect(freshness.dueAt).toEqual(new Date("2026-09-16T08:20:00Z"));
  });

  it("is late when the run is late by more than the grace", () => {
    const freshness = judge({
      lastSuccessAt: new Date("2026-09-16T08:24:00Z"),
      now: new Date("2026-09-17T15:00:00Z"),
    });

    expect(freshness).toMatchObject({ verdict: "late", late: true });
    expect(freshness.dueAt).toEqual(new Date("2026-09-17T08:20:00Z"));
  });

  it("keeps the whole gap rather than resetting it when a check is missed", () => {
    // The check itself is a scheduled workflow and can be dropped. A Source that stopped four
    // days ago is still reported against the occurrence it was last due at, not the one it
    // happened to miss most recently.
    const freshness = judge({
      lastSuccessAt: new Date("2026-09-13T08:24:00Z"),
      now: new Date("2026-09-17T15:00:00Z"),
    });

    expect(freshness).toMatchObject({ verdict: "late", late: true });
    expect(freshness.lastSuccessAt).toEqual(new Date("2026-09-13T08:24:00Z"));
    expect(freshness.dueAt).toEqual(new Date("2026-09-17T08:20:00Z"));
  });

  it("does not judge a Source that has never succeeded and is too new to have missed anything", () => {
    const freshness = judge({
      lastSuccessAt: null,
      workflowCreatedAt: new Date("2026-09-17T14:00:00Z"),
      now: new Date("2026-09-17T15:00:00Z"),
    });

    expect(freshness).toMatchObject({
      verdict: "too-new-to-judge",
      late: false,
    });
  });

  it("reports a Source that has never succeeded once it is older than an interval plus the grace", () => {
    // Daily, so an interval plus the grace is thirty hours. Added thirty-one hours ago.
    const freshness = judge({
      lastSuccessAt: null,
      workflowCreatedAt: new Date("2026-09-16T08:00:00Z"),
      now: new Date("2026-09-17T15:00:00Z"),
    });

    expect(freshness).toMatchObject({
      verdict: "never-succeeded",
      late: true,
      lastSuccessAt: null,
    });
  });

  it("scales that allowance to the Source's own cadence", () => {
    // The same thirty-one-hour-old workflow, weekly: a week plus the grace has not passed, so
    // it has missed nothing yet.
    expect(
      judge({
        crons: [WEEKLY_MONDAY],
        lastSuccessAt: null,
        workflowCreatedAt: new Date("2026-09-16T08:00:00Z"),
        now: new Date("2026-09-17T15:00:00Z"),
      }),
    ).toMatchObject({ verdict: "too-new-to-judge", late: false });
  });

  it("leaves a weekly Source alone on the day before it is due", () => {
    // Sunday. It ran on Monday as it should have, and is not due again until tomorrow.
    const freshness = judge({
      crons: [WEEKLY_MONDAY],
      lastSuccessAt: new Date("2026-09-14T07:36:00Z"),
      now: new Date("2026-09-20T12:00:00Z"),
    });

    expect(freshness).toMatchObject({ verdict: "on-time", late: false });
    expect(freshness.dueAt).toEqual(new Date("2026-09-14T07:30:00Z"));
  });

  it("reports a weekly Source that missed the Monday it was due", () => {
    const freshness = judge({
      crons: [WEEKLY_MONDAY],
      lastSuccessAt: new Date("2026-09-07T07:36:00Z"),
      now: new Date("2026-09-20T12:00:00Z"),
    });

    expect(freshness).toMatchObject({ verdict: "late", late: true });
    expect(freshness.dueAt).toEqual(new Date("2026-09-14T07:30:00Z"));
  });
});

describe("what a reader is told", () => {
  const source = {
    name: "news",
    workflowPath: ".github/workflows/ingest-news.yml",
    crons: [DAILY],
  };

  it("matches one Source's issue on an exact title, and does not collide with a failed run's", () => {
    expect(lateSourceIssueTitle("news")).toBe(
      "Ingest Source has not run: news",
    );
    expect(lateSourceIssueTitle("news")).not.toContain("Ingest failure:");
  });

  it("says when it last succeeded and when it should have", () => {
    const line = describeLateSource({
      source,
      freshness: judge({
        lastSuccessAt: new Date("2026-09-13T08:24:00Z"),
        now: new Date("2026-09-17T15:00:00Z"),
      }),
      workflowState: "active",
      runsUrl: "https://example.test/runs",
    });

    expect(line).toContain("**news**");
    expect(line).toContain("should have run at 2026-09-17 08:20 UTC");
    expect(line).toContain(
      "last completed successfully at 2026-09-13 08:24 UTC",
    );
  });

  it("distinguishes a Source that has never run from one that stopped", () => {
    const line = describeLateSource({
      source,
      freshness: judge({
        lastSuccessAt: null,
        workflowCreatedAt: new Date("2026-09-01T00:00:00Z"),
        now: new Date("2026-09-17T15:00:00Z"),
      }),
      workflowState: "active",
      runsUrl: "https://example.test/runs",
    });

    expect(line).toContain("has never completed successfully");
    expect(line).not.toContain("last completed successfully at");
  });

  it("names a workflow GitHub has stopped scheduling", () => {
    const freshness = judge({
      lastSuccessAt: new Date("2026-09-13T08:24:00Z"),
      now: new Date("2026-09-17T15:00:00Z"),
    });

    expect(
      lateSourceIssueBody({
        source,
        freshness,
        workflowState: "disabled_inactivity",
        runsUrl: "https://example.test/runs",
      }),
    ).toContain("`disabled_inactivity`");

    expect(
      lateSourceIssueBody({
        source,
        freshness,
        workflowState: "active",
        runsUrl: "https://example.test/runs",
      }),
    ).not.toContain("is not being scheduled at all");
  });

  it("links the run history and admits what the check cannot see", () => {
    const body = lateSourceIssueBody({
      source,
      freshness: judge({
        lastSuccessAt: new Date("2026-09-13T08:24:00Z"),
        now: new Date("2026-09-17T15:00:00Z"),
      }),
      workflowState: "active",
      runsUrl: "https://example.test/runs",
    });

    expect(body).toContain("https://example.test/runs");
    expect(body).toContain("cannot detect its own absence");
  });
});
