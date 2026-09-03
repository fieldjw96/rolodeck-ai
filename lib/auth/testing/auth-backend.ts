import { randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { startGoTrueStub } from "./gotrue-stub";

/**
 * A throwaway account, created for one test and deleted when it finishes. Nothing here is
 * read from the environment: the Ticket is explicit that tests must not lean on a fixed
 * account or a password someone set, because the one real account's rows are real data.
 */
export type ThrowawayUser = {
  id: string;
  email: string;
  password: string;
};

export type AuthBackend = {
  url: string;
  publishableKey: string;
  /** The secret-key client, for the tests that are about the Admin API itself. */
  admin: SupabaseClient;
  createUser: () => Promise<ThrowawayUser>;
  deleteUser: (id: string) => Promise<void>;
  close: () => Promise<void>;
};

/** A name/value cookie pair as both `@supabase/ssr` and `NextRequest` understand it. */
export type CookiePair = { name: string; value: string };

/**
 * Creates and removes throwaway users through the Supabase Admin API, authenticated with the
 * secret key. Identical code runs against the stub and against a real project — that is the
 * point of the abstraction, and the reason a green run offline means something.
 */
function adminApi(url: string, secretKey: string) {
  const client = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return {
    client,
    createUser: async (): Promise<ThrowawayUser> => {
      // `.invalid` is reserved by RFC 2606 and can never be a deliverable address, so a
      // confirmation email cannot escape to a real inbox even against a live project.
      const email = `rolodeck-test-${randomUUID()}@example.invalid`;
      const password = `pw-${randomUUID()}`;

      const { data, error } = await client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (error !== null || data.user === null) {
        throw new Error(
          `could not create a throwaway user: ${error?.message ?? "no user returned"}`,
        );
      }

      return { id: data.user.id, email, password };
    },
    deleteUser: async (id: string): Promise<void> => {
      const { error } = await client.auth.admin.deleteUser(id);

      if (error !== null) {
        throw new Error(
          `could not delete throwaway user ${id}: ${error.message}`,
        );
      }
    },
  };
}

export async function stubBackend(): Promise<AuthBackend> {
  const stub = await startGoTrueStub();
  const admin = adminApi(stub.url, stub.secretKey);

  return {
    url: stub.url,
    publishableKey: stub.publishableKey,
    admin: admin.client,
    createUser: admin.createUser,
    deleteUser: admin.deleteUser,
    close: stub.close,
  };
}

function liveCredentials(): {
  url: string;
  publishableKey: string;
  secretKey: string;
} | null {
  const url = process.env.SUPABASE_TEST_URL;
  const publishableKey = process.env.SUPABASE_TEST_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !publishableKey || !secretKey) {
    return null;
  }

  return { url, publishableKey, secretKey };
}

async function liveBackend(): Promise<AuthBackend> {
  const credentials = liveCredentials();

  if (credentials === null) {
    throw new Error("a live Supabase project is not configured");
  }

  const admin = adminApi(credentials.url, credentials.secretKey);

  return {
    url: credentials.url,
    publishableKey: credentials.publishableKey,
    admin: admin.client,
    createUser: admin.createUser,
    deleteUser: admin.deleteUser,
    close: async () => {},
  };
}

/**
 * The stub always, plus a real project whenever one is configured. CI has no Supabase project
 * — the app has never needed one to build — so the live case is opt-in through
 * `SUPABASE_TEST_URL`, `SUPABASE_TEST_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`, and running
 * with them set is how the stub's fidelity gets checked.
 */
export function authBackends(): {
  name: string;
  start: () => Promise<AuthBackend>;
}[] {
  const backends = [
    { name: "the in-process Supabase Auth stub", start: stubBackend },
  ];

  if (liveCredentials() !== null) {
    backends.push({ name: "a live Supabase project", start: liveBackend });
  }

  return backends;
}

/**
 * Signs the throwaway user in through `@supabase/ssr` and returns the cookies it wrote, which
 * is exactly what a browser would then send back. Building the cookies by hand instead would
 * only prove that the test knows the library's storage format.
 */
export async function signInForCookies(
  backend: AuthBackend,
  user: ThrowawayUser,
): Promise<CookiePair[]> {
  const jar = new Map<string, string>();

  const supabase = createServerClient(backend.url, backend.publishableKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          jar.set(name, value);
        }
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });

  if (error !== null) {
    throw new Error(`could not sign the throwaway user in: ${error.message}`);
  }

  return [...jar].map(([name, value]) => ({ name, value }));
}

/** Serialises a cookie jar into the `Cookie` header a request carries. */
export function cookieHeader(cookies: CookiePair[]): string {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}
