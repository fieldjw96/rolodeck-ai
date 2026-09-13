import { afterEach, describe, expect, it, vi } from "vitest";

import { SECTOR_VALUES } from "../../db/profile-input";
import { sectorFromRawText } from "./sector";

type LogLine = { event: string; raw: string; [key: string]: unknown };

function loggedLine(logSpy: ReturnType<typeof vi.spyOn>, at = 0): LogLine {
  return JSON.parse(logSpy.mock.calls[at]![0] as string) as LogLine;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sectorFromRawText", () => {
  it.each([
    ["Artificial Intelligence", "ai-ml"],
    ["Banking as a Service", "fintech"],
    ["Robotics", "hardware-robotics"],
    ["HR Technology", "vertical-saas"],
    ["Retailing", "consumer-marketplace"],
  ] as const)("maps %s onto %s", (raw, sector) => {
    expect(sectorFromRawText(raw)).toBe(sector);
  });

  it("matches case- and whitespace-insensitively", () => {
    expect(sectorFromRawText("  fintech  ")).toBe("fintech");
    expect(sectorFromRawText("FINTECH")).toBe("fintech");
  });

  it("only ever returns one of the twelve controlled values", () => {
    for (const raw of [
      "Artificial Intelligence",
      "Underwater Basket Weaving",
    ]) {
      expect(SECTOR_VALUES).toContain(sectorFromRawText(raw));
    }
  });

  it("falls back to other for text the lookup table does not cover", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(sectorFromRawText("Underwater Basket Weaving")).toBe("other");

    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("maps the explicit Nonprofit entry to other too", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(sectorFromRawText("Nonprofit")).toBe("other");

    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("logs a structured line carrying the raw text whenever a value lands on other", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    sectorFromRawText("Underwater Basket Weaving");

    const line = loggedLine(logSpy);

    expect(line.event).toBe("sector_mapped_to_other");
    expect(line.raw).toBe("Underwater Basket Weaving");
  });

  it("does not log when a raw value maps onto a real sector", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    sectorFromRawText("Fintech");

    expect(logSpy).not.toHaveBeenCalled();
  });
});
