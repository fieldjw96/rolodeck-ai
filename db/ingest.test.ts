// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { persistProfiles, type ProfileCandidate } from "./ingest";
import type { ProfileInput } from "./profile-input";
import type { ProfileProvenance, ProvenancedField } from "./provenance";
import { profiles } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

/**
 * A source that read three fields off the page and worked the fourth out for itself, which is
 * the shape docs/adr/0007 describes and the shape one record carrying both kinds of
 * provenance actually looks like.
 */
const SCRAPED_EXCEPT_STAGE: ProfileProvenance = {
  name: "scraped",
  description: "scraped",
  sector: "scraped",
  stage: "enriched",
  website: "scraped",
  location: "scraped",
  founders: null,
  links: null,
};

const SPROCKET: ProfileInput = {
  name: "Sprocket",
  description: "Developer tooling for warehouse robotics.",
  sector: "hardware-robotics",
  stage: "seed",
  website: "https://sprocket.example",
};

/**
 * A candidate whose provenance stays consistent with its fields by construction, so a test
 * that varies the input does not have to remember to vary `provenance.website` alongside.
 */
function candidateFor(
  input: ProfileInput,
  provenance: ProfileProvenance = SCRAPED_EXCEPT_STAGE,
): ProfileCandidate {
  return {
    input,
    provenance: {
      ...provenance,
      website: input.website === undefined ? null : provenance.website,
      location: input.location === undefined ? null : provenance.location,
    },
  };
}

let scratch: ScratchDb;
const ownerIdBefore = process.env.ROLODECK_OWNER_ID;

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(SOMEONE_ELSE);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
  process.env.ROLODECK_OWNER_ID = ownerIdBefore;
});

beforeEach(async () => {
  process.env.ROLODECK_OWNER_ID = JACK;
  await scratch.reset();
  await scratch.db.delete(profiles);
});

describe("persistProfiles", () => {
  it("writes every accepted record, owned by the account named in the environment", async () => {
    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        candidateFor(SPROCKET),
        candidateFor({
          name: "Quiet Co",
          description: "Stealth, no site yet.",
          sector: "fintech",
          stage: "pre-seed",
        }),
      ],
    });

    expect(report).toEqual({
      inserted: 2,
      updated: 0,
      rejected: 0,
      rejections: [],
    });

    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.ownerId)).toEqual([JACK, JACK]);
    expect(rows.map((row) => row.source)).toEqual(["yc", "yc"]);
  });

  it("reads the owner id afresh rather than caching the first one it saw", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    process.env.ROLODECK_OWNER_ID = SOMEONE_ELSE;

    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        candidateFor({ ...SPROCKET, name: "Someone Else's Company" }),
      ],
    });

    const rows = await scratch.db.select().from(profiles);

    expect(
      Object.fromEntries(rows.map((row) => [row.name, row.ownerId])),
    ).toEqual({
      Sprocket: JACK,
      "Someone Else's Company": SOMEONE_ELSE,
    });
  });

  it("throws rather than writing invisible rows when the owner id is absent", async () => {
    delete process.env.ROLODECK_OWNER_ID;

    await expect(
      persistProfiles(scratch.db, {
        source: "yc",
        candidates: [candidateFor(SPROCKET)],
      }),
    ).rejects.toThrow(/ROLODECK_OWNER_ID/);

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
  });

  it("writes per-field provenance, both kinds on the one record", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    const [row] = await scratch.db.select().from(profiles);

    // SPROCKET states no location, so `candidateFor` nulls that one field out; every other
    // field keeps the mixed provenance the test is actually about.
    expect(row?.provenance).toEqual({
      ...SCRAPED_EXCEPT_STAGE,
      location: null,
      founders: null,
      links: null,
    });
    expect(row?.provenance.sector).toBe("scraped");
    expect(row?.provenance.stage).toBe("enriched");
  });

  it("stores a null website provenance for a Profile with no website", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        candidateFor({
          name: "Quiet Co",
          description: "Stealth, no site yet.",
          sector: "fintech",
          stage: "pre-seed",
        }),
      ],
    });

    const [row] = await scratch.db.select().from(profiles);

    expect(row?.website).toBeNull();
    expect(row?.provenance.website).toBeNull();
  });

  it("makes no network call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    try {
      await persistProfiles(scratch.db, {
        source: "yc",
        candidates: [candidateFor(SPROCKET)],
      });

      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("persistProfiles idempotency", () => {
  const batch = [
    candidateFor(SPROCKET),
    candidateFor({
      name: "Quiet Co",
      description: "Stealth, no site yet.",
      sector: "fintech",
      stage: "pre-seed",
    }),
  ];

  it("inserts nothing the second time the same batch is run", async () => {
    const first = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: batch,
    });
    const second = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: batch,
    });

    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);

    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(2);
  });

  it("updates the existing Profile in place, keeping its id and its place in the Deck", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    const [before] = await scratch.db.select().from(profiles);

    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        candidateFor(
          {
            ...SPROCKET,
            description: "Now says something else.",
            stage: "seed",
          },
          { ...SCRAPED_EXCEPT_STAGE, description: "jack" },
        ),
      ],
    });

    const [after] = await scratch.db.select().from(profiles);

    expect(after?.id).toBe(before?.id);
    expect(after?.createdAt).toEqual(before?.createdAt);
    expect(after?.description).toBe("Now says something else.");
    expect(after?.provenance.description).toBe("jack");
  });

  it("treats a name differing only in case or spacing as the same company", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor({ ...SPROCKET, name: "  SPROCKET  " })],
    });

    expect(report.inserted).toBe(0);
    expect(report.updated).toBe(1);

    const rows = await scratch.db.select().from(profiles);

    expect(rows).toHaveLength(1);
    // The key is insensitive to case and spacing; the row still keeps the latest spelling.
    expect(rows[0]?.name).toBe("  SPROCKET  ");
    expect(rows[0]?.nameKey).toBe("sprocket");
  });

  it("collapses a duplicate that arrives twice within one batch", async () => {
    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        candidateFor(SPROCKET),
        candidateFor({ ...SPROCKET, sector: "saas-enterprise" }),
      ],
    });

    expect(report.inserted).toBe(1);
    expect(report.updated).toBe(1);

    const rows = await scratch.db.select().from(profiles);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sector).toBe("saas-enterprise");
  });

  it("keeps the same company separate when two sources found it", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    const report = await persistProfiles(scratch.db, {
      source: "sec-form-d",
      candidates: [candidateFor(SPROCKET)],
    });

    expect(report.inserted).toBe(1);

    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.source).sort()).toEqual(["sec-form-d", "yc"]);
  });
});

