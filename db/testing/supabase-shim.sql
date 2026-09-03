-- The parts of a Supabase database that our migrations and RLS policies depend on, for
-- scratch Postgres instances that do not have them: the CI service container and the
-- in-process Postgres the integration tests run against.
--
-- This file is never applied to a real Supabase project, which already provides all of it.
-- It exists so that "does the policy actually deny anon?" is a question TypeScript can
-- answer, per CLAUDE.md's rule that RLS is a backstop and authorisation stays testable.

-- Supabase's API roles. Neither can log in; PostgREST reaches them with SET ROLE, which is
-- also how the integration tests reach them.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

create schema if not exists auth;

-- Only the column `profiles.owner_id` references. The app's auth gate is tested separately,
-- against an in-process Supabase Auth stub (see docs/adr/0004); these tests only need an
-- auth.users row to exist so the foreign key and the RLS policy have something to match on.
create table if not exists auth.users (
  id uuid primary key
);

-- Supabase's own definition, copied so the policy under test reads the claim the same way
-- in tests as it does in production.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- Supabase grants the API roles table privileges by default, so RLS — not a missing GRANT
-- — is what has to keep anon out. Granting them here is what makes the anon test honest:
-- without it, anon would fail with "permission denied" and the policy would go untested.
grant usage on schema public to anon, authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;
