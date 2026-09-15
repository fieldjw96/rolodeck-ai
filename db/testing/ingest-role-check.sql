-- Whether `rolodeck_ingest` is any broader than the migrations make it. See docs/adr/0013.
--
-- Run by `db/ingest-role.test.ts` against a freshly migrated scratch Postgres, and nowhere else:
-- no migration runs it, and nothing runs it against the real project. So a migration that widens
-- the role fails CI, and a grant made by hand in the Supabase SQL editor is caught by nothing.
--
-- It looks at every schema that is not Postgres's own, not only the ones the app uses today: a
-- grant in a schema nobody thought to list is exactly the one nobody would notice. The
-- `has_*_privilege` functions count grants made to PUBLIC and inherited through membership, so it
-- also catches a right the role holds that nothing granted it by name.
DO $$
DECLARE
  ingest_role oid := (SELECT oid FROM pg_roles WHERE rolname = 'rolodeck_ingest');
  kept_profile_ids oid := to_regprocedure('ingest.kept_profile_ids(uuid)');
  broader text;
BEGIN
  IF ingest_role IS NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may not be missing: no migration created it';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE oid = ingest_role
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'rolodeck_ingest may not be a superuser, create roles or databases, replicate, or bypass RLS';
  END IF;

  -- A member inherits, or can SET ROLE into, whatever the role it belongs to may do.
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = ingest_role) THEN
    RAISE EXCEPTION 'rolodeck_ingest may not be a member of any other role';
  END IF;

  -- `pg_catalog`, `pg_toast` and the temporary schemas all begin `pg_`.
  SELECT string_agg(quote_ident(n.nspname), ', ' ORDER BY n.nspname)
  INTO broader
  FROM pg_namespace n
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%'
    AND (
      has_schema_privilege(ingest_role, n.oid, 'CREATE')
      OR (n.nspname NOT IN ('public', 'ingest') AND has_schema_privilege(ingest_role, n.oid, 'USAGE'))
    );

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may create in no schema and use only public and ingest, but holds more on %', broader;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
  INTO broader
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%'
    AND NOT (n.nspname = 'public' AND c.relname IN ('profiles', 'news_items', 'events', 'event_attendances'))
    AND (
      has_table_privilege(ingest_role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_any_column_privilege(ingest_role, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
    );

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may hold no privilege beyond its four tables, but can reach %', broader;
  END IF;

  -- None of its four tables takes its key from a sequence, so it needs none at all. The `case`
  -- because Postgres may evaluate the conditions in any order, and `has_sequence_privilege`
  -- raises on a relation that is not a sequence rather than returning false.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
  INTO broader
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'S'
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%'
    AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(ingest_role, c.oid, 'USAGE, SELECT, UPDATE') END;

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may hold no privilege on a sequence, but can reach %', broader;
  END IF;

  -- TRUNCATE is checked on its own tables too: unlike DELETE, it does not consult RLS at all.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO broader
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('profiles', 'news_items', 'events', 'event_attendances')
    AND (
      has_table_privilege(ingest_role, c.oid, 'TRUNCATE, REFERENCES, TRIGGER')
      OR (c.relname <> 'event_attendances' AND has_table_privilege(ingest_role, c.oid, 'DELETE'))
    );

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may only select, insert and update (and delete Attendance), but holds more on %', broader;
  END IF;

  -- Its RLS policies are `with check (true)`, so the column grant is all that stops an update
  -- moving a row into another account.
  SELECT string_agg(format('%I.%I', c.relname, a.attname), ', ' ORDER BY c.relname, a.attname)
  INTO broader
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relname IN ('profiles', 'news_items', 'events', 'event_attendances')
    AND a.attname IN ('id', 'owner_id')
    AND has_column_privilege(ingest_role, c.oid, a.attnum, 'UPDATE');

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may not update a row''s id or owner, but can update %', broader;
  END IF;

  -- Postgres makes every new function executable by PUBLIC, so this counts all of those. A
  -- SECURITY DEFINER function runs with its owner's rights, whoever calls it; any other runs with
  -- the caller's own, so it matters only where the role can reach it, which is a schema it may use.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
  INTO broader
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%'
    AND p.oid IS DISTINCT FROM kept_profile_ids
    AND has_function_privilege(ingest_role, p.oid, 'EXECUTE')
    AND (p.prosecdef OR has_schema_privilege(ingest_role, n.oid, 'USAGE'));

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_ingest may execute only ingest.kept_profile_ids, but can execute %', broader;
  END IF;
END
$$;
