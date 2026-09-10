import type { Metadata } from "next";

import { LoginForm } from "./login-form";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Sign in · Rolodeck AI",
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The one page outside the `(app)` route group, and so the one page the gate lets an
 * unauthenticated request reach. The form itself is a separate component so it can be
 * rendered in a test without a request to await.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <main className={styles.main}>
      <LoginForm error={error} />
    </main>
  );
}
