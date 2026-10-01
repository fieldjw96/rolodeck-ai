// @vitest-environment node
import { createServerClient } from "@supabase/ssr";
import { NextRequest, type NextResponse } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { applyAuthGate } from "../../../lib/auth/gate";
import {
  cookieHeader,
  stubBackend,
  type AuthBackend,
  type CookiePair,
} from "../../../lib/auth/testing/auth-backend";
import { GET as startGoogleSignIn } from "../../login/google/route";
import { GET as finishGoogleSignIn } from "./route";

const ORIGIN = "https://rolodeck.example";

/**
 * The browser's cookie jar. Both halves of the round trip write cookies onto the response they
 * return — the PKCE verifier on the way out, the session on the way back — so carrying them
 * here is what makes these tests the same sequence a browser performs, rather than two
 * unrelated handler calls.
 */
let jar = new Map<string, string>();

function cookies(): CookiePair[] {
  return [...jar].map(([name, value]) => ({ name, value }));
}

function request(url: string): NextRequest {
  return new NextRequest(new URL(url, ORIGIN), {
    headers: jar.size === 0 ? {} : { cookie: cookieHeader(cookies()) },
  });
}

/** What a browser does with `Set-Cookie`, including treating an empty value as a deletion. */
function absorb(response: NextResponse): NextResponse {
  for (const { name, value } of response.cookies.getAll()) {
    if (value === "") {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }

  return response;
}

function verifierCookieName(): string | undefined {
  return [...jar.keys()].find((name) => name.includes("code-verifier"));
}

function sessionCookieNames(): string[] {
  return [...jar.keys()].filter(
    (name) => name.startsWith("sb-") && !name.includes("code-verifier"),
  );
}

let backend: AuthBackend;

beforeAll(async () => {
  backend = await stubBackend();

  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", backend.url);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", backend.publishableKey);
}, 30_000);

afterAll(async () => {
  await backend.close();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  jar = new Map();
});

/**
 * Walks the whole round trip for one Google identity: ask for the authorize URL, let the stub
 * play the consent screen, then come back to the callback with the code it issued.
 */
async function signInWithGoogle(email: string): Promise<{
  response: NextResponse;
  userId: string;
}> {
  const started = absorb(await startGoogleSignIn(request("/login/google")));
  const authorizeUrl = started.headers.get("location");

  expect(authorizeUrl).toContain(`${backend.url}/auth/v1/authorize`);

  // Null only against a live project, where no test can consent on a real Google account.
  const authorization = backend.authorize!({ url: authorizeUrl!, email });

  return {
    response: absorb(await finishGoogleSignIn(request(authorization.location))),
    userId: authorization.userId,
  };
}

/** Reads the signed-in user back through `@supabase/ssr`, exactly as a render would. */
async function userFromJar() {
  const supabase = createServerClient(backend.url, backend.publishableKey, {
    cookies: { getAll: cookies, setAll: () => {} },
  });

  const { data } = await supabase.auth.getUser();

  return data.user;
}

