import { sql } from "drizzle-orm";
import { z } from "zod";

import { readOwnerId } from "../lib/supabase/env";
import { issueField } from "../lib/zod/issues";
import type { Database } from "./connection";
import {
  profileInputSchema,
  type IngestRejection,
  type ProfileInput,
} from "./profile-input";
import { profileProvenanceSchema, type ProfileProvenance } from "./provenance";
import { profiles } from "./schema";

/**
 * The one write path into `profiles`. Every source — SEC filings, Show HN, an accelerator
 * page — parses its own HTML its own way and then arrives here, so that "owned by the one
 * account", "no duplicates", "per-field provenance" and "a bad record is counted, not
 * half-written" are decided once rather than re-argued per source.
 *
 * Nothing here fetches. It takes records; obtaining them is each source's own Ticket.
 */

/**
 * One record on its way in: the Profile's fields, and where each of them came from.
 *
 * Provenance is a parameter rather than something this module derives, because only the
 * source knows which of its fields it read and which its own pipeline computed. A YC page
 * states a company's `sector` and does not state its `stage`, so that record arrives with
 * `sector: "scraped"` and `stage: "enriched"` — both, on one record. See docs/adr/0003 and
 * docs/adr/0007.
 */
export type ProfileCandidate = {
  readonly input: ProfileInput;
  readonly provenance: ProfileProvenance;
};

/**
 * The same shape again, in Zod. The type above says a caller has already validated; this
 * checks it anyway, because per CLAUDE.md scraped data is hostile and this is the last
 * boundary before Postgres. A source that parses hostile JSON and casts, or that grows a bug
 * between its parser and its call to this function, is rejected here by field name rather
 * than reaching the table.
 */
const candidateSchema = z
  .strictObject({
    input: profileInputSchema,
    provenance: profileProvenanceSchema,
  })
  /**
   * `website` and `location` are the two optional Profile fields, so they are the two fields
   * whose provenance can be null — and each must be null exactly when there is no value to
   * attribute. The `profiles_provenance_covers_every_field` check constraint refuses the same
   * row underneath; catching it here is what turns a constraint violation that aborts a batch
   * into one rejection, named, that the rest of the batch survives.
   */
  .refine(
    (candidate) =>
      (candidate.input.website === undefined) ===
      (candidate.provenance.website === null),
    {
      error:
        "must be null exactly when the Profile has no website, and set when it has one",
      path: ["provenance", "website"],
    },
  )
  .refine(
    (candidate) =>
      (candidate.input.location === undefined) ===
      (candidate.provenance.location === null),
    {
      error:
        "must be null exactly when the Profile has no location, and set when it has one",
      path: ["provenance", "location"],
    },
  );

/**
 * Which pipeline is writing. Constrained to a lowercase slug so that `yc`, `YC` and `Yc`
 * cannot become three sources holding three copies of the same company — the name is half
 * the natural key, so its spelling is part of a row's identity.
 */
const sourceSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be a lowercase slug, like `sec-form-d`",
  );

/**
 * What a batch did. `inserted` and `updated` are counted separately because that difference
 * is the whole of the idempotency claim: a second run of the same batch reports zero inserted
 * and the same number updated.
 *
 * `rejections` names the field that stopped each record, so a source that has quietly changed
 * shape shows up as a rising count with a field attached rather than as a batch that happened
 * to write fewer Profiles than last time.
 */
export type IngestReport = {
  readonly inserted: number;
  readonly updated: number;
  readonly rejected: number;
  readonly rejections: readonly IngestRejection[];
};

/**
 * Writes a batch of candidates to `profiles`, owned by the single account, idempotently.
 *
 * Idempotent on `(owner_id, source, name_key)`: re-running a source updates the Profiles it
 * wrote before instead of dealing the Deck a second card for the same company. `created_at`
 * is deliberately left alone on update, so re-ingesting does not reshuffle a Deck that is
 * ordered newest first. See docs/adr/0008.
 *
 * The whole batch is one transaction: the counts a caller gets back describe the table it can
 * now read, rather than however far a partial run happened to get.
 *
 * Throws, rather than counting a rejection, when the source name or the owner id is wrong.
 * Neither is data from a scraped page; both are the caller's own configuration, and a run
 * that wrote every Profile to an owner nobody signs in as should stop, not report success.
 */
export async function persistProfiles(
  db: Database,
  {
    source,
    candidates,
  }: { source: string; candidates: Iterable<ProfileCandidate> },
): Promise<IngestReport> {
  const sourceName = sourceSchema.parse(source);
  const ownerId = readOwnerId();

  const accepted: ProfileCandidate[] = [];
  const rejections: IngestRejection[] = [];

  for (const candidate of candidates) {
    const parsed = candidateSchema.safeParse(candidate);

    if (parsed.success) {
      accepted.push(parsed.data);
    } else {
      // A failed safeParse always carries at least one issue.
      const issue = parsed.error.issues[0]!;
      rejections.push({
        field: issueField(issue),
        reason: issue.message,
        raw: candidate,
      });
    }
  }

  const { inserted, updated } = await db.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;

    // One statement per candidate rather than one multi-row insert. Two records in the same
    // batch can reduce to the same natural key, and Postgres refuses to let a single
    // `on conflict do update` touch the same row twice; written this way the second is simply
    // an update of the first, which is what "no duplicates" has to mean within a batch too.
    for (const candidate of accepted) {
      const [written] = await tx
        .insert(profiles)
        .values({
          ownerId,
          source: sourceName,
          name: candidate.input.name,
          description: candidate.input.description,
          sector: candidate.input.sector,
          stage: candidate.input.stage,
          website: candidate.input.website ?? null,
          location: candidate.input.location ?? null,
          provenance: candidate.provenance,
        })
        .onConflictDoUpdate({
          target: [profiles.ownerId, profiles.source, profiles.nameKey],
          set: {
            // The name too: the key is case- and whitespace-insensitive, so the row keeps
            // whatever spelling the source most recently used.
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            sector: sql`excluded.sector`,
            stage: sql`excluded.stage`,
            website: sql`excluded.website`,
            location: sql`excluded.location`,
            provenance: sql`excluded.provenance`,
          },
        })
        // Postgres's own answer to "was this row new?": `xmax` is zero on a freshly inserted
        // tuple and carries the updating transaction's id on one that `do update` replaced.
        // Asking the statement beats reading the table first and racing whatever ran between.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });

      if (written?.inserted === true) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    return { inserted, updated };
  });

  return {
    inserted,
    updated,
    rejected: rejections.length,
    rejections,
  };
}
