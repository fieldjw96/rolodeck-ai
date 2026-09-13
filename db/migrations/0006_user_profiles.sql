CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sectors" text[] DEFAULT '{}' NOT NULL,
	"stages" text[] DEFAULT '{}' NOT NULL,
	"area" text DEFAULT 'Bay Area' NOT NULL,
	"excluded_sectors" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "user_profiles_sectors_are_controlled" CHECK (sectors <@ array['ai-ml', 'developer-tools', 'data-infrastructure', 'saas-enterprise', 'fintech', 'health-bio', 'security', 'hardware-robotics', 'climate-energy', 'consumer-marketplace', 'vertical-saas', 'other']::text[]),
	CONSTRAINT "user_profiles_excluded_sectors_are_controlled" CHECK (excluded_sectors <@ array['ai-ml', 'developer-tools', 'data-infrastructure', 'saas-enterprise', 'fintech', 'health-bio', 'security', 'hardware-robotics', 'climate-energy', 'consumer-marketplace', 'vertical-saas', 'other']::text[]),
	CONSTRAINT "user_profiles_sectors_excluded_disjoint" CHECK (not ("user_profiles"."sectors" && "user_profiles"."excluded_sectors"))
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "user_profiles_select_own" ON "user_profiles" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "user_profiles"."user_id");--> statement-breakpoint
CREATE POLICY "user_profiles_insert_own" ON "user_profiles" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "user_profiles"."user_id");--> statement-breakpoint
CREATE POLICY "user_profiles_update_own" ON "user_profiles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "user_profiles"."user_id") WITH CHECK ((select auth.uid()) = "user_profiles"."user_id");