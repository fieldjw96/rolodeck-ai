// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistEvents } from "./events";
import { persistNewsItems } from "./news";
import {
  eventAttendances,
  events,
  newsItems,
  profiles,
  swipes,
  userProfiles,
} from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { seedProfiles } from "./testing/seed-profiles";

/**
 * Reads widened to `authenticated` in docs/adr/0019. They did not widen to `anon`, and this is
 * the file that says so for every table rather than only the ones whose own test file happened
 * to check.
 *
 * `anon` is the role Supabase grants table privileges to by default, so a table whose policies
 * all name `authenticated` is a table `anon` can reach and match nothing in. That is the
 * backstop being asserted: every row below is really there, and the anonymous role reads none
 * of them, through the same `scratch.db` handle the rest of the suite reads through.
 */

const JACK = "11111111-1111-1111-1111-111111111111";

/** Every table in the schema, so a new one cannot be added without a line here. */
const TABLES = {
  profiles,
  swipes,
  user_profiles: userProfiles,
  news_items: newsItems,
  events,
  event_attendances: eventAttendances,
};

let scratch: ScratchDb;

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);

  const [profileId] = await seedProfiles(scratch.db, { count: 1 });

  await scratch.db
    .insert(swipes)
    .values({ userId: JACK, profileId: profileId!, decision: "keep" });
  await scratch.db.insert(userProfiles).values({ userId: JACK });
  await persistNewsItems(scratch.db, {
    candidates: [
      {
        profileId: profileId!,
        title: "Startup 0 raises a round",
        description: null,
        url: "https://news.example/startup-0",
        publishedAt: new Date("2026-09-01T12:00:00Z"),
        sourceName: "The Example Times",
        confidence: 0.9,
      },
    ],
  });
  await persistEvents(scratch.db, {
    source: "luma",
    events: [
      {
        externalId: "summit@example.com",
        name: "Sprocket Summit",
        startDate: "2026-10-01",
        url: "https://example.com/summit",
        attendees: ["Startup 0"],
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  await scratch?.close();
});

describe("the anonymous role", () => {
  it("has a row in every table to be refused, or the assertions below are vacuous", async () => {
    await scratch.reset();

    for (const [name, table] of Object.entries(TABLES)) {
      await expect(
        scratch.db.select().from(table),
        `${name} must hold a row for this file to prove anything`,
      ).resolves.not.toEqual([]);
    }
  });

  it.each(Object.keys(TABLES))("reads zero rows from %s", async (name) => {
    await scratch.as("anon");

    await expect(
      scratch.db.select().from(TABLES[name as keyof typeof TABLES]),
    ).resolves.toEqual([]);

    await scratch.reset();
  });
});
