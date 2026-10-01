/**
 * The headers a response that sets or clears an auth cookie must carry. Without them a CDN or
 * a reverse proxy is free to keep the response, and one visitor's session token gets served to
 * the next. `@supabase/ssr` hands these to its own `setAll`; a redirect that carries session
 * cookies out of the Proxy or out of the OAuth callback needs them just as much.
 */
export const NO_STORE: Record<string, string> = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
};

/** Puts them on a response, whatever else that response is. */
export function withNoStore<Sent extends Response>(response: Sent): Sent {
  for (const [name, value] of Object.entries(NO_STORE)) {
    response.headers.set(name, value);
  }

  return response;
}
