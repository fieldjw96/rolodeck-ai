// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicy,
  createNonce,
  securityHeaders,
  withSecurityHeaders,
} from "./security-headers";

const NONCE = "dGhpcyBpcyBub3QgcmFuZG9t";

/** The policy as a lookup, so an assertion names a directive rather than counting semicolons. */
function directives(policy: string): Record<string, string> {
  return Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");

      return [name!, values.join(" ")];
    }),
  );
}

describe("the nonce", () => {
  it("is different every time", () => {
    const minted = new Set(Array.from({ length: 100 }, createNonce));

    expect(minted.size).toBe(100);
  });

  it("is 128 bits, and legal inside a CSP directive", () => {
    const nonce = createNonce();

    expect(atob(nonce)).toHaveLength(16);
    // A quote or a semicolon in here would end the directive early.
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("the Content-Security-Policy", () => {
  const deployed = directives(contentSecurityPolicy(NONCE, false));

  it("allows inline script only by this request's nonce", () => {
    expect(deployed["script-src"]).toBe(
      `'self' 'nonce-${NONCE}' 'strict-dynamic'`,
    );
    expect(deployed["script-src"]).not.toContain("'unsafe-inline'");
    expect(deployed["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("defaults to this origin and forbids the rest", () => {
    expect(deployed["default-src"]).toBe("'self'");
    expect(deployed["object-src"]).toBe("'none'");
    expect(deployed["base-uri"]).toBe("'self'");
    expect(deployed["form-action"]).toBe("'self'");
    expect(deployed["frame-ancestors"]).toBe("'none'");
    expect(deployed).toHaveProperty("upgrade-insecure-requests");
  });

  it("loosens script-src for `next dev` and nothing else", () => {
    const development = directives(contentSecurityPolicy(NONCE, true));

    expect(development["script-src"]).toContain("'unsafe-eval'");
    // http://localhost is the one origin this would break rather than protect.
    expect(development).not.toHaveProperty("upgrade-insecure-requests");
    expect(development["default-src"]).toBe(deployed["default-src"]);
    expect(development["frame-ancestors"]).toBe(deployed["frame-ancestors"]);
  });
});

describe("the security headers", () => {
  it("are the four the Ticket asks for", () => {
    expect(Object.keys(securityHeaders(NONCE)).sort()).toEqual([
      "Content-Security-Policy",
      "Referrer-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
  });

  it("go onto a response whatever else is on it", () => {
    const response = withSecurityHeaders(
      Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }),
      NONCE,
    );

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      `'nonce-${NONCE}'`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
