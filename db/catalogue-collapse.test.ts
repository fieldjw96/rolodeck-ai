// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  eventAttendances,
  events,
  newsItems,
  profiles,
  swipes,
} from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { SEEDED_PROVENANCE } from "./testing/seed-profiles";

/**
 * Migration `0013_shared_catalogue`'s first statement, which collapses the rows the old
 * owner-bearing keys kept apart. On a scratch database it runs against an empty table and
 * proves nothing, so this file runs it again, deliberately, over rows that do collide.
 *
 * The duplicates are arranged the only way they can be once the migration has run: by dropping
 * the new unique indexes first. That is the shape of a database mid-migration — the old key
 * gone, the new one not yet built — which is exactly when the statement runs for real.
 */

const MIGRATION_PATH = fileURLToPath(
  new URL("./migrations/0013_shared_catalogue.sql", import.meta.url),
);

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

let scratch: ScratchDb;
let collapse: string;

/** Two Company Profiles with the same `(source, name_key)`, oldest first. */
async function duplicatePair(): Promise<{ older: string; newer: string }> {
  const written = await scratch.db
    .insert(profiles)
    .values(
      [0, 1].map((index) => ({
        source: "yc",
        name: index === 0 ? "Sprocket" : "  SPROCKET  ",
        description: "Developer tooling for warehouse robotics.",
        sector: "hardware-robotics",
        stage: "seed",
        website: null,
        provenance: SEEDED_PROVENANCE,
        createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
      })),
    )
    .returning({ id: profiles.id });

  return { older: written[0]!.id, newer: written[1]!.id };
}

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(SOMEONE_ELSE);

  const sql = await readFile(MIGRATION_PATH, "utf8");
  collapse = sql.split("--> statement-breakpoint")[0]!;
}, 60_000);

afterAll(async () => {
  await scratch?.close();
});

beforeEach(async () => {
  await scratch.reset();
  await scratch.db.delete(events);
  await scratch.db.delete(profiles);
  // Mid-migration: the old key is gone and the new one is not built yet.
  await scratch.client.exec(
    'drop index if exists "profiles_source_name_key_idx"; drop index if exists "events_source_external_id_idx";',
  );
});

describe("collapsing the duplicates the old owner-bearing keys kept apart", () => {
  it("does nothing, and does not fail, when there are none", async () => {
    await expect(scratch.client.exec(collapse)).resolves.toBeDefined();

    expect(await scratch.db.select().from(profiles)).toEqual([]);
  });

  it("keeps the oldest of two Company Profiles that now share a key", async () => {
    const { older } = await duplicatePair();

    await scratch.client.exec(collapse);

    const rows = await scratch.db.select().from(profiles);
    expect(rows.map((row) => row.id)).toEqual([older]);
    // The survivor keeps its own spelling: the key is case- and whitespace-insensitive but
    // nothing here rewrites a name.
    expect(rows[0]?.name).toBe("Sprocket");
  });

  it("repoints each User's Keep at the Company Profile that survives", async () => {
    const { older, newer } = await duplicatePair();
    await scratch.db.insert(swipes).values([
      { userId: JACK, profileId: older, decision: "keep" },
      { userId: SOMEONE_ELSE, profileId: newer, decision: "pass" },
    ]);

    await scratch.client.exec(collapse);

    const rows = await scratch.db.select().from(swipes);
    expect(
      rows.map((row) => [row.userId, row.profileId, row.decision]).sort(),
    ).toEqual(
      [
        [JACK, older, "keep"],
        [SOMEONE_ELSE, older, "pass"],
      ].sort(),
    );
  });

  it("drops the losing Keep when the same User had swiped both", async () => {
    const { older, newer } = await duplicatePair();
    await scratch.db.insert(swipes).values([
      { userId: JACK, profileId: older, decision: "keep" },
      { userId: JACK, profileId: newer, decision: "pass" },
    ]);

    await scratch.client.exec(collapse);

    const rows = await scratch.db.select().from(swipes);
    expect(rows.map((row) => [row.profileId, row.decision])).toEqual([
      [older, "keep"],
    ]);
  });

  it("repoints an article, and drops the loser's copy of one already stored", async () => {
    const { older, newer } = await duplicatePair();
    await scratch.db.insert(newsItems).values([
      {
        profileId: older,
        title: "Both",
        description: null,
        url: "https://news.example/both",
        publishedAt: new Date("2026-09-01T12:00:00Z"),
        sourceName: "The Example Times",
        confidence: 0.9,
      },
      {
        profileId: newer,
        title: "Both, again",
        description: null,
        url: "https://news.example/both",
        publishedAt: new Date("2026-09-01T12:00:00Z"),
        sourceName: "The Example Times",
        confidence: 0.9,
      },
      {
        profileId: newer,
        title: "Only the loser had this",
        description: null,
        url: "https://news.example/only",
        publishedAt: new Date("2026-09-02T12:00:00Z"),
        sourceName: "The Example Times",
        confidence: 0.9,
      },
    ]);

    await scratch.client.exec(collapse);

    const rows = await scratch.db.select().from(newsItems);
    expect(rows.every((row) => row.profileId === older)).toBe(true);
    expect(rows.map((row) => row.title).sort()).toEqual([
      "Both",
      "Only the loser had this",
    ]);
  });

  it("keeps the oldest of two Events that now share a key, and repoints Attendance", async () => {
    const { older } = await duplicatePair();
    const written = await scratch.db
      .insert(events)
      .values(
        [0, 1].map((index) => ({
          source: "luma",
          externalId: "summit@example.com",
          name: `Sprocket Summit ${index}`,
          startDate: "2026-10-01",
          url: "https://example.com/summit",
          createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
        })),
      )
      .returning({ id: events.id });
    await scratch.db
      .insert(eventAttendances)
      .values({ eventId: written[1]!.id, profileId: older });

    await scratch.client.exec(collapse);

    expect(
      (await scratch.db.select().from(events)).map((row) => row.id),
    ).toEqual([written[0]!.id]);
    expect(await scratch.db.select().from(eventAttendances)).toEqual([
      { eventId: written[0]!.id, profileId: older },
    ]);
  });

  it("leaves rows the new keys do not collide on alone", async () => {
    const kept = await scratch.db
      .insert(profiles)
      .values([
        {
          source: "yc",
          name: "Sprocket",
          description: "A company.",
          sector: "other",
          stage: "seed",
          website: null,
          provenance: SEEDED_PROVENANCE,
        },
        {
          // Same company, a different Source: two rows by design, per docs/adr/0008.
          source: "show-hn",
          name: "Sprocket",
          description: "A company.",
          sector: "other",
          stage: "seed",
          website: null,
          provenance: SEEDED_PROVENANCE,
        },
      ])
      .returning({ id: profiles.id });

    await scratch.client.exec(collapse);

    expect(
      (await scratch.db.select().from(profiles)).map((row) => row.id).sort(),
    ).toEqual(kept.map((row) => row.id).sort());
  });
});
