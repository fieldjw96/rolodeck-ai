import {
  parseProvisionArgs,
  provisionSingleAccount,
} from "../lib/auth/provisioning";
import { createSupabaseAdminClient } from "../lib/supabase/admin";

/**
 * The operator entry point for `lib/auth/provisioning.ts`. Everything worth testing lives
 * there; this file is argv in, stdout out.
 *
 *     SUPABASE_SECRET_KEY=... npm run account:provision -- jack@example.com
 */
async function main(): Promise<void> {
  const { email } = parseProvisionArgs(process.argv.slice(2));
  const account = await provisionSingleAccount(
    createSupabaseAdminClient(),
    email,
  );

  console.log(`Created ${account.email} (${account.id}).`);
  console.log(`Password, shown once: ${account.password}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
