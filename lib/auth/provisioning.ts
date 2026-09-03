import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

export type ProvisionedAccount = {
  id: string;
  email: string;
  /** Generated here and shown once; nothing stores it. */
  password: string;
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

/**
 * Creates the one account this app has, using a client holding the secret key.
 *
 * There is no sign-up flow on purpose: CLAUDE.md's V1 is single-player, and a self-service
 * route into a deployment meant to have exactly one user is a way in for everybody else.
 * Provisioning is an operator action instead, run from the server laptop where the secret key
 * already lives — the same trust boundary as the scraper's ingest path.
 */
export async function provisionSingleAccount(
  admin: SupabaseClient,
  email: string,
): Promise<ProvisionedAccount> {
  const existing = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });

  if (existing.error !== null) {
    throw new Error(
      `could not read the account list: ${existing.error.message}`,
    );
  }

  // The single-account rule, enforced rather than described. A second account would mean a
  // second `owner_id`, and RLS would then hide half the Deck from whoever signed in.
  const [first] = existing.data.users;
  if (first !== undefined) {
    throw new Error(
      `this project already has an account (${first.email ?? first.id}). ` +
        "Remove it in the Supabase dashboard first if you meant to replace it.",
    );
  }

  const password = generatePassword();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    // No inbox is watching this address, and nobody else can be signing up.
    email_confirm: true,
  });

  if (error !== null || data.user === null) {
    throw new Error(
      `could not create the account: ${error?.message ?? "no user returned"}`,
    );
  }

  return { id: data.user.id, email, password };
}
