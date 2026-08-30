import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseProfileInput, profileInputSchema } from "./profile-input";

const VALID_INPUT = {
  name: "Sprocket",
  description: "Developer tooling for warehouse robotics.",
  sector: "Robotics",
  stage: "seed",
  website: "https://sprocket.example",
} as const;

const MALFORMED_PAYLOADS: ReadonlyArray<{
  description: string;
  payload: unknown;
  field: string;
}> = [
  {
    description: "a missing field",
    payload: (() => {
      const rest: Record<string, unknown> = { ...VALID_INPUT };
      delete rest.name;
      return rest;
    })(),
    field: "name",
  },
  {
    description: "a field of the wrong type",
    payload: { ...VALID_INPUT, sector: 123 },
    field: "sector",
  },
  {
    description: "an empty string",
    payload: { ...VALID_INPUT, description: "" },
    field: "description",
  },
  {
    description: "an invalid URL",
    payload: { ...VALID_INPUT, website: "not-a-url" },
    field: "website",
  },
  {
    description: "an invalid stage value",
    payload: { ...VALID_INPUT, stage: "unicorn" },
    field: "stage",
  },
];

describe("profileInputSchema", () => {
  it("parses a valid payload with no data loss", () => {
    expect(profileInputSchema.parse(VALID_INPUT)).toEqual(VALID_INPUT);
  });

  it("accepts a payload with no website", () => {
    const withoutWebsite: Record<string, unknown> = { ...VALID_INPUT };
    delete withoutWebsite.website;

    const parsed = profileInputSchema.parse(withoutWebsite);

    expect(parsed.website).toBeUndefined();
  });

  it.each(MALFORMED_PAYLOADS)(
    "rejects a payload with $description, naming the offending field",
    ({ payload, field }) => {
      const result = profileInputSchema.safeParse(payload);

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toBeInstanceOf(z.ZodError);
      expect(result.error.issues[0]?.path).toEqual([field]);
    },
  );
});

describe("parseProfileInput", () => {
  it("returns the parsed data for a valid payload", () => {
    const result = parseProfileInput(VALID_INPUT);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(VALID_INPUT);
  });

  it("wraps a schema failure into an IngestRejection naming the field, reason, and raw input", () => {
    const raw = { ...VALID_INPUT, stage: "unicorn" };

    const result = parseProfileInput(raw);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.rejection.field).toBe("stage");
    expect(typeof result.rejection.reason).toBe("string");
    expect(result.rejection.reason.length).toBeGreaterThan(0);
    expect(result.rejection.raw).toBe(raw);
  });
});
