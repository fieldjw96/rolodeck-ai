CREATE TABLE "event_attendances" (
	"event_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	CONSTRAINT "event_attendances_event_id_profile_id_pk" PRIMARY KEY("event_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "event_attendances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"location" text,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_end_date_not_before_start_date" CHECK ("events"."end_date" is null or "events"."end_date" >= "events"."start_date")
);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_attendances" ADD CONSTRAINT "event_attendances_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendances" ADD CONSTRAINT "event_attendances_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_attendances_profile_id_idx" ON "event_attendances" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_owner_id_source_external_id_idx" ON "events" USING btree ("owner_id","source","external_id");--> statement-breakpoint
CREATE INDEX "events_owner_id_start_date_idx" ON "events" USING btree ("owner_id","start_date");--> statement-breakpoint
CREATE POLICY "event_attendances_select_own" ON "event_attendances" AS PERMISSIVE FOR SELECT TO "authenticated" USING (exists (select 1 from "events" where "events"."id" = "event_attendances"."event_id") and exists (select 1 from "profiles" where "profiles"."id" = "event_attendances"."profile_id"));--> statement-breakpoint
CREATE POLICY "events_select_own" ON "events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "events"."owner_id");