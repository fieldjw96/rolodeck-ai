import { randomBytes } from "node:crypto";

import type { SupabaseClient, User } from "@supabase/supabase-js";

export type ProvisionedAccount = {
  id: string;
  email: string;
  /** Generated here and shown once; nothing stores it. */
  password: string;
  /** True when the address already had an account and only its password changed. */
  rotated: boolean;
};

const USAGE =
  "usage: npm run account:provision -- <email>\n" +
  "The password is generated and printed once; do not pass one.";

/**
 * The email to provision. Deliberately the only argument: a password passed on a command line
 * ends up in a shell history, and one read from the environment ends up in a file.
 */
export function parseProvisionArgs(argv: string[]): { email: string } {
  const positional = argv.filter((argument) => !argument.startsWith("-"));

  if (positional.length !== 1) {
    throw new Error(USAGE);
  }

  const email = positional[0]!;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`not an email address: ${email}\n${USAGE}`);
  }

  return { email };
}

/** 32 bytes of randomness in a form that survives a copy and paste out of a terminal. */
export function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

/** A page size large enough that one request answers it in practice, and a bound on the walk. */
const PER_PAGE = 200;
const PAGE_LIMIT = 50;

/**
 * The account for an address, or null. There is no "get user by email" in the Admin API, so
 * this walks the list — and stops with an error rather than guessing if the list is longer
 * than the walk, because guessing here means creating a second account for an address that
 * already has one.
 */
async function findByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | null> {
  const wanted = email.toLowerCase();

  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: PER_PAGE,
    });

    if (error !== null) {
      throw new Error(`could not read the account list: ${error.message}`);
    }

    const match = data.users.find(
      (user) => user.email?.toLowerCase() === wanted,
    );

    if (match !== undefined) {
      return match;
    }

    if (data.users.length < PER_PAGE) {
      return null;
    }
  }

  throw new Error(
    `more than ${String(PER_PAGE * PAGE_LIMIT)} accounts: cannot tell whether ${email} already has one`,
  );
}

/**
 * Creates the email-and-password account, or rotates its password if the address already has
 * one, using a client holding the secret key.
 *
 * This is no longer how people get in. Sign-up is open and arrives through Google SSO, which
 * never calls this (docs/adr/0020 and docs/adr/0021). What it is for is the one credential the
 * deploy smoke test signs in with: ADR 0013 forbids `SUPABASE_SECRET_KEY` in GitHub Actions,
 * so the workflow cannot generate a sign-in link and has to type a password, and something has
 * to create and rotate the account that password belongs to.
 *
 * It used to refuse outright if the project had any account at all, which was the single-player
 * rule enforced rather than described. With sign-up open that rule is gone, and the refusal
 * would now fire on the first stranger who signed in with Google — guarding a door nobody uses
 * and breaking a password rotation while it did.
 */
export async function provisionAccount(
  admin: SupabaseClient,
  email: string,
): Promise<ProvisionedAccount> {
  const password = generatePassword();
  const existing = await findByEmail(admin, email);

  if (existing !== null) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password,
    });

    if (error !== null) {
      throw new Error(`could not rotate the password: ${error.message}`);
    }

    return { id: existing.id, email, password, rotated: true };
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    // No inbox is watching this address: it belongs to the smoke test, not to a person.
    email_confirm: true,
  });

  if (error !== null || data.user === null) {
    throw new Error(
      `could not create the account: ${error?.message ?? "no user returned"}`,
    );
  }

  return { id: data.user.id, email, password, rotated: false };
}
