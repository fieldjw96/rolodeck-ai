// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ProfileProvenance } from "./provenance";
import { profiles } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

/** One provenance value per field, all four fields different, so a swap cannot pass. */
const MIXED_PROVENANCE: ProfileProvenance = {
  name: "jack",
  description: "enriched",
  sector: "scraped",
  stage: "scraped",
  website: "enriched",
  location: null,
  founders: null,
  links: null,
};

let scratch: ScratchDb;

/**
 * The name of the constraint a write violated, or undefined if it was accepted. Drizzle
 * wraps driver errors, so the constraint name lives on the cause rather than the message.
 */
async function constraintViolatedBy(
  write: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await write;
    return undefined;
  } catch (error) {
    return (error as { cause?: { constraint?: string } }).cause?.constraint;
  }
}

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(SOMEONE_ELSE);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
});

beforeEach(async () => {
  await scratch.reset();
  await scratch.db.delete(profiles);
});

describe("profiles provenance", () => {
  it("writes a row with mixed provenance per field and reads it back exactly", async () => {
    const [written] = await scratch.db
      .insert(profiles)
      .values({
        ownerId: JACK,
        source: "test",
        name: "Sprocket",
        description: "Developer tooling for warehouse robotics.",
        sector: "hardware-robotics",
        stage: "Seed",
        website: "https://sprocket.example",
        provenance: MIXED_PROVENANCE,
      })
      .returning();

    expect(written).toBeDefined();

    const [read] = await scratch.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, written!.id));

    expect(read?.provenance).toEqual(MIXED_PROVENANCE);
    expect(read?.name).toBe("Sprocket");
    expect(read?.website).toBe("https://sprocket.example");
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("stores a null provenance for a Profile with no website", async () => {
    const [written] = await scratch.db
      .insert(profiles)
      .values({
        ownerId: JACK,
        source: "test",
        name: "Quiet Co",
        description: "Stealth, no site yet.",
        sector: "other",
        stage: "Pre-seed",
        website: null,
        provenance: { ...MIXED_PROVENANCE, website: null },
      })
      .returning();

    expect(written?.website).toBeNull();
    expect(written?.provenance.website).toBeNull();
  });

  it("stores a null provenance for a Profile whose location is unknown, and still satisfies the constraint", async () => {
    const [written] = await scratch.db
      .insert(profiles)
      .values({
        ownerId: JACK,
        source: "test",
        name: "Nowhere Co",
        description: "No location stated by its Source.",
        sector: "other",
        stage: "Pre-seed",
        website: null,
        location: null,
        provenance: { ...MIXED_PROVENANCE, website: null, location: null },
      })
      .returning();

    expect(written?.location).toBeNull();
    expect(written?.provenance.location).toBeNull();
  });

  it("rejects a Profile field left without provenance", async () => {
    const missingSector: Partial<ProfileProvenance> = { ...MIXED_PROVENANCE };
    delete missingSector.sector;

    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ownerId: JACK,
        source: "test",
        name: "Sprocket",
        description: "Developer tooling for warehouse robotics.",
        sector: "hardware-robotics",
        stage: "Seed",
        website: "https://sprocket.example",
        provenance: missingSector as ProfileProvenance,
      }),
    );

    expect(violated).toBe("profiles_provenance_covers_every_field");
  });

  it("rejects an unknown provenance value", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ownerId: JACK,
        source: "test",
        name: "Sprocket",
        description: "Developer tooling for warehouse robotics.",
        sector: "hardware-robotics",
        stage: "Seed",
        website: "https://sprocket.example",
        provenance: {
          ...MIXED_PROVENANCE,
          sector: "guessed",
        } as unknown as ProfileProvenance,
      }),
    );

    expect(violated).toBe("profiles_provenance_covers_every_field");
  });

  it("rejects provenance for a website the Profile does not have", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ownerId: JACK,
        source: "test",
        name: "Quiet Co",
        description: "Stealth, no site yet.",
        sector: "other",
        stage: "Pre-seed",
        website: null,
        provenance: MIXED_PROVENANCE,
      }),
    );

    expect(violated).toBe("profiles_provenance_covers_every_field");
  });

  it("rejects a website left unattributed", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ownerId: JACK,
        source: "test",
        name: "Sprocket",
        description: "Developer tooling for warehouse robotics.",
        sector: "hardware-robotics",
        stage: "Seed",
        website: "https://sprocket.example",
        provenance: { ...MIXED_PROVENANCE, website: null },
      }),
    );

    expect(violated).toBe("profiles_provenance_covers_every_field");
  });

  it("rejects a location left unattributed", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ownerId: JACK,
        source: "test",
        name: "Sprocket",
        description: "Developer tooling for warehouse robotics.",
        sector: "hardware-robotics",
        stage: "Seed",
        location: "Oakland, CA",
        provenance: { ...MIXED_PROVENANCE, location: null },
      }),
    );

    expect(violated).toBe("profiles_provenance_covers_every_field");
  });

  it("rejects a Profile owned by nobody in auth.users", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ownerId: "33333333-3333-3333-3333-333333333333",
        source: "test",
        name: "Orphan",
        description: "No owner.",
        sector: "hardware-robotics",
        stage: "Seed",
        website: null,
        provenance: { ...MIXED_PROVENANCE, website: null },
      }),
    );

    expect(violated).toBe("profiles_owner_id_users_id_fk");
  });

  it("rejects a sector off the controlled list, even from the service-role ingest path", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ownerId: JACK,
        source: "test",
        name: "Sprocket",
        description: "Developer tooling for warehouse robotics.",
        sector: "Robotics",
        stage: "Seed",
        website: "https://sprocket.example",
        provenance: MIXED_PROVENANCE,
      }),
    );

    expect(violated).toBe("profiles_sector_is_controlled");
  });
});

