// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { IngestReport } from "../../db/ingest";
import {
  describeEmptySources,
  emptySources,
  type SourceRun,
} from "./multi-source-run";

const report = (over: Partial<IngestReport> = {}): IngestReport => ({
  inserted: 0,
  updated: 0,
  rejected: 0,
  rejections: [],
  ...over,
});

const run = (source: string, over: Partial<IngestReport> = {}): SourceRun => ({
  source,
  report: report(over),
});

/**
 * The Ticket's own words: a scraper whose selectors have gone stale returns zero rows and
 * reports success, and that must not hide behind another Source's healthy total.
 */
describe("emptySources", () => {
  it("names nothing when every Source wrote", () => {
    expect(
      emptySources([
        run("south-park-commons", { inserted: 12 }),
        run("angelpad", { updated: 4 }),
      ]),
    ).toEqual([]);
  });

  it("names the one Source that wrote zero, even though another wrote rows", () => {
    expect(
      emptySources([
        run("south-park-commons", { inserted: 30 }),
        run("angelpad", { inserted: 0, updated: 0 }),
      ]),
    ).toEqual(["angelpad"]);
  });

  it("names every Source when all of them wrote zero", () => {
    expect(emptySources([run("south-park-commons"), run("angelpad")])).toEqual([
      "south-park-commons",
      "angelpad",
    ]);
  });

  it("does not name a Source whose write was a healthy re-run, all updates and no inserts", () => {
    expect(emptySources([run("angelpad", { updated: 9 })])).toEqual([]);
  });
});

describe("describeEmptySources", () => {
  it("names the empty Source(s) on the first line", () => {
    const message = describeEmptySources(["angelpad"], "Profiles");

    expect(message.split("\n")[0]).toContain("angelpad");
  });

  it("names every empty Source when more than one wrote nothing", () => {
    const message = describeEmptySources(
      ["techmeme-events", "luma-bond-ai-sf"],
      "Events",
    );

    expect(message.split("\n")[0]).toContain("techmeme-events");
    expect(message.split("\n")[0]).toContain("luma-bond-ai-sf");
  });
});