describe("persistProfiles against a value a human put there", () => {
  const ALL_JACK: ProfileProvenance = {
    name: "jack",
    description: "jack",
    sector: "jack",
    stage: "jack",
    website: "jack",
    location: "jack",
    founders: null,
    links: null,
  };

  /** Sprocket as the next scrape finds it: it raised a round and describes itself anew. */
  const RAISED: ProfileInput = {
    ...SPROCKET,
    description: "Warehouse robotics, now with a Series A.",
    stage: "series-a",
    location: "San Francisco, CA",
  };

  /**
   * A hand correction as it lands in the table: one field's value and its provenance changed
   * together, by some means other than ingest. There is no edit flow (see the Ticket's Out of
   * Scope), so raw SQL is as faithful a stand-in as any.
   */
  async function correctByHand(
    name: string,
    field: ProvenancedField,
    value: string,
  ) {
    await scratch.client.query(
      `update profiles set ${field} = $1, provenance = jsonb_set(provenance, '{${field}}', '"jack"') where name = $2`,
      [value, name],
    );
  }

  async function onlyRow() {
    const rows = await scratch.db.select().from(profiles);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("updates a scraped field from the incoming scrape", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(RAISED)],
    });

    const row = await onlyRow();

    expect(row.stage).toBe("series-a");
    expect(row.description).toBe(RAISED.description);
    expect(row.location).toBe("San Francisco, CA");
    expect(row.provenance).toEqual(SCRAPED_EXCEPT_STAGE);
  });

  it("does not overwrite a jack field's value", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });
    await correctByHand("Sprocket", "sector", "saas-enterprise");

    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    const row = await onlyRow();

    expect(row.sector).toBe("saas-enterprise");
  });

  it("leaves a jack field's provenance reading jack afterwards", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });
    await correctByHand("Sprocket", "sector", "saas-enterprise");

    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    const row = await onlyRow();

    expect(row.provenance.sector).toBe("jack");
  });

  it("keeps the jack field and updates the rest on a row with a mix", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });
    await correctByHand("Sprocket", "sector", "saas-enterprise");

    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor({ ...RAISED, sector: "ai-ml" })],
    });

    const row = await onlyRow();

    expect(row).toMatchObject({
      name: "Sprocket",
      description: RAISED.description,
      sector: "saas-enterprise",
      stage: "series-a",
      website: SPROCKET.website,
      location: "San Francisco, CA",
    });
    expect(row.provenance).toEqual({
      ...SCRAPED_EXCEPT_STAGE,
      sector: "jack",
    });
  });

  it("keeps a jack website the scrape no longer states, with its provenance beside it", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });
    await correctByHand("Sprocket", "website", "https://sprocket.example/hand");

    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor({ ...RAISED, website: undefined })],
    });

    const row = await onlyRow();

    // The check constraint requires a website and its provenance to be null together; keeping
    // the pair, rather than one half of it, is what lets this statement satisfy it.
    expect(row.website).toBe("https://sprocket.example/hand");
    expect(row.provenance.website).toBe("jack");
    expect(row.location).toBe("San Francisco, CA");
    expect(row.provenance.location).toBe("scraped");
  });

  it("keeps a jack name's spelling although the scrape matched it on the key", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });
    await correctByHand("Sprocket", "name", "SPROCKET");

    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });

    expect(report.inserted).toBe(0);

    const row = await onlyRow();

    expect(row.name).toBe("SPROCKET");
    expect(row.provenance.name).toBe("jack");
  });

  it("counts a row whose every field is jack as updated, not inserted, and changes none of it", async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        candidateFor({ ...SPROCKET, location: "Oakland, CA" }, ALL_JACK),
      ],
    });

    const before = await onlyRow();

    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor({ ...RAISED, sector: "ai-ml" })],
    });

    expect(report).toEqual({
      inserted: 0,
      updated: 1,
      rejected: 0,
      rejections: [],
    });
    await expect(onlyRow()).resolves.toEqual(before);
  });

  it("still inserts nothing the second time the same batch is run over a jack field", async () => {
    const batch = [
      candidateFor(SPROCKET),
      candidateFor({
        name: "Quiet Co",
        description: "Stealth, no site yet.",
        sector: "fintech",
        stage: "pre-seed",
      }),
    ];

    const first = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: batch,
    });
    await correctByHand("Sprocket", "stage", "series-a");

    const second = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: batch,
    });

    expect(first).toMatchObject({ inserted: 2, updated: 0 });
    expect(second).toMatchObject({ inserted: 0, updated: 2 });

    const rows = await scratch.db.select().from(profiles);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.name === "Sprocket")?.stage).toBe("series-a");
  });
});

