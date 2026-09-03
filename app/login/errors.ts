/**
 * The reasons sign-in can fail, as far as the browser is told. A wrong password and an
 * unknown email are both `credentials`: distinguishing them would confirm to a stranger which
 * addresses have an account, and there is exactly one.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export async functions.
 */
export const SIGN_IN_ERRORS = {
  incomplete: "Enter an email address and a password.",
  credentials: "That email and password did not match an account.",
} as const;

export type SignInError = keyof typeof SIGN_IN_ERRORS;

/**
 * The message for an `?error=` value off the URL, which anyone can type. An unrecognised one
 * falls back to the credentials message rather than rendering the raw value back at the page.
 */
export function signInErrorMessage(error: unknown): string | undefined {
  if (typeof error !== "string") {
    return undefined;
  }

  return error in SIGN_IN_ERRORS
    ? SIGN_IN_ERRORS[error as SignInError]
    : SIGN_IN_ERRORS.credentials;
}
