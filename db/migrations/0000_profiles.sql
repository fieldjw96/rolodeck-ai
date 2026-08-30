CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"sector" text NOT NULL,
	"stage" text NOT NULL,
	"website" text,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_provenance_covers_every_field" CHECK (coalesce(
  provenance ->> 'name' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'description' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'sector' in ('scraped', 'enriched', 'jack')
  and provenance ->> 'stage' in ('scraped', 'enriched', 'jack')
  and (website is null) = (provenance ->> 'website' is null)
  and (website is null or provenance ->> 'website' in ('scraped', 'enriched', 'jack'))
, false))
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "profiles_select_own" ON "profiles" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "profiles"."owner_id");