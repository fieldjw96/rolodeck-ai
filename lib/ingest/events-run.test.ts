// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { EventInput } from "../../db/event-input";
import type { EventIngestReport } from "../../db/events";
import {
  describeFailedSources,
  eventsStatingAHost,
  failedSourceRejection,
  hostsStated,
  noEventsRejection,
  summariseEventSource,
} from "./events-run";

const event = (attendees: readonly string[]): EventInput => ({
  externalId: `https://luma.com/${attendees.join("-")}`,
  name: "Sprocket Summit",
  startDate: "2026-10-01",
  url: "https://luma.com/summit",
  attendees: [...attendees],
});

const report = (over: Partial<EventIngestReport> = {}): EventIngestReport => ({
  inserted: 0,
  updated: 0,
  rejected: 0,
  rejections: [],
  attendances: 0,
  ...over,
});

describe("counting what a Source stated", () => {
  it("counts the Events naming a host, not the hosts", () => {
    expect(eventsStatingAHost([event(["Sprocket", "Widget"]), event([])])).toBe(
      1,
    );
  });

  it("counts a host twice when two companies host one Event", () => {
    expect(hostsStated([event(["Sprocket", "Widget"]), event([])])).toBe(2);
  });
});

/**
 * The Ticket's own distinction: a calendar stating organizers nobody has Kept and a calendar
 * stating none at all both link zero attendances, and only one of them is broken.
 */
describe("summariseEventSource", () => {
  it("reports attendances for the one Source, never only a run total", () => {
    const summary = summariseEventSource({
      source: "luma-ai-events-sf",
      events: [event(["Conviva"]), event(["Flower Labs"]), event([])],
      rejections: [],
      report: report({ inserted: 3, attendances: 1 }),
    });

    expect(summary).toContain("luma-ai-events-sf: wrote 3 new Events");
    expect(summary).toContain("linking 1 attendances");
    expect(summary).toContain("2 of 3 Events state a hosting company");
    expect(summary).toContain("naming 2 in all");
  });

  it("says a Source stated hosts the Deck does not hold yet", () => {
    const summary = summariseEventSource({
      source: "luma-frontier-tower-sf",
      events: [event(["Frontier Tower SF"])],
      rejections: [],
      report: report({ inserted: 1 }),
    });

    expect(summary).toContain("none of them is a Company Profile in the Deck");
  });

  it("says a Source stated no host at all, which is the other failure", () => {
    const summary = summariseEventSource({
      source: "techmeme-events",
      events: [event([]), event([])],
      rejections: [],
      report: report({ updated: 2 }),
    });

    expect(summary).toContain("states no hosting company at all");
    expect(summary).not.toContain("Company Profile in the Deck");
  });

  it("says neither when the Source linked something", () => {
    const summary = summariseEventSource({
      source: "luma-bond-ai-sf",
      events: [event(["Wasmer"])],
      rejections: [],
      report: report({ inserted: 1, attendances: 1 }),
    });

    expect(summary).not.toContain("states no hosting company at all");
    expect(summary).not.toContain("Company Profile in the Deck");
  });

  it("prints the parse's rejections and the write's, both naming their field", () => {
    const summary = summariseEventSource({
      source: "luma-bond-ai-sf",
      events: [event(["Wasmer"])],
      rejections: [
        { field: "itemListElement.0.item.name", reason: "nope", raw: {} },
      ],
      report: report({
        inserted: 1,
        rejections: [{ field: "startDate", reason: "also nope", raw: {} }],
      }),
    });

    expect(summary).toContain("rejected on itemListElement.0.item.name: nope");
    expect(summary).toContain("rejected on startDate: also nope");
  });
});

describe("a Source that went quiet", () => {
  it("names the calendar that parsed cleanly and listed nothing", () => {
    const rejection = noEventsRejection(
      "luma-ai-events-sf",
      "https://luma.com/ai-sf",
    );

    expect(rejection.field).toBe("luma-ai-events-sf");
    expect(rejection.reason).toContain("listed no Events at all");
    expect(rejection.raw).toBe("https://luma.com/ai-sf");
  });

  it("names the calendar that threw, and carries the reason it gave", () => {
    const rejection = failedSourceRejection(
      "luma-svaihub",
      new Error("503 Service Unavailable"),
    );

    expect(rejection.field).toBe("luma-svaihub");
    expect(rejection.reason).toContain("503 Service Unavailable");
  });

  it("carries a reason for something thrown that was not an Error", () => {
    expect(
      failedSourceRejection("luma-svaihub", "just a string").reason,
    ).toContain("just a string");
  });

  it("names every Source that could not be read, and says the others ran", () => {
    const message = describeFailedSources([
      failedSourceRejection("luma-ai-events-sf", new Error("503")),
      failedSourceRejection("luma-frontier-tower-sf", new Error("timeout")),
    ]);

    expect(message).toContain("luma-ai-events-sf, luma-frontier-tower-sf");
    expect(message).toContain("The other Sources ran");
  });
});
