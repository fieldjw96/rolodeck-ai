import { signIn } from "./actions";
import { signInErrorMessage } from "./errors";

/**
 * The whole of the unauthenticated surface. A plain form posting to a Server Action, with no
 * client component anywhere in it, so nothing on this page can reach for a Supabase client of
 * its own. There is deliberately no "create an account" link: see CLAUDE.md on V1.
 */
export function LoginForm({ error }: { error?: unknown }) {
  const message = signInErrorMessage(error);

  return (
    <form action={signIn}>
      <h1>Sign in</h1>

      <label htmlFor="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      {message === undefined ? null : <p role="alert">{message}</p>}

      <button type="submit">Sign in</button>
    </form>
  );
}
