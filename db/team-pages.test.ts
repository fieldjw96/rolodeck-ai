// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { persistProfiles } from "./ingest";
import type { ProfileProvenance } from "./provenance";
import { profiles } from "./schema";
import {
  recordTeamPageResults,
  selectTeamPageCandidates,
  TEAM_PAGE_RETRY_AFTER_DAYS,
} from "./team-pages";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";

/**
 * The team-page enrichment's reads and writes, run as the ingest role against real Postgres, so
 * the column grant in migration 0011 and the provenance check constraint are both exercised.
 * See docs/adr/0016.
 */

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 8, 18, 12));

const PROVENANCE: ProfileProvenance = {
  name: "scraped",
  description: "scraped",
  sector: "scraped",
  stage: "enriched",
  website: "scraped",
  location: null,
  founders: null,
  links: null,
};

let scratch: ScratchDb;
const ownerIdBefore = process.env.ROLODECK_OWNER_ID;

type Arranged = {
  name: string;
  website?: string | null;
  founders?: { name: string }[];
  soughtAt?: Date;
  ownerId?: string;
  createdAt?: Date;
};

/** Arranged as the superuser, which bypasses RLS: a test's fixtures are not under test. */
async function profile({
  name,
  website = `https://${name.toLowerCase()}.dev`,
  founders,
  soughtAt,
  ownerId = JACK,
  createdAt = new Date(NOW.getTime() - 100 * DAY),
}: Arranged): Promise<string> {
  await scratch.reset();
  const [row] = await scratch.db
    .insert(profiles)
    .values({
      ownerId,
      source: "angelpad",
      name,
      description: `${name}, for the team-page tests.`,
      sector: "developer-tools",
      stage: "seed",
      website,
      founders: founders ?? null,
      foundersSoughtAt: soughtAt ?? null,
      createdAt,
      provenance: {
        ...PROVENANCE,
        website: website === null ? null : "scraped",
        founders: founders === undefined ? null : "scraped",
      },
    })
    .returning({ id: profiles.id });
  return row!.id;
}

async function read(id: string) {
  await scratch.reset();
  const [row] = await scratch.db
    .select()
    .from(profiles)
    .where(eq(profiles.id, id));
  return row!;
}

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(SOMEONE_ELSE);
});

afterAll(async () => {
  process.env.ROLODECK_OWNER_ID = ownerIdBefore;
  await scratch.close();
});

beforeEach(async () => {
  await scratch.reset();
  await scratch.db.delete(profiles);
});

