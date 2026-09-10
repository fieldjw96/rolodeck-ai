import { test as base } from "@playwright/test";

import {
  signInForCookies,
  stubBackend,
  type CookiePair,
} from "../../lib/auth/testing/auth-backend";
import { buildApp, getFreePort, startApp, stopApp } from "./server";

/** A built, running app with a session for a throwaway user already in hand. */
export type SignedInApp = {
  baseURL: string;
  cookies: CookiePair[];
};

/**
 * `/deck` sits behind Supabase Auth (docs/adr/0004), and CI has no Supabase project to sign
 * in against — the same problem the integration tests solve with the in-process GoTrue stub in
 * `lib/auth/testing`. A browser test needs more than that stub alone: `NEXT_PUBLIC_SUPABASE_URL`
 * is inlined into the build by Next at compile time (see `lib/supabase/env.ts`), so pointing a
 * *running* app at the stub means building against it, which means this suite builds and
 * starts its own server rather than reusing whatever `npm run build` already produced.
 *
 * Worker-scoped, so the specs in this directory share one build and one server rather than each
 * paying for a `next build` of its own. Every step of the teardown is nested inside the step it
 * undoes, so a setup that failed part-way still stops whatever it did manage to start.
 */
export const test = base.extend<object, { app: SignedInApp }>({
  app: [
    // The empty pattern is Playwright's own signature for a fixture that depends on no other
    // fixture: it reads the destructuring to decide what to inject.
    async ({}, provide) => {
      const backend = await stubBackend();

      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NEXT_PUBLIC_SUPABASE_URL: backend.url,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: backend.publishableKey,
        };

        await buildApp(env);

        const port = await getFreePort();
        const baseURL = `http://127.0.0.1:${String(port)}`;
        const server = await startApp(env, port);

        try {
          const user = await backend.createUser();

          try {
            await provide({
              baseURL,
              cookies: await signInForCookies(backend, user),
            });
          } finally {
            await backend.deleteUser(user.id);
          }
        } finally {
          await stopApp(server);
        }
      } finally {
        await backend.close();
      }
    },
    {
      scope: "worker",
      // Headroom over `buildApp`'s own 8-minute limit, so a slow cold build fails as "next
      // build did not finish", quoting the build, rather than as a bare fixture timeout that
      // names nothing.
      timeout: 12 * 60 * 1000,
    },
  ],
});

export { expect } from "@playwright/test";
