import { defineConfig, devices } from "@playwright/test";

/**
 * A budget and a layout check, not a broad e2e suite: two specs, one Chromium project (CDP's
 * network and CPU throttling, which Ticket #16 asks for by name, is a Chromium-only API), and
 * no `webServer` entry because the suite builds and starts its own server against the
 * in-process Supabase Auth stub — see `e2e/support/signed-in-app.ts` for why a normal build
 * cannot be reused for that. The fixture there is worker-scoped, so the two specs share one
 * build between them.
 */
export default defineConfig({
  testDir: "./e2e",
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
