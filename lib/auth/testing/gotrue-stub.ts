import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The slice of Supabase Auth this app actually uses, served from an in-process HTTP server.
 *
 * It stands in for a hosted Supabase project the same way `db/testing/supabase-shim.sql`
 * stands in for Supabase's managed roles: so that "does the gate let a signed-in request
 * through, and turn an unsigned one away?" is a question the suite answers on every push with
 * nothing to provision. The tests drive it through the real `@supabase/supabase-js` and
 * `@supabase/ssr` clients, so the cookie handling and the request shapes under test are the
 * production ones — only the server on the far end is a stand-in.
 */
export type GoTrueStub = {
  url: string;
  secretKey: string;
  publishableKey: string;
  /** Plays Google and then Supabase's own callback: see `authorizeOAuth` below. */
  authorize: (options: { url: string; email: string }) => OAuthAuthorization;
  close: () => Promise<void>;
};

/** What a completed consent screen hands back, as the browser would receive it. */
export type OAuthAuthorization = {
  /** The authorization code, for `exchangeCodeForSession`. */
  code: string;
  /** Where Supabase would send the browser next, code and all. */
  location: string;
  /** The user the identity resolved to, so a test can assert it did not duplicate. */
  userId: string;
};

type StoredUser = {
  id: string;
  email: string;
  /** Null for a user who arrived through an external provider and has no password. */
  password: string | null;
  provider: "email" | "google";
  created_at: string;
};

/** An authorization code waiting to be exchanged, bound to the PKCE challenge it was minted for. */
type StoredAuthorization = {
  userId: string;
  challenge: string | null;
  method: string;
};

const SECRET_KEY = "sb_secret_stub_key";
const PUBLISHABLE_KEY = "sb_publishable_stub_key";

/** GoTrue's user payload, trimmed to the fields supabase-js and this app read back. */
function userPayload(user: StoredUser) {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    // Set either way, and that is the point: Google asserts a verified address, so GoTrue
    // confirms the user directly and dispatches no mail. Open sign-up needs no SMTP at all.
    email_confirmed_at: user.created_at,
    phone: "",
    confirmed_at: user.created_at,
    last_sign_in_at: user.created_at,
    app_metadata: { provider: user.provider, providers: [user.provider] },
    user_metadata: {},
    identities: [],
    created_at: user.created_at,
    updated_at: user.created_at,
    is_anonymous: false,
  };
}

async function readJson(
  stream: AsyncIterable<Buffer>,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>);
}

/** RFC 7636's S256: the challenge is the base64url SHA-256 of the verifier. */
function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Whether a verifier matches the challenge the authorization was minted with. Checked for
 * real, rather than waved through, because a client that stopped storing the verifier — or a
 * callback that ran without the cookie — would otherwise still sign somebody in here and fail
 * only in production.
 */
function verifierMatches(
  authorization: StoredAuthorization,
  verifier: string,
): boolean {
  if (authorization.challenge === null) {
    return true;
  }

  return authorization.method === "s256"
    ? s256(verifier) === authorization.challenge
    : verifier === authorization.challenge;
}

/**
 * Starts the stub on an ephemeral port and returns the URL and keys to point clients at.
 */
