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
  signInForCookies,
  stubBackend,
  type AuthBackend,
  type ThrowawayUser,
} from "../../lib/auth/testing/auth-backend";
import { signOut } from "./actions";

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

beforeEach(async () => {
  jar = new Map(
    (await signInForCookies(backend, user)).map(({ name, value }) => [
      name,
      value,
    ]),
  );
});

describe("signing out", () => {
  it("clears the session cookies and sends the browser to /login", async () => {
    expect([...jar.keys()].some((name) => name.startsWith("sb-"))).toBe(true);

    await expect(signOut()).rejects.toMatchObject({
      digest: expect.stringContaining("/login"),
    });

    // `@supabase/ssr` clears a cookie by writing an empty value rather than dropping the key,
    // so "gone" means "carries nothing", not "absent".
    const remaining = [...jar]
      .filter(([name]) => name.startsWith("sb-"))
      .filter(([, value]) => value.length > 0);

    expect(remaining).toEqual([]);
  });
});
