ALTER TABLE "profiles" DROP CONSTRAINT "profiles_provenance_covers_every_field";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "location" text;--> statement-breakpoint
UPDATE "profiles"
SET "location" = substring(description from ' issuer in ([^.]+)\.'),
    "provenance" = jsonb_set("provenance", '{location}', '"scraped"')
WHERE "source" = 'sec-form-d'
  AND description ~ ' issuer in [^.]+\.';
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_provenance_covers_every_field" CHECK (coalesce(
  provenance ->> 'name' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'description' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'sector' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'stage' in ('scraped', 'enriched', 'jack')
  and (website is null) = (provenance ->> 'website' is null)
  and (website is null or provenance ->> 'website' in ('scraped', 'enriched', 'jack'))
  and (location is null) = (provenance ->> 'location' is null)
  and (location is null or provenance ->> 'location' in ('scraped', 'enriched', 'jack'))
, false));
