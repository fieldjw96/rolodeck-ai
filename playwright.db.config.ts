import { defineConfig, devices } from "@playwright/test";

/**
 * Ticket #13's suite, plus Ticket #191's, Ticket #230's and Ticket #231's: specs that assert
 * against a real Postgres, not the GoTrue-stub-only server `playwright.config.ts` builds. The
 * swipe-by-drag spec is here because it finishes on the Watchlist, which is a real read of a
 * real Keep rather than anything a `page.route` stub could answer. Kept as its own
 * config, rather than a second project in that one, so `npm run test:e2e` — what the `perf`
 * job runs, with no Postgres available to it — never picks these specs up by accident. The
 * `e2e-db` CI job provisions the Postgres this needs the same way the `migrate` job does, then
 * runs `npm run test:e2e:db`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "swipe-flow.spec.ts",
    "onboarding.spec.ts",
    "watchlist-pass.spec.ts",
    "deck-swipe.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  // Same reasoning as `playwright.config.ts`: comfortably past `buildApp`'s own 8-minute limit.
  timeout: 5 * 60 * 1000,
  globalTimeout: 20 * 60 * 1000,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
