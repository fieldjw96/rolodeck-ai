"use server";

import { redirect } from "next/navigation";

import { LOGIN_PATH } from "../../lib/auth/paths";
import { createSupabaseServerClient } from "../../lib/supabase/server";

/**
 * Ends the session and clears the auth cookies. A Server Action rather than a Route Handler
 * because it needs no URL of its own: one fewer path for the gate's matcher to cover.
 */
export async function signOut(): Promise<never> {
  const supabase = await createSupabaseServerClient();

  await supabase.auth.signOut();

  redirect(LOGIN_PATH);
}
