ALTER TABLE "profiles" DROP CONSTRAINT "profiles_provenance_covers_every_field";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "founders" jsonb;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "links" jsonb;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_provenance_covers_every_field" CHECK (coalesce(
  provenance ->> 'name' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'description' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'sector' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'stage' in ('scraped', 'enriched', 'jack')
  and (website is null) = (provenance ->> 'website' is null)
  and (website is null or provenance ->> 'website' in ('scraped', 'enriched', 'jack'))
  and (location is null) = (provenance ->> 'location' is null)
  and (location is null or provenance ->> 'location' in ('scraped', 'enriched', 'jack'))
  and (founders is null) = (provenance ->> 'founders' is null)
  and (founders is null or provenance ->> 'founders' in ('scraped', 'enriched', 'jack'))
  and (links is null) = (provenance ->> 'links' is null)
  and (links is null or provenance ->> 'links' in ('scraped', 'enriched', 'jack'))
, false));--> statement-breakpoint
-- Ingest writes both columns, and re-ingest replaces them, so the role needs `UPDATE` on each.
-- Hand-written, like 0009: Drizzle does not model grants, and 0009 grants by column so that a
-- column added later gets no `UPDATE` for this role until a migration grants it. This is that
-- migration, for two more columns of a table the role already writes; it widens nothing else.
-- See docs/adr/0013.
--
-- No existing row is backfilled here. Both columns start null with no provenance, which the
-- constraint above accepts, and the next scheduled YC run fills them, because ingest is
-- idempotent on `(owner_id, source, name_key)`. See docs/adr/0008.
GRANT UPDATE ("founders", "links") ON "profiles" TO rolodeck_ingest;
