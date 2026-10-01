import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  importSpecifiers,
  readSourceFiles,
  resolveImport,
  type SourceFile,
} from "../../lib/testing/sources";
import { GoogleSignIn } from "./google-sign-in";
import { OAUTH_ERRORS, oauthErrorMessage } from "./errors";

describe("the login page", () => {
  // Testing Library only registers its own cleanup when Vitest runs with globals on, which
  // this repo does not; without this, one render's DOM is still there for the next.
  afterEach(cleanup);

  it("offers Google and sends it to this app's own handler", () => {
    render(<GoogleSignIn />);

    expect(
      screen.getByRole("link", { name: /sign in with google/i }),
    ).toHaveAttribute("href", "/login/google");
  });

  it("says nothing about a failure that has not happened", () => {
    render(<GoogleSignIn />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(Object.entries(OAUTH_ERRORS))(
    "reports %s distinguishably",
    (error, message) => {
      render(<GoogleSignIn error={error} />);

      expect(screen.getByRole("alert")).toHaveTextContent(message);
    },
  );

  it("tells the four failures apart", () => {
    expect(new Set(Object.values(OAUTH_ERRORS)).size).toBe(
      Object.keys(OAUTH_ERRORS).length,
    );
  });

  it("falls back for an ?error= value someone typed, rather than echoing it", () => {
    render(<GoogleSignIn error="<script>" />);

    expect(screen.getByRole("alert")).toHaveTextContent(OAUTH_ERRORS.declined);
    expect(document.body.innerHTML).not.toContain("<script>");
  });

  it("ignores a repeated ?error= parameter, which arrives as an array", () => {
    expect(oauthErrorMessage(["declined", "exchange"])).toBeUndefined();
  });

  it("offers no way to create an account, because Google owns that", () => {
    render(<GoogleSignIn />);

    expect(document.body.textContent ?? "").not.toMatch(/sign ?up|register/i);
  });

  /**
   * The email-and-password door survives for the deploy smoke test and is advertised nowhere:
   * ADR 0021 keeps it unlisted rather than widening ADR 0013's rule about which credentials
   * may reach GitHub Actions. This is that "nowhere", asserted.
   */
  it("renders no link, button or other affordance reaching the password form", () => {
    render(<GoogleSignIn />);

    const reachable = [
      ...document.querySelectorAll("a[href], form[action], button, input"),
    ].map(
      (element) =>
        `${element.getAttribute("href") ?? ""} ${element.getAttribute("action") ?? ""} ${element.textContent ?? ""}`,
    );

    expect(
      reachable.filter((candidate) => /password/i.test(candidate)),
    ).toEqual([]);
    expect(document.body.textContent ?? "").not.toMatch(/password/i);
    expect(document.body.innerHTML).not.toContain("/login/password");
  });
});

describe("the two doors, as the source tree has them", () => {
  let sources: SourceFile[];

  beforeAll(async () => {
    sources = await readSourceFiles(["app", "lib"], ["proxy.ts"]);
  });

  const shipped = (file: SourceFile) => !/\.test\.tsx?$/.test(file.path);

  it("has no sign-up route, and calls signUp nowhere", () => {
    expect(
      sources
        .map((file) => file.path)
        .filter((file) => /\/(sign-?up|register|join)\//i.test(file)),
    ).toEqual([]);

    expect(
      sources
        .filter((file) => /\.signUp\s*\(/.test(file.text))
        .map((file) => file.path),
    ).toEqual([]);
  });

  it("wires the password Server Action up from the password form and nowhere else", () => {
    const importers = sources
      .filter(
        (file) =>
          shipped(file) &&
          importSpecifiers(file.text).some(
            (specifier) =>
              resolveImport(file.path, specifier) === "app/login/actions",
          ),
      )
      .map((file) => file.path);

    expect(importers).toEqual(["app/login/password/login-form.tsx"]);
  });

  it("leaves the login page itself importing nothing of the password door", () => {
    const page = sources.find((file) => file.path === "app/login/page.tsx");

    expect(page).toBeDefined();
    expect(
      importSpecifiers(page!.text).map((specifier) =>
        resolveImport("app/login/page.tsx", specifier),
      ),
    ).not.toContain("app/login/actions");
    expect(page!.text).not.toContain("password");
  });

  it("names the password path only where it is served, redirected to, or defined", () => {
    const namers = sources
      .filter(shipped)
      .filter((file) => file.text.includes("/login/password"))
      .map((file) => file.path);

    expect(namers.sort()).toEqual(["lib/auth/paths.ts"]);
  });
});
