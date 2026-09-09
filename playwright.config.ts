import { defineConfig, devices } from "@playwright/test";

/**
 * A budget test, not a broad e2e suite: one spec, one Chromium project (CDP's network and
 * CPU throttling, which the Ticket asks for by name, is a Chromium-only API), and no
 * `webServer` entry because the spec builds and starts its own server against the in-process
 * Supabase Auth stub — see `e2e/deck-performance.spec.ts` for why a normal build cannot be
 * reused for that.
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
