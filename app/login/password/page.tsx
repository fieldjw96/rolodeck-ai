import type { Metadata } from "next";

import styles from "../page.module.css";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in with a password · Rolodeck AI",
  // Unlisted, so it should not be in an index either. This is not the access control — that is
  // Supabase Auth refusing a password it does not hold — only a matter of not advertising a
  // door nobody but the deploy smoke test is meant to use.
  robots: { index: false, follow: false },
};

type PasswordPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The email-and-password form, reachable only by typing the path. Public to the gate through
 * the `/login` prefix in `lib/auth/paths.ts`, so the public list itself still names only
 * `/login` and the OAuth callback. See docs/adr/0021 for why this path survives at all.
 */
export default async function PasswordLoginPage({
  searchParams,
}: PasswordPageProps) {
  const { error } = await searchParams;

  return (
    <main className={styles.main}>
      <LoginForm error={error} />
    </main>
  );
}
