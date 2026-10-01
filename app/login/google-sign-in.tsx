import { GOOGLE_SIGN_IN_PATH } from "../../lib/auth/paths";
import { oauthErrorMessage } from "./errors";
import styles from "./panel.module.css";

/**
 * The whole of the advertised unauthenticated surface: one link to Google. Anyone may sign up,
 * and Google owns the credential — see docs/adr/0020 and docs/adr/0021. No client component
 * anywhere in it, so nothing on this page can reach for a Supabase client of its own.
 *
 * A plain anchor to a Route Handler, rather than a form posting to a Server Action, for two
 * reasons. ADR 0006's Content-Security-Policy carries `form-action 'self'`, which several
 * browsers enforce across the redirect a form submission is answered with — so a form that
 * answered with a redirect to Google would be blocked in them, and nowhere a diff or a unit
 * test could show it. And a link needs no JavaScript to work at all.
 *
 * `<a>` rather than `next/link`: `Link` prefetches on hover, and prefetching this would start
 * an OAuth round trip, and mint a PKCE verifier, for somebody who only moved the mouse.
 */
export function GoogleSignIn({ error }: { error?: unknown }) {
  const message = oauthErrorMessage(error);

  return (
    <div className={styles.panel}>
      <p className={styles.wordmark}>Rolodeck AI</p>
      <h1 className={styles.title}>Sign in</h1>
      <p className={styles.subtitle}>
        Bay Area startups, one Profile at a time.
      </p>

      {message === undefined ? null : (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}

      <a className={styles.submit} href={GOOGLE_SIGN_IN_PATH}>
        Sign in with Google
      </a>

      {/* What ADR 0020 decided, said plainly. Deliberately no claim about `berkeley.edu`
          specifically: ADR 0021 records that whether that Workspace restricts third-party
          apps is unverified, and a promise on this page is the wrong place to find out. */}
      <p className={styles.note}>Open to anyone with a Google account.</p>
    </div>
  );
}
