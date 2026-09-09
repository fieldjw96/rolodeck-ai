ALTER TABLE "profiles" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "name_key" text GENERATED ALWAYS AS (lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g')))) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_owner_id_source_name_key_idx" ON "profiles" USING btree ("owner_id","source","name_key");