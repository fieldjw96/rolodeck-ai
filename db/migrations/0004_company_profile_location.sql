ALTER TABLE "profiles" DROP CONSTRAINT "profiles_provenance_covers_every_field";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "location" text;--> statement-breakpoint
-- `[^.]+` would stop at the first literal period, truncating a city such as "St. Helena" (a
-- Bay Area city per lib/location/bay-area.ts) mid-word and writing a wrong value with
-- `scraped` provenance — exactly the invented location ADR 0002 and this Ticket forbid.
-- Every row this backfill touches passed the sec-form-d CALIFORNIA filter, so `where` always
-- ends in the literal state code; anchoring the lazy capture there finds the sentence's real
-- end regardless of periods inside the city name.
UPDATE "profiles"
SET "location" = substring(description from ' issuer in (.+?, CA|CA)\.'),
    "provenance" = jsonb_set("provenance", '{location}', '"scraped"')
WHERE "source" = 'sec-form-d'
  AND description ~ ' issuer in (.+?, CA|CA)\.';
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
