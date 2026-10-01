// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  AUTH_CALLBACK_PATH,
  GOOGLE_SIGN_IN_PATH,
  isApiPath,
  isPublicPath,
  LOGIN_PATH,
  PASSWORD_SIGN_IN_PATH,
  PUBLIC_PATHS,
} from "./paths";

describe("the public path list", () => {
  /**
   * Asserted by value, not by shape. Everything the gate protects is protected by *not* being
   * on this list, so the list growing is the one change here that can publish a page by
   * accident — and it should cost a Run a deliberate edit to this assertion. ADR 0021 added
   * the callback; it is the first addition since `/login`.
   */
  it("is exactly /login and the OAuth callback", () => {
    expect([...PUBLIC_PATHS]).toEqual(["/login", "/auth/callback"]);
  });

  it("lets both of them through", () => {
    expect(isPublicPath(LOGIN_PATH)).toBe(true);
    expect(isPublicPath(AUTH_CALLBACK_PATH)).toBe(true);
  });

  it("lets the sign-in routes under /login through, without listing them", () => {
    expect(isPublicPath(GOOGLE_SIGN_IN_PATH)).toBe(true);
    expect(isPublicPath(PASSWORD_SIGN_IN_PATH)).toBe(true);
    expect([...PUBLIC_PATHS]).not.toContain(GOOGLE_SIGN_IN_PATH);
    expect([...PUBLIC_PATHS]).not.toContain(PASSWORD_SIGN_IN_PATH);
  });

  it.each([
    "/",
    "/deck",
    "/watchlist",
    "/api/profiles",
    // A prefix of a public path is not a public path: `/loginish` is its own route.
    "/loginish",
    "/auth",
    "/auth/callbackish",
  ])("keeps %s gated", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("the API path test", () => {
  it.each(["/api", "/api/profiles", "/api/profiles/abc/keep"])(
    "treats %s as JSON",
    (path) => {
      expect(isApiPath(path)).toBe(true);
    },
  );

  it.each(["/", "/login", "/auth/callback", "/apish"])(
    "treats %s as a page",
    (path) => {
      expect(isApiPath(path)).toBe(false);
    },
  );
});
