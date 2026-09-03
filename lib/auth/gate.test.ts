// @vitest-environment node
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { applyAuthGate } from "./gate";
import {
  authBackends,
  cookieHeader,
  signInForCookies,
  type AuthBackend,
  type CookiePair,
  type ThrowawayUser,
} from "./testing/auth-backend";

const ORIGIN = "https://rolodeck.example";

function request(
  path: string,
  cookies: CookiePair[] = [],
  method = "GET",
): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    method,
    headers: cookies.length === 0 ? {} : { cookie: cookieHeader(cookies) },
  });
}

describe.each(authBackends())("the auth gate, against $name", ({ start }) => {
  let backend: AuthBackend;
  let user: ThrowawayUser;
  let signedIn: CookiePair[];

  beforeAll(async () => {
    backend = await start();

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", backend.url);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", backend.publishableKey);

    user = await backend.createUser();
    signedIn = await signInForCookies(backend, user);
  }, 30_000);

  afterAll(async () => {
    // Deleted whatever the assertions did, so a live project is left exactly as it was found.
    if (user !== undefined) {
      await backend.deleteUser(user.id);
    }
    await backend?.close();
    vi.unstubAllEnvs();
  }, 30_000);

  it("sends a request for / with no session to /login", async () => {
    const response = await applyAuthGate(request("/"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("sends a request for any other gated route to /login too", async () => {
    const response = await applyAuthGate(request("/deck/sprocket?keep=1"));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("lets an unauthenticated request reach /login", async () => {
    const response = await applyAuthGate(request("/login"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns 200 for / once the throwaway user is signed in", async () => {
    const response = await applyAuthGate(request("/", signedIn));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("sends a signed-in request for /login back to the deck", async () => {
    const response = await applyAuthGate(request("/login", signedIn));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("turns away a session cookie that no longer names a real user", async () => {
    const doomed = await backend.createUser();
    const cookies = await signInForCookies(backend, doomed);

    await backend.deleteUser(doomed.id);

    const response = await applyAuthGate(request("/", cookies));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  }, 30_000);

  it("drops the query it was carrying rather than reflecting it onto /login", async () => {
    const response = await applyAuthGate(
      request("/deck?next=https://elsewhere.example"),
    );

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("turns a form submitted on an expired session into a plain GET of /login", async () => {
    // A 307 here would make the browser re-POST the form body at /login.
    const response = await applyAuthGate(request("/deck", [], "POST"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("answers an unauthenticated API request with 401 rather than a redirect", async () => {
    // A fetch follows a redirect, so a gated endpoint that sent one would answer with the
    // login page and a 200 — the one shape a caller cannot tell from success.
    const response = await applyAuthGate(request("/api/profiles?limit=5"));

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "not signed in" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers an unauthenticated POST to a swipe endpoint with 401 too", async () => {
    const response = await applyAuthGate(
      request("/api/profiles/abc/keep", [], "POST"),
    );

    expect(response.status).toBe(401);
  });

  it("lets a signed-in API request through to its route handler", async () => {
    const response = await applyAuthGate(request("/api/profiles", signedIn));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not let a redirect it issues be cached", async () => {
    const response = await applyAuthGate(request("/"));

    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  describe("the security headers", () => {
    // Whichever way the gate answers, it is the last code to touch the response, so all three
    // shapes have to carry them — a policy that only covers the happy path covers nothing.
    it.each([
      ["a pass-through", () => request("/", signedIn)],
      ["a redirect to /login", () => request("/")],
      ["a 401 from an API path", () => request("/api/profiles")],
    ])("are on %s", async (_shape, make) => {
      const response = await applyAuthGate(make());

      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
    });

    it("hands Next the same nonce on the request that the policy names", async () => {
      // This is the whole mechanism: Next reads the nonce out of the request's CSP header and
      // stamps it onto the inline scripts it emits. If the two ever disagree, the deployed app
      // renders with every one of its own scripts blocked.
      const response = await applyAuthGate(request("/", signedIn));
      const policy = response.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];

      expect(nonce).toEqual(expect.any(String));
      expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
      expect(
        response.headers.get("x-middleware-request-content-security-policy"),
      ).toBe(policy);
    });

    it("mints a new nonce for every request", async () => {
      const noncesOf = async () =>
        /'nonce-([^']+)'/.exec(
          (await applyAuthGate(request("/", signedIn))).headers.get(
            "content-security-policy",
          ) ?? "",
        )?.[1];

      expect(await noncesOf()).not.toBe(await noncesOf());
    });
  });
});

describe("the auth gate's configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to run at all when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    // Failing closed matters more here than anywhere else: a gate that quietly became a
    // no-op would publish the whole app.
    await expect(applyAuthGate(request("/"))).rejects.toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
  });
});