describe("selectTeamPageCandidates", () => {
  it("takes Profiles with a website and no founders, never-read first, then oldest attempt", async () => {
    const recent = await profile({ name: "Recent", soughtAt: new Date(NOW.getTime() - 40 * DAY) });
    const oldest = await profile({ name: "Oldest", soughtAt: new Date(NOW.getTime() - 90 * DAY) });
    const never = await profile({ name: "Never" });
    await profile({ name: "Stated", founders: [{ name: "Ada Lovelace" }] });
    await profile({ name: "Siteless", website: null });
    await profile({ name: "Theirs", ownerId: SOMEONE_ELSE });

    await scratch.as("rolodeck_ingest");
    const candidates = await selectTeamPageCandidates(scratch.db, {
      ownerId: JACK,
      limit: 10,
      now: NOW,
    });

    expect(candidates.map((candidate) => candidate.profileId)).toEqual([
      never,
      oldest,
      recent,
    ]);
  });

  it(`leaves a site read within ${TEAM_PAGE_RETRY_AFTER_DAYS} days alone, and stops at the bound`, async () => {
    await profile({ name: "Yesterday", soughtAt: new Date(NOW.getTime() - DAY) });
    await profile({ name: "A" });
    await profile({ name: "B" });

    await scratch.as("rolodeck_ingest");
    const candidates = await selectTeamPageCandidates(scratch.db, {
      ownerId: JACK,
      limit: 1,
      now: NOW,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).not.toBe("Yesterday");
  });
});

describe("recordTeamPageResults", () => {
  it("writes founders attributed enriched, and records the attempt, as the ingest role", async () => {
    const id = await profile({ name: "Acme" });

    await scratch.as("rolodeck_ingest");
    const { updated } = await recordTeamPageResults(scratch.db, {
      ownerId: JACK,
      results: [{ profileId: id, founders: [{ name: "Joachim Lohse", role: "CEO & Founder" }] }],
      at: NOW,
    });

    const row = await read(id);
    expect(updated).toBe(1);
    expect(row.founders).toEqual([{ name: "Joachim Lohse", role: "CEO & Founder" }]);
    expect(row.provenance.founders).toBe("enriched");
    expect(row.provenance.name).toBe("scraped");
    expect(row.foundersSoughtAt).toEqual(NOW);
  });

  it("records an attempt that found nobody, so 'looked' differs from 'never looked'", async () => {
    const looked = await profile({ name: "Looked" });
    const never = await profile({ name: "Never" });

    await scratch.as("rolodeck_ingest");
    const { updated } = await recordTeamPageResults(scratch.db, {
      ownerId: JACK,
      results: [{ profileId: looked, founders: null }],
      at: NOW,
    });

    expect(updated).toBe(0);
    expect(await read(looked)).toMatchObject({ founders: null, foundersSoughtAt: NOW });
    expect(await read(never)).toMatchObject({ founders: null, foundersSoughtAt: null });
  });

  it("never touches a Profile that already states founders, whatever the page said", async () => {
    const id = await profile({ name: "Stated", founders: [{ name: "Ada Lovelace" }] });

    await scratch.as("rolodeck_ingest");
    const { updated } = await recordTeamPageResults(scratch.db, {
      ownerId: JACK,
      results: [{ profileId: id, founders: [{ name: "Someone Else" }] }],
      at: NOW,
    });

    const row = await read(id);
    expect(updated).toBe(0);
    expect(row.founders).toEqual([{ name: "Ada Lovelace" }]);
    expect(row.provenance.founders).toBe("scraped");
    expect(row.foundersSoughtAt).toBeNull();
  });

  it("never touches another owner's Profile", async () => {
    const id = await profile({ name: "Theirs", ownerId: SOMEONE_ELSE });

    await scratch.as("rolodeck_ingest");
    await recordTeamPageResults(scratch.db, {
      ownerId: JACK,
      results: [{ profileId: id, founders: [{ name: "Joachim Lohse" }] }],
      at: NOW,
    });

    expect(await read(id)).toMatchObject({ founders: null, foundersSoughtAt: null });
  });
});

describe("a Source re-ingesting a Profile the enrichment filled", () => {
  const candidate = (founders?: { name: string }[]) => ({
    input: {
      name: "Acme",
      description: "Acme, for the team-page tests.",
      sector: "developer-tools" as const,
      stage: "seed" as const,
      website: "https://acme.dev",
      ...(founders === undefined ? {} : { founders }),
    },
    provenance: {
      ...PROVENANCE,
      founders: founders === undefined ? null : ("scraped" as const),
    },
  });

  it("keeps the enriched founders when the Source still states none", async () => {
    const id = await profile({ name: "Acme", website: "https://acme.dev" });
    await scratch.as("rolodeck_ingest");
    await recordTeamPageResults(scratch.db, {
      ownerId: JACK,
      results: [{ profileId: id, founders: [{ name: "Joachim Lohse" }] }],
      at: NOW,
    });

    process.env.ROLODECK_OWNER_ID = JACK;
    await persistProfiles(scratch.db, { source: "angelpad", candidates: [candidate()] });

    const row = await read(id);
    expect(row.founders).toEqual([{ name: "Joachim Lohse" }]);
    expect(row.provenance.founders).toBe("enriched");
  });

  it("replaces them when the Source states a team of its own", async () => {
    const id = await profile({ name: "Acme", website: "https://acme.dev" });
    await scratch.as("rolodeck_ingest");
    await recordTeamPageResults(scratch.db, {
      ownerId: JACK,
      results: [{ profileId: id, founders: [{ name: "Joachim Lohse" }] }],
      at: NOW,
    });

    process.env.ROLODECK_OWNER_ID = JACK;
    await persistProfiles(scratch.db, {
      source: "angelpad",
      candidates: [candidate([{ name: "Ada Lovelace" }])],
    });

    const row = await read(id);
    expect(row.founders).toEqual([{ name: "Ada Lovelace" }]);
    expect(row.provenance.founders).toBe("scraped");
  });
});
