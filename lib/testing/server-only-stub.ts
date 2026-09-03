/**
 * Stands in for the `server-only` package under Vitest.
 *
 * That package resolves to a module that throws unless the bundler is using React's
 * `react-server` condition, which is how it turns "a client component imported this" into a
 * build error. Vitest is neither, so importing a server module in a test would throw for a
 * reason that has nothing to do with the test. Aliased in `vitest.config.mts`.
 *
 * The real enforcement is `next build`, which does apply the condition; the alias only makes
 * these modules testable. `lib/supabase/client-boundary.test.ts` separately asserts that the
 * modules that need the marker still carry it.
 */
export {};
