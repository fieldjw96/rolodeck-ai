-- The app's own Postgres role, `rolodeck_app`: the one `DATABASE_URL` logs in as. See
-- docs/adr/0005, which asked for exactly this, and docs/adr/0014, which kept the migration
-- credential separate so that this narrowing would not break migrations.
--
-- Hand-written in full. Drizzle models policies, not roles or grants, and nothing about this
-- role is a policy: what matters is its attributes, the one role it belongs to, and that it
-- holds no grant of its own. The last statement refuses to let the migration finish if the
-- role that results is any broader — the same shape 0008_ingest_role.sql uses.
--
-- What it may do: log in, and `SET ROLE authenticated`, which is what `asUser()` in db/rls.ts
-- does for the length of every transaction the app runs. As `authenticated`, with
-- `request.jwt.claims` naming the signed-in user, it reads and writes exactly what the
-- policies in db/schema.ts permit that user — no more than Supabase's own PostgREST would.
--
-- What it may not do: anything else at all. It is NOBYPASSRLS and NOSUPERUSER, so no policy is
-- optional for it, and it is NOINHERIT, so it does not hold `authenticated`'s table privileges
-- while it is itself — a query that forgets `asUser()` is refused by Postgres rather than
-- quietly answered. It owns nothing, so it is nobody's table owner (an owner is exempt from
-- its own table's policies). It holds no grant on `swipes`, `profiles`, `user_profiles`,
-- `auth.users` or anything else, cannot create roles, databases, schemas or tables, cannot
-- replicate, and is a member of no role but `authenticated` — so `postgres`, `service_role`
-- and `rolodeck_ingest` are all out of its reach.
--
-- It is not ingest's role and must not grow into it: ingest writes rows owned by the account
-- rather than by itself and bypasses RLS on four tables to do it, which is `rolodeck_ingest`,
-- a separate login with separate grants. See docs/adr/0013.

-- Guarded because a role belongs to the whole cluster rather than to one database, so a scratch
-- cluster that has migrated some other database already has it — as does the in-process
-- Postgres the tests run against, whose Supabase shim creates it up front for that reason.
-- Whatever it was before, the check at the end decides whether it is acceptable. No password:
-- this file is committed, and Jack sets one by hand, per docs/deploying.md.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rolodeck_app') THEN
    CREATE ROLE rolodeck_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
-- The one privilege the role has, and the only one it needs: membership of `authenticated`,
-- which `set local role authenticated` spends. Written without `WITH INHERIT FALSE`, which is
-- Postgres 16 syntax and would fail on a 15 project: on 15 the membership inherits nothing
-- because the role is NOINHERIT, and on 16 and later the grant's own inherit option defaults
-- from that same attribute. The check below asserts the result rather than the spelling.
GRANT authenticated TO rolodeck_app;--> statement-breakpoint
-- The role must be exactly what this file says, on whatever database it runs against —
-- including the real Supabase project, where the tests never run.
DO $$
DECLARE
  app_role oid := (SELECT oid FROM pg_roles WHERE rolname = 'rolodeck_app');
  broader text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE oid = app_role
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'rolodeck_app may not be a superuser, create roles or databases, replicate, bypass RLS, or inherit the privileges of the roles it belongs to';
  END IF;

  -- `authenticated` and nothing else. A member can SET ROLE into whatever it belongs to, so a
  -- second membership would be a second identity this one connection string can assume.
  SELECT string_agg(roleid::regrole::text, ', ' ORDER BY roleid::regrole::text)
  INTO broader
  FROM pg_auth_members
  WHERE member = app_role
    AND (roleid <> 'authenticated'::regrole OR admin_option);

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_app may belong to authenticated and to nothing else, and may not administer it, but holds %', broader;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = app_role AND roleid = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'rolodeck_app must be a member of authenticated, or every query the app makes fails';
  END IF;

  -- No grant of its own, anywhere: on a table, a column, a sequence, a schema or a function.
  -- `aclexplode` on each catalogue's ACL, rather than `has_*_privilege`, because the question
  -- here is what was granted to this role by name. What it may actually reach is the next
  -- check, which is the one that matters and the one a grant to PUBLIC would also show up in.
  SELECT string_agg(DISTINCT what, ', ' ORDER BY what)
  INTO broader
  FROM (
    SELECT format('%I.%I', n.nspname, c.relname) AS what
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE a.grantee = app_role
    UNION ALL
    SELECT format('%I.%I.%I', n.nspname, c.relname, at.attname)
      FROM pg_attribute at
      JOIN pg_class c ON c.oid = at.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE a.grantee = app_role
    UNION ALL
    SELECT format('schema %I', n.nspname)
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(n.nspacl) a
     WHERE a.grantee = app_role
    UNION ALL
    SELECT p.oid::regprocedure::text
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee = app_role
  ) AS granted;

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_app may hold no grant of its own, because every query it makes runs as authenticated, but has been granted %', broader;
  END IF;

  -- The whole point of the role, asserted as the privilege check Postgres itself would make.
  -- NOINHERIT is what makes this false while the role is itself, and no spelling of the
  -- membership above can change it without this failing. `swipes` because it is the table
  -- whose rows are one account's and nobody else's; `auth.users` because it is the one that
  -- names them.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
  INTO broader
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE (n.nspname, c.relname) IN (('public', 'swipes'), ('public', 'profiles'), ('public', 'user_profiles'), ('auth', 'users'))
    AND (
      has_table_privilege(app_role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_any_column_privilege(app_role, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
    );

  IF broader IS NOT NULL THEN
    RAISE EXCEPTION 'rolodeck_app must reach no table except by becoming authenticated first, but can reach %', broader;
  END IF;
END
$$;
