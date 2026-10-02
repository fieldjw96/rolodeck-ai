-- Every `auth.users` row created before Ticket #191 added the first-run screen has no
-- `user_profiles` row, which `lib/auth/onboarding.ts`'s `needsOnboarding` reads as "never
-- asked" — correct for a new User, wrong for the two accounts that predate the question
-- entirely: Jack's, and the smoke test's. Left alone, both are sent to `/onboarding` on their
-- next sign-in, which is what made the production smoke test fail on every deploy. See
-- Ticket #207.
--
-- The row this writes is `db/user-profile.ts`'s `EMPTY_USER_PROFILE` in SQL: every array
-- default and `area` left `NULL`. docs/adr/0011 ranks that identically to having no row at
-- all, so this changes what `needsOnboarding` sees and nothing about how the Deck is ordered.
--
-- `ON CONFLICT DO NOTHING` is what makes a second run write nothing: it mirrors
-- `db/user-profile.ts`'s `ensureUserProfile`, which this migration is the one-time, every-
-- account form of. `RAISE NOTICE` reports the count either way, so a run that backfills
-- nothing is a stated zero rather than a silent one.
DO $$
DECLARE
  backfilled bigint := 0;
BEGIN
  INSERT INTO "user_profiles" ("user_id")
  SELECT u.id
    FROM auth.users u
   WHERE NOT EXISTS (
     SELECT 1 FROM "user_profiles" p WHERE p."user_id" = u.id
   )
  ON CONFLICT ("user_id") DO NOTHING;
  GET DIAGNOSTICS backfilled = ROW_COUNT;

  RAISE NOTICE 'Backfilled % user_profiles row(s) for accounts with none.', backfilled;
END
$$;
