import { randomUUID } from "node:crypto";
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
  close: () => Promise<void>;
};

type StoredUser = {
  id: string;
  email: string;
  password: string;
  created_at: string;
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
    email_confirmed_at: user.created_at,
    phone: "",
    confirmed_at: user.created_at,
    last_sign_in_at: user.created_at,
    app_metadata: { provider: "email", providers: ["email"] },
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

/**
 * Starts the stub on an ephemeral port and returns the URL and keys to point clients at.
 */
export async function startGoTrueStub(): Promise<GoTrueStub> {
  const users = new Map<string, StoredUser>();
  const sessions = new Map<string, string>();

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
          send(200, { users: [...users.values()].map(userPayload) });
          return;
        }

        if (request.method === "POST" && path === "/auth/v1/admin/users") {
          const body = await readJson(request);
          const email = String(body.email);
          const user: StoredUser = {
            id: randomUUID(),
            email,
            password: String(body.password),
            created_at: new Date().toISOString(),
          };
          users.set(user.id, user);
          send(200, userPayload(user));
          return;
        }

        const deleting = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(path);
        if (request.method === "DELETE" && deleting !== null) {
          const user = users.get(deleting[1]!);
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
        const match = [...users.values()].find(
          (user) =>
            user.email === body.email && user.password === body.password,
        );

        if (url.searchParams.get("grant_type") !== "password") {
          send(400, {
            error: "unsupported_grant_type",
            error_description: "the stub only issues password grants",
          });
          return;
        }

        if (match === undefined) {
          send(400, {
            error: "invalid_grant",
            error_description: "Invalid login credentials",
          });
          return;
        }

        const accessToken = `stub-access-${randomUUID()}`;
        sessions.set(accessToken, match.id);

        send(200, {
          access_token: accessToken,
          token_type: "bearer",
          // Long enough that supabase-js never decides the session is stale mid-test and
          // reaches for a refresh grant this stub does not issue.
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: `stub-refresh-${randomUUID()}`,
          user: userPayload(match),
        });
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
