// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  stubBackend,
  type AuthBackend,
  type ThrowawayUser,
} from "../../lib/auth/testing/auth-backend";
import { signIn } from "./actions";

/**
 * A Server Action may write cookies, unlike a Server Component, so this stand-in for
 * `next/headers` accepts them. What it collects is exactly what would go out as `Set-Cookie`,
 * which is how these tests can tell a successful sign-in from a failed one.
 */
let jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

let backend: AuthBackend;
let user: ThrowawayUser;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
}

/** The cookies `@supabase/ssr` writes a session into are the ones prefixed `sb-`. */
function sessionCookies(): string[] {
  return [...jar.keys()].filter((name) => name.startsWith("sb-"));
}

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

beforeEach(() => {
  jar = new Map();
});

describe("signing in", () => {
  it("writes a session and sends the browser to the deck", async () => {
    // `redirect()` works by throwing, so the redirect is the success case here.
    await expect(
      signIn(form({ email: user.email, password: user.password })),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });

    expect(sessionCookies().length).toBeGreaterThan(0);
  });

  it("writes no session when the password is wrong", async () => {
    await expect(
      signIn(form({ email: user.email, password: "not-the-password" })),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("/login?error=credentials"),
    });

    expect(sessionCookies()).toEqual([]);
  });

  it("gives an unknown email the same answer as a wrong password", async () => {
    await expect(
      signIn(form({ email: "stranger@example.invalid", password: "anything" })),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("/login?error=credentials"),
    });
  });

  it("rejects a form that is missing a field before it asks Supabase anything", async () => {
    await expect(signIn(form({ email: user.email }))).rejects.toMatchObject({
      digest: expect.stringContaining("/login?error=incomplete"),
    });

    expect(sessionCookies()).toEqual([]);
  });

  it("rejects an email that is not an email", async () => {
    await expect(
      signIn(form({ email: "not-an-email", password: "anything" })),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("/login?error=incomplete"),
    });
  });
});
