import { defineConfig, devices } from "@playwright/test";

/**
 * A budget and a layout check, not a broad e2e suite: two specs, one Chromium project (CDP's
 * network and CPU throttling, which Ticket #16 asks for by name, is a Chromium-only API), and
 * no `webServer` entry because the suite builds and starts its own server against the
 * in-process Supabase Auth stub — see `e2e/support/signed-in-app.ts` for why a normal build
 * cannot be reused for that. The fixture there is worker-scoped, so the two specs share one
 * build between them.
 *
 * `swipe-flow.spec.ts` and `onboarding.spec.ts` are deliberately not among these specs, and run
 * instead under `playwright.db.config.ts` and the `e2e-db` CI job. That split used to be about
 * the database: those two assert against a real Postgres (Tickets #13 and #191) and this
 * config's server had none. **This config's server now needs one too.** Ticket #191 put the
 * first-run check on the `(app)` layout, which reads the User Profile on the server, and no
 * amount of `page.route` interception can answer a query that never leaves the server — without
 * a database every page in the group redirects to `/onboarding`, and these specs find nothing
 * they look for.
 *
 * So the split is now about what each suite asserts rather than what it can reach.
 * `e2e/support/signed-in-app.ts` hands its throwaway User an empty User Profile, so they read as
 * already asked and these specs can get on with the Deck, the Diary, the Watchlist and the
 * layout. `onboarding.spec.ts` is the suite that must *not* have that row written for it, which
 * is the one reason it cannot live here. The setup both share is
 * `e2e/support/scratch-database.ts`.
 *
 * The `perf` CI job provisions a Postgres the same way `e2e-db` and `migrate` do.
 */
export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["swipe-flow.spec.ts", "onboarding.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  // The suite's own beforeAll builds the app with Turbopack before it starts the server,
  // which is most of this: comfortably longer than Playwright's 30s default. The hook raises
  // its own budget past this again — see `deck-performance.spec.ts`.
  timeout: 5 * 60 * 1000,
  // The outermost bound, under the `perf` job's own `timeout-minutes`. Every layer inside this
  // one already fails with a message; this is what guarantees the *run* does too. A job killed
  // by GitHub's timeout is reported with no Playwright output at all, which is a red check
  // whose log says nothing about why — the failure this suite has already cost a cycle on.
  globalTimeout: 20 * 60 * 1000,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