describe("persistProfiles rejections", () => {
  /** What a source that has changed shape produces: a record that is not a `ProfileInput`. */
  const malformed = (input: unknown): ProfileCandidate =>
    ({ input, provenance: SCRAPED_EXCEPT_STAGE }) as ProfileCandidate;

  it("rejects a record failing validation, names the field, and writes nothing for it", async () => {
    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        candidateFor(SPROCKET),
        malformed({ ...SPROCKET, sector: "" }),
      ],
    });

    expect(report.inserted).toBe(1);
    expect(report.rejected).toBe(1);
    expect(report.rejections.map((rejection) => rejection.field)).toEqual([
      "input.sector",
    ]);

    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.name)).toEqual(["Sprocket"]);
  });

  it("rejects a stage no Profile can be in", async () => {
    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [malformed({ ...SPROCKET, stage: "Series A" })],
    });

    expect(report.rejected).toBe(1);
    expect(report.rejections[0]?.field).toBe("input.stage");
    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
  });

  it("rejects a website left unattributed rather than letting the check constraint abort the batch", async () => {
    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [
        {
          input: SPROCKET,
          provenance: { ...SCRAPED_EXCEPT_STAGE, website: null },
        },
        candidateFor({ ...SPROCKET, name: "Second Co" }),
      ],
    });

    expect(report.rejections[0]?.field).toBe("provenance.website");
    expect(report.inserted).toBe(1);

    const rows = await scratch.db.select().from(profiles);
    expect(rows.map((row) => row.name)).toEqual(["Second Co"]);
  });

  it("carries the offending record back with the rejection", async () => {
    const bad = malformed({ ...SPROCKET, name: "   " });

    const report = await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [bad],
    });

    expect(report.rejections[0]?.raw).toBe(bad);
    expect(report.rejections[0]?.field).toBe("input.name");
  });

  it("throws on a source name that is not a slug, before writing anything", async () => {
    await expect(
      persistProfiles(scratch.db, {
        source: "Y Combinator",
        candidates: [candidateFor(SPROCKET)],
      }),
    ).rejects.toThrow();

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
  });
});

describe("persisted Profiles under row level security", () => {
  beforeEach(async () => {
    await persistProfiles(scratch.db, {
      source: "yc",
      candidates: [candidateFor(SPROCKET)],
    });
  });

  it("is readable by the account that owns it", async () => {
    await scratch.as("authenticated", JACK);

    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.name)).toEqual(["Sprocket"]);
  });

  it("is invisible to the anonymous role", async () => {
    await scratch.as("anon");

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
  });

  it("is invisible to a signed-in account that does not own it", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
  });

  it("refuses the write to the app's own role, so ingest stays the only writer", async () => {
    await scratch.as("authenticated", JACK);

    // No insert policy exists on `profiles`: the write path runs under the secret key, which
    // bypasses RLS, and nothing a browser session reaches may add a Profile.
    await expect(
      persistProfiles(scratch.db, {
        source: "yc",
        candidates: [candidateFor({ ...SPROCKET, name: "Smuggled In" })],
      }),
    ).rejects.toThrow();

    await scratch.reset();
    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.name)).toEqual(["Sprocket"]);
  });
});
