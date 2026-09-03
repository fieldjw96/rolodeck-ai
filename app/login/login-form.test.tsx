import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  importSpecifiers,
  readSourceFiles,
  resolveImport,
  type SourceFile,
} from "../../lib/testing/sources";
import { SIGN_IN_ERRORS, signInErrorMessage } from "./errors";
import { LoginForm } from "./login-form";

describe("the login form", () => {
  // Testing Library only registers its own cleanup when Vitest runs with globals on, which
  // this repo does not; without this, one render's DOM is still there for the next.
  afterEach(cleanup);

  it("asks for an email and a password", () => {
    render(<LoginForm />);

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("says nothing about a failure that has not happened", () => {
    render(<LoginForm />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a rejected sign-in", () => {
    render(<LoginForm error="credentials" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      SIGN_IN_ERRORS.credentials,
    );
  });

  it("falls back to the credentials message for an ?error= value someone typed", () => {
    render(<LoginForm error="<script>" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      SIGN_IN_ERRORS.credentials,
    );
  });

  it("ignores a repeated ?error= parameter, which arrives as an array", () => {
    expect(signInErrorMessage(["credentials", "incomplete"])).toBeUndefined();
  });

  it("offers no way to create an account", () => {
    render(<LoginForm />);

    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(document.body.textContent ?? "").not.toMatch(/sign ?up|register/i);
  });
});

/**
 * CLAUDE.md's V1 is single-player and the Ticket is explicit that the one account is
 * provisioned out of band. These assertions are what stops a later Run from adding a sign-up
 * page because the login form looked like it was missing one.
 */
describe("self-service sign-up", () => {
  let sources: SourceFile[];

  beforeAll(async () => {
    sources = await readSourceFiles(["app", "lib"], ["proxy.ts"]);
  });

  it("has no route for it", () => {
    const routes = sources
      .map((file) => file.path)
      .filter((file) => /\/(sign-?up|register|join)\//i.test(file));

    expect(routes).toEqual([]);
  });

  it("is never called, on any page or in any action", () => {
    const callers = sources
      .filter((file) => /\.signUp\s*\(/.test(file.text))
      .map((file) => file.path);

    expect(callers).toEqual([]);
  });

  it("leaves the login form as the only shipped module wiring up the sign-in action", () => {
    const importers = sources
      .filter(
        (file) =>
          !/\.test\.tsx?$/.test(file.path) &&
          importSpecifiers(file.text).some(
            (specifier) =>
              resolveImport(file.path, specifier) === "app/login/actions",
          ),
      )
      .map((file) => file.path);

    expect(importers).toEqual(["app/login/login-form.tsx"]);
  });
});
