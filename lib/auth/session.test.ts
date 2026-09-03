// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getSessionUser, requireUser } from "./session";
import {
  signInForCookies,
  stubBackend,
  type AuthBackend,
  type CookiePair,
  type ThrowawayUser,
} from "./testing/auth-backend";

/**
 * A cookie store shaped like the one `next/headers` returns. The session module is only ever
 * reached from a request, so the store is what stands in for the request here; swapping it
 * between tests is how one file covers "signed in" and "signed out".
 */
let cookieStore: CookiePair[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => cookieStore,
    // Server Components cannot write cookies, and Next throws when they try. Throwing here
    // too is what proves `createSupabaseServerClient` swallows it rather than failing a render.
    set: () => {
      throw new Error(
        "Cookies can only be modified in a Server Action or Route Handler",
      );
    },
  }),
}));

let backend: AuthBackend;
let user: ThrowawayUser;

beforeAll(async () => {
  backend = await stubBackend();

  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", backend.url);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", backend.publishableKey);

  user = await backend.createUser();
}, 30_000);

afterAll(async () => {
  await backend.deleteUser(user.id);
  await backend.close();
  vi.unstubAllEnvs();
});

describe("reading the session from a server component", () => {
  it("returns the signed-in user", async () => {
    cookieStore = await signInForCookies(backend, user);

    await expect(getSessionUser()).resolves.toMatchObject({
      id: user.id,
      email: user.email,
    });
  });

  it("returns null when the request carries no session", async () => {
    cookieStore = [];

    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("returns null rather than throwing when the cookie is not a session at all", async () => {
    cookieStore = [{ name: "sb-127-auth-token", value: "not-a-session" }];

    await expect(getSessionUser()).resolves.toBeNull();
  });
});

describe("requireUser", () => {
  it("hands back the user when there is one", async () => {
    cookieStore = await signInForCookies(backend, user);

    await expect(requireUser()).resolves.toMatchObject({ id: user.id });
  });

  it("redirects to /login when there is not", async () => {
    cookieStore = [];

    // `redirect()` works by throwing; the digest is how Next recognises it downstream.
    await expect(requireUser()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    await expect(requireUser()).rejects.toMatchObject({
      digest: expect.stringContaining("/login"),
    });
  });
});
