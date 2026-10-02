-- `user_profiles.area` becomes nullable, with no default, so that "not stated" is something a
-- saved row can say. See db/schema.ts for the reasoning and docs/adr/0011 for the rule it
-- protects: the Deck ranks by what a User stated, and a User who stated nothing gets it newest
-- first, unreordered.
--
-- `NOT NULL DEFAULT 'Bay Area'` made that impossible. Every row that existed claimed an area
-- whether its User had chosen one or not, so the first save of any preference switched on area
-- ranking at weight 1. db/deck.ts papered over it by scoring a *missing row* as `area: ''`,
-- which is why nothing looked wrong while there was one account that had set an area on
-- purpose, and why Ticket #191's onboarding screen broke it the moment it wrote a row for
-- somebody who had stated nothing.
--
-- Deliberately not a backfill. Existing rows keep 'Bay Area', because for them it is a stated
-- preference rather than a default nobody chose: this project's one account set it, and ADR
-- 0019's new Users have no row at all yet. Rewriting those to NULL would discard a real answer
-- to make the column tidy.
ALTER TABLE "user_profiles" ALTER COLUMN "area" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "area" DROP NOT NULL;
