import "server-only";

import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "../supabase/server";
import { LOGIN_PATH } from "./paths";

/**
 * The signed-in user, or null. Read only from Server Components, Route Handlers and Server
 * Actions — `server-only` above is what makes importing this from a client component a build
 * error rather than a runtime surprise.
 */
export async function getSessionUser(): Promise<User | null> {
  const supabase = await createSupabaseServerClient();

  // `getUser()` asks Supabase Auth to revalidate the token. `getSession()` would hand back
  // whatever the cookie claimed, which a browser can write.
  const { data, error } = await supabase.auth.getUser();

  return error === null ? data.user : null;
}

/**
 * The authoritative check, run inside the gated segment itself. The Proxy already redirects
 * unauthenticated requests, but Next's own guidance is not to rely on it alone: a matcher
 * change or a Server Action moving between routes can silently remove that coverage, and
 * this cannot be routed around.
 */
export async function requireUser(): Promise<User> {
  const user = await getSessionUser();

  if (user === null) {
    redirect(LOGIN_PATH);
  }

  return user;
}
