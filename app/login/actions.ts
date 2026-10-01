"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { HOME_PATH, PASSWORD_SIGN_IN_PATH } from "../../lib/auth/paths";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import type { SignInError } from "./errors";

/**
 * A form post is external input, so it is parsed rather than cast. `password` is only checked
 * for presence: Supabase owns the credential, and a rule here would buy nothing but a
 * different error message.
 */
const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

function failedWith(error: SignInError): never {
  redirect(`${PASSWORD_SIGN_IN_PATH}?error=${error}`);
}

/**
 * The unlisted way in. Google SSO is the front door (docs/adr/0021) and this path survives for
 * one caller: `.github/workflows/deploy.yml`'s smoke test, which has to sign in and cannot
 * generate a sign-in link, because that needs Supabase's secret key and ADR 0013 forbids that
 * key in GitHub Actions. Nothing on `/login` links here; `scripts/provision-account.ts` creates
 * and rotates the one account that uses it.
 */
export async function signIn(formData: FormData): Promise<never> {
  const credentials = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!credentials.success) {
    failedWith("incomplete");
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(credentials.data);

  if (error !== null) {
    failedWith("credentials");
  }

  // Supabase has written the session cookies onto this response; the gate takes it from here.
  redirect(HOME_PATH);
}
