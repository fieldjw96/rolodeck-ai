/**
 * The response headers every request through the Proxy carries. They are set in one place —
 * `lib/auth/gate.ts`, which already runs on every matched request — rather than in
 * `next.config.ts`, so that a header and the Content-Security-Policy nonce it depends on are
 * written by the same code and cannot drift apart. See docs/adr/0006.
 */

/** Next reads the nonce back out of this header on the *request* to nonce its own scripts. */
export const CSP_HEADER = "Content-Security-Policy";

/** Where a Server Component can read the nonce, if one ever needs to inline a script. */
export const NONCE_HEADER = "x-nonce";

/**
 * A fresh 128-bit nonce per request. It has to be unguessable and it has to be new every time:
 * a nonce reused across responses is a nonce an injected script can simply quote.
 * `crypto.getRandomValues` rather than `node:crypto` because the Proxy may run on the Edge
 * runtime, where only the Web Crypto API exists.
 */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return btoa(String.fromCharCode(...bytes));
}

/** True only under `next dev`, which needs a looser policy than anything we deploy. */
function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * The policy itself.
 *
 * `script-src` is nonce-based with `strict-dynamic`: Next emits inline bootstrap and RSC
 * payload scripts on every page, so the alternative is `'unsafe-inline'`, which is a policy
 * that stops nothing. `strict-dynamic` then lets those nonced scripts load the chunks under
 * `/_next/static` without listing them.
 *
 * `style-src` keeps `'unsafe-inline'` deliberately. React writes inline `style` attributes and
 * `next dev` injects stylesheets through JavaScript, and injected CSS is a far smaller prize
 * than injected script — this is the one loosening worth its cost.
 *
 * `frame-ancestors 'none'` says what `X-Frame-Options: DENY` says, to browsers that read CSP
 * instead; both are sent because the Ticket asks for the header and neither supersedes the
 * other everywhere.
 */
export function contentSecurityPolicy(
  nonce: string,
  development = isDevelopment(),
): string {
  const directives = [
    "default-src 'self'",
    // `next dev` compiles with `eval`. Nothing that gets deployed does.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // `blob:` and `data:` are what `next/image` produces for placeholders.
    "img-src 'self' blob: data:",
    // `next/font` self-hosts the Geist faces at build time, so nothing is fetched elsewhere.
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Meaningless over http://localhost, and would break it if it were not.
    ...(development ? [] : ["upgrade-insecure-requests"]),
  ];

  return directives.join("; ");
}

/**
 * Every security header, given the nonce minted for this request.
 *
 * `nosniff` stops a browser from deciding for itself that a JSON error body is HTML and running
 * it. `DENY` keeps the signed-in Deck out of anyone's iframe, which is what a clickjacked Keep
 * or Pass would need. `strict-origin-when-cross-origin` sends the full path to ourselves and
 * only the origin to anybody else, so a Profile id never leaves in a `Referer`.
 */
export function securityHeaders(nonce: string): Record<string, string> {
  return {
    [CSP_HEADER]: contentSecurityPolicy(nonce),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

/** Puts them on a response, whatever else that response is. */
export function withSecurityHeaders<Sent extends Response>(
  response: Sent,
  nonce: string,
): Sent {
  for (const [name, value] of Object.entries(securityHeaders(nonce))) {
    response.headers.set(name, value);
  }

  return response;
}
