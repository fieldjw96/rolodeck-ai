import { sql } from "drizzle-orm";
import { z } from "zod";

import { readOwnerId } from "../lib/ingest/env";
import { issueField } from "../lib/zod/issues";
import type { Database } from "./connection";
import {
  profileInputSchema,
  type IngestRejection,
  type ProfileInput,
} from "./profile-input";
import {
  NULLABLE_FIELDS,
  PROVENANCED_FIELDS,
  profileProvenanceSchema,
  type ProfileProvenance,
  type Provenance,
  type ProvenancedField,
} from "./provenance";
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
   * The nullable Profile fields are the ones whose provenance can be null, and each must be
   * null exactly when there is no value to attribute. The `profiles_provenance_covers_every_field`
   * check constraint refuses the same row underneath; catching it here is what turns a
   * constraint violation that aborts a batch into one rejection, named, that the rest of the
   * batch survives.
   */
  .superRefine((candidate, context) => {
    for (const field of NULLABLE_FIELDS) {
      if (
        (candidate.input[field] === undefined) !==
        (candidate.provenance[field] === null)
      ) {
        context.addIssue({
          code: "custom",
          message: `must be null exactly when the Profile has no ${field}, and set when it has one`,
          path: ["provenance", field],
        });
      }
    }
  });

/**
 * Which pipeline is writing. Constrained to a lowercase slug so that `yc`, `YC` and `Yc`
 * cannot become three sources holding three copies of the same company — the name is half
 * the natural key, so its spelling is part of a row's identity. Shared with `persistEvents`,
 * whose Events carry the same Source slugs.
 */
export const sourceSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be a lowercase slug, like `sec-form-d`",
  );

/**
 * The Provenance a scrape may never overwrite. Every other value is the default re-ingest
 * rule working as intended: a company that raised a round should stop reading `pre-seed`.
 */
const HUMAN: Provenance = "jack";

/** Whether the stored row's `field` is one a human put there. Reads the row being replaced. */
const isHuman = (field: ProvenancedField) =>
  `profiles.provenance ->> '${field}' = '${HUMAN}'`;

/**
 * A column's `on conflict` value: the incoming scrape's, unless the stored value is `jack`.
 *
 * Decided in the statement rather than by reading the row first, so two ingest Runs on one
 * company cannot both read "scraped" and then race to overwrite a correction that landed
 * between; docs/adr/0008's idempotency claim rests on Postgres doing the deciding. A stored
 * provenance that is null or absent compares as NULL, which `case` treats as not `jack`.
 */
const scrapedUnlessHuman = (field: ProvenancedField) =>
  sql.raw(
    `case when ${isHuman(field)} then profiles.${field} else excluded.${field} end`,
  );

/**
 * `provenance` is one jsonb column holding every field's entry, so it is rebuilt field by
 * field with the same rule rather than replaced: each entry travels with the value it
 * describes, which keeps `profiles_provenance_covers_every_field` true whichever side won.
 * Built from `PROVENANCED_FIELDS` so a field added there cannot be silently dropped here.
 */
const provenanceUnlessHuman = sql.raw(
  `jsonb_build_object(${PROVENANCED_FIELDS.map(
    (field) =>
      `'${field}', case when ${isHuman(field)} then profiles.provenance -> '${field}' else excluded.provenance -> '${field}' end`,
  ).join(", ")})`,
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
          founders: candidate.input.founders ?? null,
          links: candidate.input.links ?? null,
          provenance: candidate.provenance,
        })
        .onConflictDoUpdate({
          target: [profiles.ownerId, profiles.source, profiles.nameKey],
          set: {
            // The name too: the key is case- and whitespace-insensitive, so the row keeps
            // whatever spelling the source most recently used — unless a human chose it.
            name: scrapedUnlessHuman("name"),
            description: scrapedUnlessHuman("description"),
            sector: scrapedUnlessHuman("sector"),
            stage: scrapedUnlessHuman("stage"),
            website: scrapedUnlessHuman("website"),
            location: scrapedUnlessHuman("location"),
            // Replaced whole, never appended to or merged: a re-ingest states the team as the
            // Source now states it, so a founder the page dropped is dropped here too.
            founders: scrapedUnlessHuman("founders"),
            links: scrapedUnlessHuman("links"),
            provenance: provenanceUnlessHuman,
          },
        })
        // Postgres's own answer to "was this row new?": `xmax` is zero on a freshly inserted
        // tuple and carries the updating transaction's id on one that `do update` replaced.
        // Asking the statement beats reading the table first and racing whatever ran between.
        // `do update` writes a new tuple even when every field was kept, so a row whose
        // fields are all `jack` still counts as updated: it existed, and nothing was inserted.
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
