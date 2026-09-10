import path from "node:path";

import { deckClientBundleGzipBytes } from "./support/bundle-size";
import { expect, test } from "./support/signed-in-app";

/** Playwright's own budget for the Ticket, in milliseconds. */
const FCP_BUDGET_MS = 2500;

/** Playwright's own budget for the Ticket, in gzipped bytes. */
const BUNDLE_BUDGET_BYTES = 250 * 1024;

/**
 * Lighthouse's "Slow 4G" mobile preset: 150ms round-trip latency, 1.6Mbps down, 750Kbps up.
 * Chosen because it is a well-known, externally defined throttle rather than one tuned to
 * make this app's own numbers look good.
 */
const NETWORK_CONDITIONS = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
};

/** Also Lighthouse's mobile default: a 4x slowdown against this machine's CPU. */
const CPU_THROTTLING_RATE = 4;

const NEXT_DIR = path.join(process.cwd(), ".next");

test("deck.tsx meets its performance budget", async ({ browser, app }) => {
  const context = await browser.newContext();
  await context.addCookies(
    app.cookies.map(({ name, value }) => ({ name, value, url: app.baseURL })),
  );

  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", NETWORK_CONDITIONS);
  await client.send("Emulation.setCPUThrottlingRate", {
    rate: CPU_THROTTLING_RATE,
  });

  await page.goto(`${app.baseURL}/deck`, { waitUntil: "load" });

  // A redirect back to `/login` would mean the stub sign-in failed, and every FCP measured
  // from there on would be timing the wrong page.
  expect(new URL(page.url()).pathname).toBe("/deck");

  const fcp = await page.evaluate(() => {
    const entry = performance
      .getEntriesByType("paint")
      .find((candidate) => candidate.name === "first-contentful-paint");
    return entry?.startTime ?? null;
  });

  await context.close();

  expect(fcp, "no first-contentful-paint entry was recorded").not.toBeNull();
  expect(fcp).toBeLessThan(FCP_BUDGET_MS);

  expect(deckClientBundleGzipBytes(NEXT_DIR)).toBeLessThan(BUNDLE_BUDGET_BYTES);
});
