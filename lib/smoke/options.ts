/**
 * The parts of the production smoke test worth testing on their own: what it was asked to
 * check, and how a set of results becomes an exit code. The browser driving lives in
 * `scripts/smoke.ts`, which is argv in, stdout out.
 */

export const DEFAULT_BASE_URL = "https://rolodeck-ai.vercel.app";

export type SmokeOptions = {
  baseUrl: string;
  email: string;
  password: string;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

/**
 * Reads the target and the credentials.
 *
 * The password is required from the environment and has no default. A smoke test that
 * silently falls back to a hardcoded credential is a credential in the repository, and this
 * one signs in to production.
 */
export function parseSmokeOptions(
  argv: string[],
  // Deliberately not NodeJS.ProcessEnv: this repo augments that type with keys the app
  // requires, and a smoke test should not have to satisfy them to read two of its own.
  env: Record<string, string | undefined>,
): SmokeOptions {
  const baseUrl = (
    argv[0] ??
    env.ROLODECK_SMOKE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(
      `base URL must start with http:// or https://, got "${baseUrl}"`,
    );
  }

  // Loading a local server over 127.0.0.1 rather than localhost makes Next refuse its own
  // dev chunks, so the page renders with no interactivity and every check below fails in a
  // way that looks exactly like a broken deployment. Caught here rather than discovered.
  if (baseUrl.includes("127.0.0.1")) {
    throw new Error(
      "use http://localhost instead of 127.0.0.1: Next blocks its own dev resources on the " +
        "latter, which looks like a broken build and is not one",
    );
  }

  const email = env.ROLODECK_SMOKE_EMAIL;
  if (email === undefined || email === "") {
    throw new Error("set ROLODECK_SMOKE_EMAIL to the account to sign in as");
  }

  const password = env.ROLODECK_SMOKE_PASSWORD;
  if (password === undefined || password === "") {
    throw new Error(
      "set ROLODECK_SMOKE_PASSWORD; this script never carries a default",
    );
  }

  return { baseUrl, email, password };
}

/** One line per check, then a verdict. Exit code is 0 only when every check passed. */
export function summarise(results: CheckResult[]): {
  text: string;
  exitCode: number;
} {
  const lines = results.map(
    (r) => `  ${r.ok ? "ok  " : "FAIL"}  ${r.name}: ${r.detail}`,
  );
  const failed = results.filter((r) => !r.ok);

  lines.push(
    "",
    failed.length === 0
      ? `All ${results.length} checks passed.`
      : `${failed.length} of ${results.length} checks failed: ${failed.map((r) => r.name).join(", ")}`,
  );

  // No results at all is a failure. A smoke test that checked nothing and said so cheerfully
  // is worse than one that errors, because it reads as a healthy deployment.
  const exitCode = results.length === 0 || failed.length > 0 ? 1 : 0;
  return { text: lines.join("\n"), exitCode };
}

/** Redacts a secret from text before it is printed or logged. */
export function redact(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("[redacted]");
}
