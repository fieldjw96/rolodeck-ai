// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generatePassword,
  parseProvisionArgs,
  provisionAccount,
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

describe("provisioning the smoke-test account", () => {
  let backend: AuthBackend;

  beforeEach(async () => {
    backend = await stubBackend();
  }, 30_000);

  afterEach(async () => {
    await backend.close();
  });

  it("creates the account and hands back the password once", async () => {
    const account = await provisionAccount(backend.admin, "smoke@example.com");

    expect(account.email).toBe("smoke@example.com");
    expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.password.length).toBeGreaterThan(39);
    expect(account.rotated).toBe(false);
  });

  it("rotates the password of an address that already has one, rather than refusing", async () => {
    const first = await provisionAccount(backend.admin, "smoke@example.com");
    const second = await provisionAccount(backend.admin, "smoke@example.com");

    expect(second.rotated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.password).not.toBe(first.password);
  });

  it("signs in with the rotated password and not the old one", async () => {
    const { email } = await provisionAccount(backend.admin, "smoke@example.com");
    const stale = (await provisionAccount(backend.admin, email)).password;
    const current = (await provisionAccount(backend.admin, email)).password;

    const client = createClient(backend.url, backend.publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    await expect(
      client.auth.signInWithPassword({ email, password: stale }),
    ).resolves.toMatchObject({ error: expect.anything() });
    await expect(
      client.auth.signInWithPassword({ email, password: current }),
    ).resolves.toMatchObject({ data: { user: { email } } });
  });

  /**
   * The rule this used to enforce. Sign-up is open now (docs/adr/0020), so a project with
   * accounts in it is the normal state and the old refusal would have fired on the first
   * stranger who signed in with Google.
   */
  it("creates a second account without complaint", async () => {
    await provisionAccount(backend.admin, "someone@example.com");
    const second = await provisionAccount(backend.admin, "smoke@example.com");

    expect(second.rotated).toBe(false);
    expect(second.email).toBe("smoke@example.com");
  });
});
