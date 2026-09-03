// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generatePassword,
  parseProvisionArgs,
  provisionSingleAccount,
} from "./provisioning";
import { stubBackend, type AuthBackend } from "./testing/auth-backend";

describe("the provisioning arguments", () => {
  it("takes one email address", () => {
    expect(parseProvisionArgs(["jack@example.com"])).toEqual({
      email: "jack@example.com",
    });
  });

  it("ignores flags around it", () => {
    expect(parseProvisionArgs(["--verbose", "jack@example.com"])).toEqual({
      email: "jack@example.com",
    });
  });

  it("refuses a second positional argument, which would be a password", () => {
    expect(() => parseProvisionArgs(["jack@example.com", "hunter2"])).toThrow(
      /usage/,
    );
  });

  it("refuses no arguments at all", () => {
    expect(() => parseProvisionArgs([])).toThrow(/usage/);
  });

  it("refuses something that is not an email", () => {
    expect(() => parseProvisionArgs(["jack"])).toThrow(/not an email/);
  });
});

describe("the generated password", () => {
  it("is long, unpredictable and safe to paste", () => {
    const password = generatePassword();

    expect(password).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(password).not.toBe(generatePassword());
  });
});

describe("provisioning the single account", () => {
  let backend: AuthBackend;

  beforeEach(async () => {
    backend = await stubBackend();
  }, 30_000);

  afterEach(async () => {
    await backend.close();
  });

  it("creates the account and hands back the password once", async () => {
    const account = await provisionSingleAccount(
      backend.admin,
      "jack@example.com",
    );

    expect(account.email).toBe("jack@example.com");
    expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.password.length).toBeGreaterThan(39);
  });

  it("refuses to create a second one", async () => {
    await provisionSingleAccount(backend.admin, "jack@example.com");

    await expect(
      provisionSingleAccount(backend.admin, "someone-else@example.com"),
    ).rejects.toThrow(/already has an account \(jack@example\.com\)/);
  });
});
