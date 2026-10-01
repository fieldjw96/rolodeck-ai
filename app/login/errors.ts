/**
 * The reasons sign-in can fail, as far as the browser is told.
 *
 * Two vocabularies, because there are two doors and they fail differently. `/login` runs the
 * Google round trip and can only report on that; `/login/password` is the unlisted credential
 * the deploy smoke test uses (docs/adr/0021) and reports on a form.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export async functions.
 */

/**
 * A wrong password and an unknown email are both `credentials`: distinguishing them would
 * confirm to a stranger which addresses have an account.
 */
export const SIGN_IN_ERRORS = {
  incomplete: "Enter an email address and a password.",
  credentials: "That email and password did not match an account.",
} as const;

export type SignInError = keyof typeof SIGN_IN_ERRORS;

/**
 * The ways the OAuth round trip can end up back here. They are deliberately distinguishable:
 * "you cancelled", "Google sent us nothing to exchange" and "the exchange was refused" are
 * three different things to be told, and the alternative — a blank page, a 500, or an opaque
 * Next error digest — tells a beta user nothing and tells Jack nothing either.
 */
export const OAUTH_ERRORS = {
  /** Google said no, or the person pressed Cancel on the consent screen. */
  declined: "Google did not complete that sign-in. You can try again.",
  /** Came back with neither a code nor an error: not a round trip we can finish. */
  "no-code": "Google sent no sign-in code back. You can try again.",
  /** There was a code and Supabase refused it: expired, replayed, or not ours. */
  exchange: "That Google sign-in could not be completed. You can try again.",
  /** We could not even start: Supabase Auth is unreachable or misconfigured. */
  unavailable:
    "Sign in with Google is unavailable right now. Try again shortly.",
} as const;

export type OAuthError = keyof typeof OAUTH_ERRORS;

/**
 * The message for an `?error=` value off the URL, which anyone can type. An unrecognised one
 * falls back rather than rendering the raw value back at the page.
 */
function messageFor<Key extends string>(
  messages: Record<Key, string>,
  fallback: Key,
  error: unknown,
): string | undefined {
  if (typeof error !== "string") {
    return undefined;
  }

  return error in messages ? messages[error as Key] : messages[fallback];
}

export function signInErrorMessage(error: unknown): string | undefined {
  return messageFor(SIGN_IN_ERRORS, "credentials", error);
}

export function oauthErrorMessage(error: unknown): string | undefined {
  return messageFor(OAUTH_ERRORS, "declined", error);
}