describe("profiles row level security", () => {
  beforeEach(async () => {
    await scratch.db.insert(profiles).values([
      {
        ownerId: JACK,
        source: "test",
        name: "Sprocket",
        description: "Developer tooling for warehouse robotics.",
        sector: "hardware-robotics",
        stage: "Seed",
        website: "https://sprocket.example",
        provenance: MIXED_PROVENANCE,
      },
      {
        ownerId: SOMEONE_ELSE,
        source: "test",
        name: "Not Jack's",
        description: "Belongs to another account.",
        sector: "fintech",
        stage: "Series A",
        website: null,
        provenance: { ...MIXED_PROVENANCE, website: null },
      },
    ]);
  });

  it("is enabled on the profiles table", async () => {
    const { rows } = await scratch.client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.profiles'::regclass",
    );

    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  it("returns zero rows to the anonymous role", async () => {
    await scratch.as("anon");

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
  });

  it("returns only the signed-in user's own Profiles", async () => {
    await scratch.as("authenticated", JACK);

    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.name)).toEqual(["Sprocket"]);
    expect(rows[0]?.ownerId).toBe(JACK);
  });

  it("hides a Profile from an authenticated user who does not own it", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.name)).toEqual(["Not Jack's"]);
  });
});

describe("profiles founders and links", () => {
  const SPROCKET = {
    ownerId: JACK,
    source: "test",
    name: "Sprocket",
    description: "Developer tooling for warehouse robotics.",
    sector: "hardware-robotics",
    stage: "seed",
    website: "https://sprocket.example",
  };

  it("stores both as stated, each attributed", async () => {
    const [written] = await scratch.db
      .insert(profiles)
      .values({
        ...SPROCKET,
        founders: [{ name: "Ada Example", bio: "Retired" }],
        links: { github: "https://github.com/sprocket" },
        provenance: {
          ...MIXED_PROVENANCE,
          founders: "scraped",
          links: "scraped",
        },
      })
      .returning();

    expect(written?.founders).toEqual([
      { name: "Ada Example", bio: "Retired" },
    ]);
    expect(written?.links).toEqual({ github: "https://github.com/sprocket" });
  });

  it("rejects founders stated with no provenance to attribute them", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ...SPROCKET,
        founders: [{ name: "Ada Example" }],
        provenance: MIXED_PROVENANCE,
      }),
    );

    expect(violated).toBe("profiles_provenance_covers_every_field");
  });

  it("rejects provenance for links nobody stated", async () => {
    const violated = await constraintViolatedBy(
      scratch.db.insert(profiles).values({
        ...SPROCKET,
        provenance: { ...MIXED_PROVENANCE, links: "scraped" },
      }),
    );

    expect(violated).toBe("profiles_provenance_covers_every_field");
  });

  it("still accepts a row written before either existed, which the migration does not backfill", async () => {
    // A row from before migration 0010 has neither column set nor either key in its provenance.
    const before: Partial<ProfileProvenance> = { ...MIXED_PROVENANCE };
    delete before.founders;
    delete before.links;

    const [written] = await scratch.db
      .insert(profiles)
      .values({
        ...SPROCKET,
        provenance: before as ProfileProvenance,
      })
      .returning();

    expect(written?.founders).toBeNull();
    expect(written?.links).toBeNull();
  });
});
