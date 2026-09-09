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
  // which is most of this: comfortably longer than Playwright's 30s default.
  timeout: 5 * 60 * 1000,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
