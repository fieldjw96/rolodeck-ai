-- Ingest may update the columns it writes, and never the two that say which row it is and whose.
-- See docs/adr/0013.
--
-- Hand-written, like the grants in 0008: Drizzle does not model grants. `UPDATE` on the whole
-- table let the role set `owner_id`, moving a row into another account, or `id`; its RLS policies
-- are `with check (true)`, so nothing else refused either. Revoking the table-wide grant revokes
-- any column grants with it, so the grants below are the whole of what remains. A column added
-- later gets no `UPDATE` for this role until a migration grants it.
REVOKE UPDATE ON "profiles", "news_items", "events", "event_attendances" FROM rolodeck_ingest;--> statement-breakpoint
GRANT UPDATE ("source", "name", "description", "sector", "stage", "website", "location", "provenance", "name_key", "created_at") ON "profiles" TO rolodeck_ingest;--> statement-breakpoint
GRANT UPDATE ("profile_id", "title", "description", "url", "published_at", "source_name", "confidence", "fetched_at") ON "news_items" TO rolodeck_ingest;--> statement-breakpoint
GRANT UPDATE ("source", "external_id", "name", "start_date", "end_date", "location", "url", "created_at") ON "events" TO rolodeck_ingest;--> statement-breakpoint
-- An Attendance has no `id` or `owner_id` to leave out: it is its two ends.
GRANT UPDATE ("event_id", "profile_id") ON "event_attendances" TO rolodeck_ingest;--> statement-breakpoint
-- `has_column_privilege` counts grants made to PUBLIC and inherited through membership, so this
-- refuses to finish on a database, the real project included, where the role can still set either
-- column some other way. It runs once, when this migration is applied; what keeps asking is
-- `db/testing/ingest-role-check.sql`, in the test suite.
DO $$
DECLARE
  movable text;
BEGIN
  SELECT string_agg(format('%I.%I', c.relname, a.attname), ', ' ORDER BY c.relname, a.attname)
  INTO movable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relname IN ('profiles', 'news_items', 'events', 'event_attendances')
    AND a.attname IN ('id', 'owner_id')
    AND has_column_privilege('rolodeck_ingest', c.oid, a.attnum, 'UPDATE');

  IF movable IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may not update a row''s id or owner, but can update %', movable;
  END IF;
END
$$;
