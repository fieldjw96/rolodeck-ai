CREATE TABLE "swipes" (
	"profile_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swipes_user_id_profile_id_pk" PRIMARY KEY("user_id","profile_id"),
	CONSTRAINT "swipes_decision_is_a_swipe" CHECK (decision in ('keep', 'pass'))
);
--> statement-breakpoint
ALTER TABLE "swipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profiles_owner_id_created_at_id_idx" ON "profiles" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "swipes_select_own" ON "swipes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "swipes"."user_id");--> statement-breakpoint
CREATE POLICY "swipes_insert_own" ON "swipes" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "swipes"."user_id" and exists (select 1 from "profiles" where "profiles"."id" = "swipes"."profile_id"));--> statement-breakpoint
CREATE POLICY "swipes_update_own" ON "swipes" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "swipes"."user_id") WITH CHECK ((select auth.uid()) = "swipes"."user_id" and exists (select 1 from "profiles" where "profiles"."id" = "swipes"."profile_id"));