import {
  parseProvisionArgs,
  provisionAccount,
} from "../lib/auth/provisioning";
import { createSupabaseAdminClient } from "../lib/supabase/admin";

/**
 * The operator entry point for `lib/auth/provisioning.ts`. Everything worth testing lives
 * there; this file is argv in, stdout out.
 *
 *     SUPABASE_SECRET_KEY=... npm run account:provision -- smoke@example.com
 *
 * Nobody signs up this way: that is Google SSO's job (docs/adr/0021). This creates, and later
 * rotates, the one email-and-password account the deploy smoke test signs in with.
 */
async function main(): Promise<void> {
  const { email } = parseProvisionArgs(process.argv.slice(2));
  const account = await provisionAccount(createSupabaseAdminClient(), email);

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
