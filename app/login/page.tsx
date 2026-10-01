import type { Metadata } from "next";

import { GoogleSignIn } from "./google-sign-in";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Sign in · Rolodeck AI",
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The one page outside the `(app)` route group, and so the one page the gate advertises to an
 * unauthenticated request. The panel is a separate component so it can be rendered in a test
 * without a request to await.
 *
 * `?error=` is how the OAuth callback reports a round trip that did not finish; see
 * `app/auth/callback/route.ts`.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <main className={styles.main}>
      <GoogleSignIn error={error} />
    </main>
  );
}