describe("starting the Google round trip", () => {
  it("sends the browser to Supabase's authorize endpoint, asking only for openid email profile", async () => {
    const response = absorb(await startGoogleSignIn(request("/login/google")));
    const authorize = new URL(response.headers.get("location")!);

    expect(authorize.origin).toBe(backend.url);
    expect(authorize.pathname).toBe("/auth/v1/authorize");
    expect(authorize.searchParams.get("provider")).toBe("google");
    expect(authorize.searchParams.get("scopes")).toBe("openid email profile");
  });

  it("points redirectTo at this app's own callback", async () => {
    const response = await startGoogleSignIn(request("/login/google"));
    const authorize = new URL(response.headers.get("location")!);

    expect(authorize.searchParams.get("redirect_to")).toBe(
      `${ORIGIN}/auth/callback`,
    );
  });

  it("builds redirectTo from the forwarded host, not the host the function was invoked on", async () => {
    // The failure this guards is production-only: behind a proxy, a `redirectTo` built from
    // the request's own URL names an internal host and sends the user nowhere.
    const forwarded = new NextRequest(new URL("/login/google", ORIGIN), {
      headers: {
        "x-forwarded-host": "rolodeck-ai.vercel.app",
        "x-forwarded-proto": "https",
      },
    });

    const response = await startGoogleSignIn(forwarded);
    const authorize = new URL(response.headers.get("location")!);

    expect(authorize.searchParams.get("redirect_to")).toBe(
      "https://rolodeck-ai.vercel.app/auth/callback",
    );
  });

  it("leaves the PKCE verifier in a cookie for the callback to spend", async () => {
    absorb(await startGoogleSignIn(request("/login/google")));

    expect(verifierCookieName()).toEqual(expect.any(String));
  });

  it("does not let the redirect, which carries that cookie, be cached", async () => {
    const response = await startGoogleSignIn(request("/login/google"));

    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

describe("a Google identity signing in for the first time", () => {
  it("lands on the Deck with a session, with nothing provisioned by hand", async () => {
    const { response } = await signInWithGoogle("first@berkeley.edu");

    expect(response.headers.get("location")).toBe(`${ORIGIN}/deck`);
    expect(sessionCookieNames().length).toBeGreaterThan(0);

    const user = await userFromJar();

    expect(user?.email).toBe("first@berkeley.edu");
    // Confirmed without a message being sent: Google asserted the address, which is what lets
    // sign-up be open with no SMTP provider at all. See docs/adr/0021.
    expect(user?.email_confirmed_at).toEqual(expect.any(String));
    expect(user?.app_metadata.provider).toBe("google");
  });

  it("gets a Deck the gate lets it reach", async () => {
    await signInWithGoogle("dealt-a-deck@berkeley.edu");

    const deck = await applyAuthGate(request("/deck"));

    expect(deck.status).toBe(200);
    expect(deck.headers.get("location")).toBeNull();
  });
});

describe("the same Google identity signing in again", () => {
  it("resolves to the one user rather than a duplicate", async () => {
    const first = await signInWithGoogle("returning@berkeley.edu");
    const firstUser = await userFromJar();

    jar = new Map();

    const second = await signInWithGoogle("returning@berkeley.edu");
    const secondUser = await userFromJar();

    expect(second.userId).toBe(first.userId);
    expect(secondUser?.id).toBe(firstUser?.id);
    expect(secondUser?.email).toBe("returning@berkeley.edu");
  });
});

describe("a round trip that does not finish", () => {
  it("sends a provider error back to /login, saying so", async () => {
    const response = await finishGoogleSignIn(
      request("/auth/callback?error=access_denied&error_description=denied"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/login?error=declined`,
    );
  });

  it("sends a callback with no code back to /login, saying something else", async () => {
    const response = await finishGoogleSignIn(request("/auth/callback"));

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/login?error=no-code`,
    );
  });

  it("sends a code Supabase refuses back to /login, saying a third thing", async () => {
    // A verifier is in hand, so this is a code that is simply not ours — a forwarded link, or
    // one already spent.
    absorb(await startGoogleSignIn(request("/login/google")));

    const response = await finishGoogleSignIn(
      request("/auth/callback?code=not-a-real-code"),
    );

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/login?error=exchange`,
    );
    expect(sessionCookieNames()).toEqual([]);
  });

  it("refuses a code arriving without the verifier it was minted with", async () => {
    const started = absorb(await startGoogleSignIn(request("/login/google")));
    const authorization = backend.authorize!({
      url: started.headers.get("location")!,
      email: "forwarded@berkeley.edu",
    });

    // The link, forwarded to a browser that was never at the consent screen.
    jar = new Map();

    const response = await finishGoogleSignIn(request(authorization.location));

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/login?error=exchange`,
    );
    expect(sessionCookieNames()).toEqual([]);
  });

  // `@supabase/ssr` deliberately keeps the code verifier cookie rather than clearing it on
  // exchange, because the next round trip overwrites it. What makes that harmless is this.
  it("refuses a code that has already been spent", async () => {
    const started = absorb(await startGoogleSignIn(request("/login/google")));
    const authorization = backend.authorize!({
      url: started.headers.get("location")!,
      email: "replayed@berkeley.edu",
    });

    absorb(await finishGoogleSignIn(request(authorization.location)));
    const replay = await finishGoogleSignIn(request(authorization.location));

    expect(replay.headers.get("location")).toBe(
      `${ORIGIN}/login?error=exchange`,
    );
  });

  it("says so, rather than throwing, when Supabase is not configured at all", async () => {
    // The gate refuses to run in this state and nothing else is reachable, so this is only
    // ever the message on a broken deployment — but it is a message, not a 500.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    try {
      const started = await startGoogleSignIn(request("/login/google"));
      const finished = await finishGoogleSignIn(
        request("/auth/callback?code=anything"),
      );

      for (const response of [started, finished]) {
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(
          `${ORIGIN}/login?error=unavailable`,
        );
      }

      // Swallowed for the browser, not for the logs: this is the one failure here somebody
      // has to go and fix.
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", backend.url);
      vi.stubEnv(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        backend.publishableKey,
      );
    }
  });

  it("never answers with a blank page, a 500, or an opaque digest", async () => {
    // The point of the handler being a handler: every one of these is a redirect a person can
    // read, not an exception Next would render as a digest.
    for (const url of [
      "/auth/callback?error=server_error",
      "/auth/callback",
      "/auth/callback?code=",
      "/auth/callback?code=nonsense",
    ]) {
      const response = await finishGoogleSignIn(request(url));

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toMatch(
        /\/login\?error=(declined|no-code|exchange)$/,
      );
    }
  });
});
