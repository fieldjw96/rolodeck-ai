import { chromium, type Page } from "@playwright/test";

import {
  parseSmokeOptions,
  summarise,
  redact,
  type CheckResult,
} from "../lib/smoke/options";

/**
 * A read-only smoke test against a deployed Rolodeck.
 *
 *     ROLODECK_SMOKE_EMAIL=... ROLODECK_SMOKE_PASSWORD=... npm run smoke
 *     ... npm run smoke -- http://localhost:3000
 *
 * **It writes nothing.** It signs in and reads; it never Keeps or Passes a Company Profile.
 * That is the whole point of it existing separately from the e2e suite: `test:e2e:db` runs
 * against a throwaway Postgres and a throwaway user and may do what it likes, whereas this
 * runs against the real deployment and the real account. Four Company Profiles reached Jack's
 * Watchlist because an earlier ad-hoc version of this script clicked Keep on every run.
 *
 * What it is actually for is the class of failure that tests and review cannot see, because
 * it is invisible in a diff and only exists once the thing is deployed. Both of the
 * deployment's real bugs were of that kind: a UTF-8 BOM prepended to an environment variable,
 * and a database host that resolves locally but not from a serverless function.
 */
async function check(
  name: string,
  fn: () => Promise<string>,
): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return {
      name,
      ok: false,
      detail:
        error instanceof Error ? error.message.split("\n")[0]! : String(error),
    };
  }
}

async function textOf(page: Page): Promise<string> {
  return ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
}

async function main(): Promise<void> {
  const options = parseSmokeOptions(process.argv.slice(2), process.env);
  console.log(
    `Smoke testing ${options.baseUrl} as ${options.email} (read-only)`,
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  const results: CheckResult[] = [];

  try {
    results.push(
      await check("login page renders", async () => {
        await page.goto(`${options.baseUrl}/login`, {
          waitUntil: "networkidle",
        });
        const email = page.locator('input[name="email"]');
        if ((await email.count()) === 0)
          throw new Error("no email field on /login");
        return await page.title();
      }),
    );

    results.push(
      await check("sign in lands on the Deck", async () => {
        await page.fill('input[name="email"]', options.email);
        await page.fill('input[name="password"]', options.password);
        await Promise.all([
          page.waitForURL((u) => !u.pathname.startsWith("/login"), {
            timeout: 30_000,
          }),
          page.click('button[type="submit"]'),
        ]);
        const path = new URL(page.url()).pathname;
        // Not merely "left /login": an error redirect also leaves it.
        if (path !== "/deck")
          throw new Error(`landed on ${path}, expected /deck`);
        return path;
      }),
    );

    results.push(
      await check("Deck answers from Postgres", async () => {
        await page.goto(`${options.baseUrl}/deck`, {
          waitUntil: "networkidle",
        });
        await page.waitForTimeout(2_000);
        const body = await textOf(page);

        // The failure this exists to catch. When the database is unreachable the page still
        // renders its shell and returns 200, so only the error copy distinguishes a healthy
        // deployment from one that cannot reach Postgres at all.
        if (/Couldn.t load the Deck/i.test(body)) {
          throw new Error(
            "the Deck reported it could not load: the app cannot reach Postgres",
          );
        }

        // An exhausted Deck is a healthy answer, not a failure. Requiring a dealt Company
        // Profile would turn this check red the day the last one is judged, on a deployment
        // with nothing wrong with it. The Gate caught this on PR #129; the question the
        // check is actually asking is whether the Deck reached the database and said
        // something, not whether the database happened to have a row left.
        if (/No Profiles left in the Deck/i.test(body))
          return "empty Deck, which is healthy";

        if (/Dealing the Deck/i.test(body)) {
          throw new Error("the Deck is still on its loading state after 2s");
        }

        const keep = page.getByRole("button", { name: /keep/i });
        if ((await keep.count()) === 0) {
          throw new Error(
            "the Deck rendered neither a Company Profile, an empty state, nor an error",
          );
        }
        return `dealt: ${body.slice(0, 50).trim()}...`;
      }),
    );

    results.push(
      await check("Watchlist renders", async () => {
        await page.goto(`${options.baseUrl}/watchlist`, {
          waitUntil: "networkidle",
        });
        await page.waitForTimeout(2_000);

        // Assert we are still on the page we asked for. Without this the check passes while
        // signed out, because the gate redirects to /login and a login page contains none of
        // the error copy below. Found by running the script with a deliberately wrong
        // password and watching this check report ok.
        const path = new URL(page.url()).pathname;
        if (path !== "/watchlist") {
          throw new Error(
            `redirected to ${path}, so the session was not established`,
          );
        }

        const body = await textOf(page);
        if (/Couldn.t load the Watchlist/i.test(body)) {
          throw new Error("the Watchlist reported it could not load");
        }
        if (/Loading Watchlist/i.test(body)) {
          throw new Error(
            "the Watchlist is still on its loading state after 2s",
          );
        }
        return "rendered";
      }),
    );
  } finally {
    await browser.close();
  }

  const { text, exitCode } = summarise(results);
  console.log(redact(text, options.password));
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