export async function startGoTrueStub(): Promise<GoTrueStub> {
  const users = new Map<string, StoredUser>();
  const sessions = new Map<string, string>();
  const authorizations = new Map<string, StoredAuthorization>();

  const byEmail = (email: string, provider: StoredUser["provider"]) =>
    [...users.values()].find(
      (user) => user.email === email && user.provider === provider,
    );

  const issueSession = (user: StoredUser) => {
    const accessToken = `stub-access-${randomUUID()}`;
    sessions.set(accessToken, user.id);

    return {
      access_token: accessToken,
      token_type: "bearer",
      // Long enough that supabase-js never decides the session is stale mid-test and
      // reaches for a refresh grant this stub does not issue.
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: `stub-refresh-${randomUUID()}`,
      user: userPayload(user),
    };
  };

  /**
   * Everything that happens between the browser leaving for `/auth/v1/authorize` and coming
   * back to the app's own callback: Google's consent screen, Google's redirect to Supabase, and
   * Supabase minting an authorization code. A function rather than an HTTP route because the
   * one thing a stub cannot do over HTTP is decide *which* Google account consented — a test
   * has to say, and real Google is asked by a person.
   *
   * The identity is keyed on the email here, where GoTrue keys on the provider and the
   * provider's subject id. For this app they are the same thing: one Google account, one
   * address, so "the same identity signing in twice" is the same row either way.
   */
  const authorizeOAuth = (options: {
    url: string;
    email: string;
  }): OAuthAuthorization => {
    const asked = new URL(options.url);
    const redirectTo = asked.searchParams.get("redirect_to");

    if (asked.pathname !== "/auth/v1/authorize") {
      throw new Error(`not an authorize URL: ${options.url}`);
    }
    if (asked.searchParams.get("provider") !== "google") {
      throw new Error(
        `the stub only knows the google provider: ${options.url}`,
      );
    }
    if (redirectTo === null) {
      throw new Error(`no redirect_to on the authorize URL: ${options.url}`);
    }

    const existing = byEmail(options.email, "google");
    const user: StoredUser = existing ?? {
      id: randomUUID(),
      email: options.email,
      password: null,
      provider: "google",
      created_at: new Date().toISOString(),
    };
    users.set(user.id, user);

    const code = `stub-code-${randomUUID()}`;
    authorizations.set(code, {
      userId: user.id,
      challenge: asked.searchParams.get("code_challenge"),
      method: (
        asked.searchParams.get("code_challenge_method") ?? "s256"
      ).toLowerCase(),
    });

    const location = new URL(redirectTo);
    location.searchParams.set("code", code);

    return { code, location: location.toString(), userId: user.id };
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const send = (status: number, body: unknown) => {
        const json = JSON.stringify(body);
        response.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(json),
        });
        response.end(json);
      };

      const url = new URL(request.url ?? "/", "http://stub");
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      const path = url.pathname;

      // The admin endpoints are the reason `SUPABASE_SECRET_KEY` exists. Checking the bearer
      // here is what keeps the test honest: a test that forgot the key would fail, not pass.
      if (path.startsWith("/auth/v1/admin/")) {
        if (bearer !== SECRET_KEY) {
          send(401, { message: "the secret key is required here" });
          return;
        }

        if (request.method === "GET" && path === "/auth/v1/admin/users") {
          // Paged for real. Sign-up is open now (docs/adr/0020), so the account list is no
          // longer one row, and `provisionAccount` walks it looking for one address.
          const page = Number(url.searchParams.get("page") ?? "1");
          const perPage = Number(url.searchParams.get("per_page") ?? "50");
          const all = [...users.values()];

          send(200, {
            users: all
              .slice((page - 1) * perPage, page * perPage)
              .map(userPayload),
          });
          return;
        }

        if (request.method === "POST" && path === "/auth/v1/admin/users") {
          const body = await readJson(request);
          const email = String(body.email);
          const user: StoredUser = {
            id: randomUUID(),
            email,
            password: String(body.password),
            provider: "email",
            created_at: new Date().toISOString(),
          };
          users.set(user.id, user);
          send(200, userPayload(user));
          return;
        }

        const named = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(path);

        // `updateUserById`, which is how a password is rotated on the account the deploy
        // smoke test signs in with.
        if (request.method === "PUT" && named !== null) {
          const user = users.get(named[1]!);
          if (user === undefined) {
            send(404, { message: "user not found" });
            return;
          }

          const body = await readJson(request);
          if (typeof body.password === "string") {
            user.password = body.password;
          }
          if (typeof body.email === "string") {
            user.email = body.email;
          }
          users.set(user.id, user);
          send(200, userPayload(user));
          return;
        }

        if (request.method === "DELETE" && named !== null) {
          const user = users.get(named[1]!);
          if (user === undefined) {
            send(404, { message: "user not found" });
            return;
          }
          users.delete(user.id);
          for (const [token, userId] of sessions) {
            if (userId === user.id) {
              sessions.delete(token);
            }
          }
          send(200, userPayload(user));
          return;
        }

        send(404, {
          message: `unstubbed admin route: ${request.method} ${path}`,
        });
        return;
      }

      if (path === "/auth/v1/token" && request.method === "POST") {
        const body = await readJson(request);
        const grant = url.searchParams.get("grant_type");

        // The OAuth half of the round trip: `exchangeCodeForSession` spends the code against
        // the verifier it stored when the authorize URL was built.
        if (grant === "pkce") {
          const authCode = String(body.auth_code ?? "");
          const verifier = String(body.code_verifier ?? "");

          if (authCode.length === 0 || verifier.length === 0) {
            send(400, {
              error: "invalid_request",
              error_description:
                "both auth code and code verifier should be non-empty",
            });
            return;
          }

          const authorization = authorizations.get(authCode);

          if (
            authorization === undefined ||
            !verifierMatches(authorization, verifier)
          ) {
            send(400, {
              error: "invalid_grant",
              error_description:
                "invalid flow state, no valid flow state found",
            });
            return;
          }

          const user = users.get(authorization.userId);

          if (user === undefined) {
            send(400, {
              error: "invalid_grant",
              error_description: "the authorized user no longer exists",
            });
            return;
          }

          // Single use, as GoTrue's is: a forwarded callback link must not sign anyone in.
          authorizations.delete(authCode);
          send(200, issueSession(user));
          return;
        }

        if (grant !== "password") {
          send(400, {
            error: "unsupported_grant_type",
            error_description: "the stub only issues password and pkce grants",
          });
          return;
        }

        const match = [...users.values()].find(
          (user) =>
            user.email === body.email &&
            user.password !== null &&
            user.password === body.password,
        );

        if (match === undefined) {
          send(400, {
            error: "invalid_grant",
            error_description: "Invalid login credentials",
          });
          return;
        }

        send(200, issueSession(match));
        return;
      }

      if (path === "/auth/v1/user" && request.method === "GET") {
        const userId = bearer === undefined ? undefined : sessions.get(bearer);
        const user = userId === undefined ? undefined : users.get(userId);

        if (user === undefined) {
          send(401, { message: "invalid claim: missing sub claim" });
          return;
        }

        send(200, userPayload(user));
        return;
      }

      if (path === "/auth/v1/logout" && request.method === "POST") {
        if (bearer !== undefined) {
          sessions.delete(bearer);
        }
        response.writeHead(204);
        response.end();
        return;
      }

      send(404, { message: `unstubbed route: ${request.method} ${path}` });
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secretKey: SECRET_KEY,
    publishableKey: PUBLISHABLE_KEY,
    authorize: authorizeOAuth,
    // `close` alone stops the stub accepting *new* connections and then waits for every open
    // one to end on its own. Both `@supabase/supabase-js` and the app's middleware reach this
    // stub through `fetch`, which keeps its sockets alive between requests, so an idle
    // keep-alive connection is the normal state at teardown and `close` would sit on it. The
    // callers are all tests that are finished with it, so tearing the sockets down first is
    // correct — and it is the difference between a suite that ends and one that hangs until
    // the runner's own timeout kills it with nothing to show.
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
