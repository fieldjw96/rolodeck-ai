ALTER TABLE "profiles" ADD COLUMN "founders_sought_at" timestamp with time zone;--> statement-breakpoint
-- When the team-page enrichment last read a company's own site for its founders; null until it
-- has. Ingest records every attempt, including one `robots.txt` refused and one whose page named
-- nobody, so the role needs `UPDATE` on it. Hand-written, like 0009 and 0010: Drizzle does not
-- model grants, and a column gets no `UPDATE` for this role until a migration grants it. This
-- widens nothing else. See docs/adr/0013 and docs/adr/0016.
--
-- No backfill: every existing row starts as "never looked", which is true.
GRANT UPDATE ("founders_sought_at") ON "profiles" TO rolodeck_ingest;
