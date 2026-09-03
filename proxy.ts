import type { NextRequest } from "next/server";

import { applyAuthGate } from "./lib/auth/gate";

/**
 * Next 16 renamed Middleware to Proxy; the convention is otherwise unchanged. Only one Proxy
 * file is allowed per project, so the gate itself lives in `lib/auth/gate.ts` where it can be
 * tested directly, and this file is only the wiring.
 */
export function proxy(request: NextRequest) {
  return applyAuthGate(request);
}

export const config = {
  // Everything except Next's own build output and static image assets, which carry no session
  // and would only be slowed down by a round trip to Supabase Auth. Note that the Proxy still
  // runs for `_next/data` requests regardless, by design, so a gated page cannot be read
  // through its data route. The matcher has to be a literal for Next to analyse it at build
  // time, so it cannot be assembled from the constants in `lib/auth/paths.ts`.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
