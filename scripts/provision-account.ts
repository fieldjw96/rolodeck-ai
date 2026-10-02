import { getDb } from "../db/connection";
import { asUser } from "../db/rls";
import { ensureUserProfile } from "../db/user-profile";
import { parseProvisionArgs, provisionAccount } from "../lib/auth/provisioning";
import { createSupabaseAdminClient } from "../lib/supabase/admin";

/**
 * The operator entry point for `lib/auth/provisioning.ts`. Everything worth testing lives
 * there; this file is argv in, stdout out.
 *
 *     SUPABASE_SECRET_KEY=... DATABASE_URL=... npm run account:provision -- smoke@example.com
 *
 * Nobody signs up this way: that is Google SSO's job (docs/adr/0021). This creates, and later
 * rotates, the one email-and-password account the deploy smoke test signs in with.
 *
 * It also writes that account's `user_profiles` row, empty, the moment it is created —
 * `ensureUserProfile` through `asUser()`, the same RLS-scoped write every other query in this
 * codebase makes. Without it the account reads as never having been asked about Sectors, and
 * `app/(app)/layout.tsx`'s first-run gate sends the deploy smoke test to `/onboarding` instead
 * of `/deck`, which is the whole failure Ticket #207 exists to close.
 */
async function main(): Promise<void> {
  const { email } = parseProvisionArgs(process.argv.slice(2));
  const account = await provisionAccount(createSupabaseAdminClient(), email);

  await asUser(getDb(), account.id, (tx) => ensureUserProfile(tx, account.id));

  console.log(
    account.rotated
      ? `Rotated the password for ${account.email} (${account.id}).`
      : `Created ${account.email} (${account.id}).`,
  );
  console.log(`Password, shown once: ${account.password}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
