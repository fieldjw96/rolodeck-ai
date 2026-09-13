CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"source_name" text NOT NULL,
	"confidence" double precision NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_items_confidence_is_a_proportion" CHECK (confidence >= 0 and confidence <= 1),
	CONSTRAINT "news_items_url_is_http" CHECK (url ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "news_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_items_profile_id_url_idx" ON "news_items" USING btree ("profile_id","url");--> statement-breakpoint
CREATE INDEX "news_items_owner_id_published_at_idx" ON "news_items" USING btree ("owner_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "news_items_select_own" ON "news_items" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "news_items"."owner_id");