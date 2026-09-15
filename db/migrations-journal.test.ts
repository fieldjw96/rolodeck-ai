// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Ticket #149: drizzle-kit migrate applies only the journal entries whose `when` is later than
 * the last migration it applied. An entry that lands out of order, say from a branch generated
 * before another merged, is therefore never applied anywhere that already ran its successor,
 * and the deploy still reports success. Production would be missing a migration `main` has.
 */

const journalSchema = z.object({
  entries: z.array(
    z.object({
      idx: z.number().int(),
      when: z.number().int(),
      tag: z.string(),
    }),
  ),
});

const { entries } = journalSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("./migrations/meta/_journal.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
);

describe("the migrations journal", () => {
  it("has entries to check", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("gives every migration a strictly later `when` than the one before it", () => {
    for (const [i, entry] of entries.entries()) {
      const previous = entries[i - 1];
      if (previous === undefined) continue;
      expect(
        entry.when,
        `${entry.tag} must be later than ${previous.tag}, or drizzle never applies it`,
      ).toBeGreaterThan(previous.when);
    }
  });
});
