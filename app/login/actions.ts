"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { HOME_PATH, LOGIN_PATH } from "../../lib/auth/paths";
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
  redirect(`${LOGIN_PATH}?error=${error}`);
}

/**
 * The only way into the app. There is no sign-up counterpart, by design: CLAUDE.md's V1 is
 * single-player, and the one account is provisioned by `scripts/provision-account.ts`.
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
