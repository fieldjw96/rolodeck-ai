import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SIGN_IN_ERRORS, signInErrorMessage } from "../errors";
import { LoginForm } from "./login-form";

describe("the unlisted password form", () => {
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

  it("offers no way to create an account, and no way back to this page either", () => {
    render(<LoginForm />);

    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(document.body.textContent ?? "").not.toMatch(/sign ?up|register/i);
  });
});
