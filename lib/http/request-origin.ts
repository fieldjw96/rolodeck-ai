import type { NextRequest } from "next/server";

/**
 * A header that may arrive as a comma-separated list, because every proxy on the way appends
 * to it. The first value is the one the browser asked for.
 */
function firstValue(header: string | null): string | null {
  if (header === null) {
    return null;
  }

  const first = header.split(",")[0]!.trim();

  return first.length === 0 ? null : first;
}

/** True for the hosts where `https` is not available and assuming it would break the flow. */
function isLoopback(host: string): boolean {
  const hostname = host.split(":")[0]!.toLowerCase();

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * The origin a browser used to reach this request, which is what an OAuth `redirectTo` has to
 * name: Google sends the user to Supabase, Supabase sends them here, and a `redirectTo` built
 * from anything but the externally visible origin lands them on a host that does not exist.
 *
 * Read from `x-forwarded-host` and `x-forwarded-proto` rather than from `request.url`, because
 * behind Vercel's proxy `request.url` can carry the internal host the function was invoked on.
 * That difference does not show up locally, does not show up in a diff, and only shows up as a
 * redirect to `localhost` from production — the class of failure `scripts/smoke.ts` exists for.
 *
 * Neither header is trusted blindly for anything but this: the value only ever becomes a
 * `redirectTo`, which Supabase itself refuses unless it matches the project's configured
 * redirect allow-list.
 */
export function requestOrigin(request: NextRequest): string {
  const host =
    firstValue(request.headers.get("x-forwarded-host")) ??
    firstValue(request.headers.get("host")) ??
    request.nextUrl.host;

  const proto =
    firstValue(request.headers.get("x-forwarded-proto")) ??
    (isLoopback(host) ? "http" : "https");

  return `${proto}://${host}`;
}
