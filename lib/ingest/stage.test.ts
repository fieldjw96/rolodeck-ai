// @vitest-environment node
import { describe, expect, it } from "vitest";

import { stageFromRoundName, stageFromTeamSize } from "./stage";

describe("stageFromTeamSize, the docs/adr/0007 proxy", () => {
  it.each([
    [7_000, "growth"],
    [500, "growth"],
    [499, "series-b-plus"],
    [100, "series-b-plus"],
    [25, "series-a"],
    [8, "seed"],
    [5, "seed"],
    [4, "pre-seed"],
    [1, "pre-seed"],
  ])("reads a team of %i as %s", (teamSize, stage) => {
    expect(stageFromTeamSize(teamSize)).toBe(stage);
  });

  it.each([[0], [-1], [null], [undefined], [Number.NaN]])(
    "yields no stage for %p, so the caller must reject rather than guess",
    (teamSize) => {
      expect(stageFromTeamSize(teamSize)).toBeUndefined();
    },
  );
});

describe("stageFromRoundName, the round a filing states", () => {
  it.each([
    [
      "Series Seed Preferred Stock and Common Stock issuable upon conversion",
      "seed",
    ],
    ["Series A Preferred Stock", "series-a"],
    ["Senior Series B Preferred Stock", "series-b-plus"],
    ["Series D-1 Preferred", "series-b-plus"],
    ["Pre-Seed convertible notes", "pre-seed"],
    ["pre seed round", "pre-seed"],
    ["Seed round", "seed"],
    ['Shares of Series A Preferred Stock ("Series A")', "series-a"],
  ])("reads %j as %s", (description, stage) => {
    expect(stageFromRoundName(description)).toBe(stage);
  });

  it("takes the most advanced round when a filing names more than one", () => {
    // A real Form D: one filing covering a parallel Seed and Series A offering. A company
    // selling Series A preferred is at Series A whatever else is in the same round.
    expect(
      stageFromRoundName(
        "Seed 3 + Series A Preferred Stock Parallel Equity Offering",
      ),
    ).toBe("series-a");
  });

  it("does not double-count the seed inside a pre-seed", () => {
    expect(stageFromRoundName("Pre-Seed")).toBe("pre-seed");
  });

  it.each([
    ["Simple Agreement for Future Equity (SAFE)", "an instrument, not a round"],
    ["Limited partnership interests", "a fund's units"],
    ["a Series of Equitybee cFund Master LLC", "a series of an entity"],
    ["Common Stock", "no round at all"],
    ["", "nothing"],
  ])("yields no stage for %j — %s", (description) => {
    expect(stageFromRoundName(description)).toBeUndefined();
  });

  it.each([[null], [undefined]])("yields no stage for %p", (description) => {
    expect(stageFromRoundName(description)).toBeUndefined();
  });
});
