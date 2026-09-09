import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { expect, test } from "@playwright/test";

import {
  signInForCookies,
  stubBackend,
  type AuthBackend,
  type CookiePair,
  type ThrowawayUser,
} from "../lib/auth/testing/auth-backend";
import { deckClientBundleGzipBytes } from "./support/bundle-size";
import { buildApp, getFreePort, startApp } from "./support/server";

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

/**
 * `/deck` sits behind Supabase Auth (docs/adr/0004), and CI has no Supabase project to sign
 * in against — same problem the integration tests solve with the in-process GoTrue stub in
 * `lib/auth/testing`. A browser test needs more than that stub alone: `NEXT_PUBLIC_SUPABASE_URL`
 * is inlined into the build by Next at compile time (see `lib/supabase/env.ts`), so pointing a
 * *running* app at the stub means building against it, which means this suite builds and
 * starts its own server rather than reusing whatever `npm run build` already produced.
 */
let backend: AuthBackend;
let user: ThrowawayUser;
let cookies: CookiePair[];
let server: ChildProcess;
let baseURL: string;

test.beforeAll(async () => {
  backend = await stubBackend();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: backend.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: backend.publishableKey,
  };

  buildApp(env);

  const port = await getFreePort();
  baseURL = `http://127.0.0.1:${String(port)}`;
  server = await startApp(env, port);

  user = await backend.createUser();
  cookies = await signInForCookies(backend, user);
});

test.afterAll(async () => {
  server.kill();
  await backend.deleteUser(user.id);
  await backend.close();
});

test("deck.tsx meets its performance budget", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies(
    cookies.map(({ name, value }) => ({ name, value, url: baseURL })),
  );

  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", NETWORK_CONDITIONS);
  await client.send("Emulation.setCPUThrottlingRate", {
    rate: CPU_THROTTLING_RATE,
  });

  await page.goto(`${baseURL}/deck`, { waitUntil: "load" });

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
