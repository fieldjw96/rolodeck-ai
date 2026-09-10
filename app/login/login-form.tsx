import { signIn } from "./actions";
import { signInErrorMessage } from "./errors";
import styles from "./login-form.module.css";

/**
 * The whole of the unauthenticated surface. A plain form posting to a Server Action, with no
 * client component anywhere in it, so nothing on this page can reach for a Supabase client of
 * its own. There is deliberately no "create an account" link: see CLAUDE.md on V1.
 */
export function LoginForm({ error }: { error?: unknown }) {
  const message = signInErrorMessage(error);

  return (
    <form action={signIn} className={styles.form}>
      <p className={styles.wordmark}>Rolodeck AI</p>
      <h1 className={styles.title}>Sign in</h1>
      <p className={styles.subtitle}>
        Bay Area startups, one Profile at a time.
      </p>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="email">
          Email
        </label>
        <input
          className={styles.input}
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="password">
          Password
        </label>
        <input
          className={styles.input}
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      {message === undefined ? null : (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}

      <button className={styles.submit} type="submit">
        Sign in
      </button>
    </form>
  );
}
