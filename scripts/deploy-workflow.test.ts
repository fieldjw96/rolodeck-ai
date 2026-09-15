import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { DEFAULT_BASE_URL } from "../lib/smoke/options";

/**
 * Ticket #137: the production deploy workflow's guarantees, asserted against the file itself.
 *
 * The workflow writes to the production database with nobody watching, so the properties
 * that make that safe are checked here rather than left to a comment: it runs for `main`
 * alone, and for the tip of `main` alone, it migrates before it deploys, a failed step stops
 * everything after it, no secret is present while dependencies install, and it hands Vercel
 * the three variables the running app reads and no others. See docs/adr/0014.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const stringMap = z.record(z.string(), z.string());

const stepSchema = z.object({
  id: z.string(),
  name: z.string(),
  if: z.string().optional(),
  run: z.string().optional(),
  env: stringMap.optional(),
  "continue-on-error": z.unknown().optional(),
});

const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  env: stringMap.optional(),
  concurrency: z.object({
    group: z.string(),
    "cancel-in-progress": z.boolean(),
  }),
  jobs: z.record(
    z.string(),
    z.object({
      if: z.string(),
      environment: z.string(),
      env: stringMap.optional(),
      steps: z.array(stepSchema),
    }),
  ),
});

const workflow = workflowSchema.parse(
  parse(read("../.github/workflows/deploy.yml")),
);

const jobs = Object.values(workflow.jobs);
const job = jobs[0]!;
type Step = z.infer<typeof stepSchema>;

function step(id: string): Step {
  const found = job.steps.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no step with id "${id}"`);
  return found;
}

const indexOf = (id: string): number => job.steps.indexOf(step(id));

/** The one place a run may name either credential: the loop that fails if Vercel holds it. */
const FORBIDDEN_IN_VERCEL =
  "for name in SUPABASE_SECRET_KEY SUPABASE_DB_URL; do";

describe("the production deploy workflow", () => {
  it("has exactly one job, so the ordering below is the whole story", () => {
    expect(jobs).toHaveLength(1);
  });

  it("is triggered by a push to main and by nothing else", () => {
    expect(workflow.on).toEqual({ push: { branches: ["main"] } });
  });

  it("refuses to run for any other ref even if a trigger is added later", () => {
    // Exact, not `toContain`: `... || true` would contain the right words and guard nothing.
    expect(job.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
  });

  it("runs in the production environment, whose secrets are restricted to main", () => {
    expect(job.environment).toBe("production");
  });

  it("hands secrets only to the steps that name them", () => {
    expect(JSON.stringify(workflow.env ?? {})).not.toContain("secrets.");
    expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
  });

  it("gives the checkout, setup, install and browser steps no env at all", () => {
    // `npm ci` and `playwright install` run code nobody here reviewed. No `env` at all, not
    // merely none naming a secret, so nothing can be slipped in beside them later.
    for (const id of ["checkout", "setup_node", "install", "browsers"]) {
      expect(step(id).env, `step "${id}" must have no env`).toBeUndefined();
    }
    const firstWithEnv = job.steps.findIndex((s) => s.env !== undefined);
    expect(firstWithEnv).toBeGreaterThan(indexOf("browsers"));
  });

  it("runs the Vercel CLI from the lockfile, never through npx", () => {
    // npx pins only the top-level package; its dependencies resolve unlocked, and their install
    // scripts would run inside a step holding VERCEL_TOKEN.
    const pkg = z
      .object({ devDependencies: z.object({ vercel: z.string() }) })
      .parse(JSON.parse(read("../package.json")));
    expect(pkg.devDependencies.vercel).toMatch(/^\d+\.\d+\.\d+$/);

    const lock = z
      .object({
        packages: z.object({
          "node_modules/vercel": z.object({ version: z.string() }),
        }),
      })
      .parse(JSON.parse(read("../package-lock.json")));
    expect(lock.packages["node_modules/vercel"].version).toBe(
      pkg.devDependencies.vercel,
    );

    // Every invocation, skipping `echo` lines, where a command is advice to a human.
    const calls = job.steps
      .flatMap((s) => (s.run ?? "").split("\n"))
      .filter((line) => !/^\s*echo\b/.test(line))
      .flatMap((line) =>
        [...line.matchAll(/[^\s(]*vercel(@\S*)? (deploy|env)\b/g)].map(
          (match) => match[0],
        ),
      );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/^\.\/node_modules\/\.bin\/vercel (deploy|env)$/);
    }
    for (const s of job.steps) {
      // Case-insensitive, so `npx "$VERCEL_CLI"` is caught as well as `npx vercel@...`.
      expect(s.run ?? "").not.toMatch(/npx[^\n]*vercel/i);
    }
    expect(job.env ?? {}).not.toHaveProperty("VERCEL_CLI");
  });

  it("checks the commit is still the tip of main before migrating and again before deploying", () => {
    // A re-run keeps the original commit, so without this it would deploy old code behind the
    // newer schema, and drizzle, which only applies newer migrations, would not notice.
    const before = step("tip_before_migrate");
    const again = step("tip_before_deploy");
    expect(again.run).toBe(before.run);
    expect(before.run).toContain(
      "git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main",
    );
    expect(before.run).toContain('if [ "$main_sha" != "$GITHUB_SHA" ]; then');
    // Both SHAs named in the failure, so the log says which run to re-run instead.
    expect(before.run).toMatch(/::error::.*\$GITHUB_SHA.*\$main_sha/);
    for (const s of [before, again]) {
      expect(s.env, `step "${s.id}" must hold no secret`).toBeUndefined();
    }

    // Before any step that holds a secret, so a stale run sets nothing in Vercel either.
    const firstWithEnv = job.steps.findIndex((s) => s.env !== undefined);
    expect(indexOf("tip_before_migrate")).toBeLessThan(firstWithEnv);
  });

  it("queues a second merge behind a run in progress rather than cancelling it", () => {
    // A cancelled run can stop between migrating and deploying.
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("sets the environment, then migrates, then deploys, then smoke tests", () => {
    const order = [
      "tip_before_migrate",
      "preflight",
      "link",
      "environment",
      "migrate",
      "tip_before_deploy",
      "deploy",
      "smoke",
    ].map(indexOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts nothing between the migration and the deploy but the tip-of-main check", () => {
    // Once the schema has moved, anything that fails before the deploy strands it ahead of the
    // running code. The check is the one exception, and it is deliberate.
    const between = job.steps
      .slice(indexOf("migrate") + 1, indexOf("deploy"))
      .map((s) => s.id);
    expect(between).toEqual(["tip_before_deploy"]);
  });

  it("lets nothing run after a failed step except the failure report", () => {
    const last = job.steps.at(-1)!;
    expect(last.id).toBe("report");
    // `cancelled()` too: `timeout-minutes` cancels the job rather than failing it, and a run
    // that hangs after migrating is the one that most needs reporting.
    expect(last.if).toBe("failure() || cancelled()");

    for (const s of job.steps.slice(0, -1)) {
      expect(s.if, `step "${s.id}" must not have an if:`).toBeUndefined();
      expect(
        s["continue-on-error"],
        `step "${s.id}" must not continue on error`,
      ).toBeUndefined();
    }
  });

  it("names every step in the failure report, so the issue says which one broke", () => {
    const failedStep = step("report").env?.FAILED_STEP ?? "";
    for (const s of job.steps.slice(0, -1)) {
      // A step stopped by a timeout has the outcome `cancelled`, not `failure`.
      expect(failedStep).toContain(
        `(steps.${s.id}.outcome == 'failure' || steps.${s.id}.outcome == 'cancelled') && '${s.name}'`,
      );
    }
  });

  it("migrates with the migration credential and never applies the test shim", () => {
    const migrate = step("migrate");
    expect(migrate.run).toBe("npm run db:migrate");
    expect(migrate.env).toEqual({
      DATABASE_URL: "${{ secrets.MIGRATION_DATABASE_URL }}",
    });
    for (const s of job.steps) {
      expect(s.run ?? "").not.toContain("supabase-shim");
    }
  });

  it("sets exactly the three variables the running app reads", () => {
    const environment = step("environment");
    const { VERCEL_TOKEN, ...app } = environment.env ?? {};
    expect(VERCEL_TOKEN).toBe("${{ secrets.VERCEL_TOKEN }}");
    expect(app).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        "${{ secrets.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}",
      // The pooler, as the script does: Vercel's functions have no IPv6.
      DATABASE_URL: "${{ secrets.SUPABASE_POOLER_URL }}",
    });

    const set = [
      ...(environment.run ?? "").matchAll(/^\s*set_var (\w+) /gm),
    ].map((match) => match[1]);
    expect(set).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "DATABASE_URL",
    ]);
  });

  it("fails before setting anything if Vercel holds a credential the app does not read", () => {
    const run = step("environment").run ?? "";
    const listed = run.indexOf(
      "listed=$(./node_modules/.bin/vercel env ls production 2>&1)",
    );
    const forbidden = run.indexOf(FORBIDDEN_IN_VERCEL);
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(forbidden).toBeGreaterThan(listed);
    expect(forbidden).toBeLessThan(
      run.indexOf("set_var NEXT_PUBLIC_SUPABASE_URL"),
    );
    // Names only: the listing is searched and never echoed.
    expect(run).not.toMatch(/echo[^\n]*\$listed/);
  });

  it("names no secret beyond the ones ADR 0014 lets the production environment hold", () => {
    // CLAUDE.md and ADR 0013 allow one database credential in Actions, ingest's; ADR 0014 widens
    // that by exactly the two below. Anything more needs another ADR, not an edit here alone.
    const named = new Set(
      [
        ...read("../.github/workflows/deploy.yml").matchAll(/secrets\.(\w+)/g),
      ].map((match) => match[1]),
    );
    expect([...named].sort()).toEqual(
      [
        "MIGRATION_DATABASE_URL",
        "SUPABASE_POOLER_URL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "VERCEL_TOKEN",
        "ROLODECK_SMOKE_EMAIL",
        "ROLODECK_SMOKE_PASSWORD",
      ].sort(),
    );
  });

  it("never gives any step the secret key, which the running app does not read", () => {
    for (const s of job.steps) {
      expect(JSON.stringify(s.env ?? {})).not.toContain("SUPABASE_SECRET_KEY");
      expect(JSON.stringify(s.env ?? {})).not.toContain("SUPABASE_DB_URL");
      // Named only where the environment step refuses to find it in Vercel.
      const run = (s.run ?? "").replace(FORBIDDEN_IN_VERCEL, "");
      expect(run).not.toContain("SUPABASE_SECRET_KEY");
      expect(run).not.toContain("SUPABASE_DB_URL");
    }
  });

  it("smoke tests the production URL the smoke test itself defaults to", () => {
    expect(job.env?.PRODUCTION_URL).toBe(DEFAULT_BASE_URL);
    expect(step("smoke").run).toBe('npm run smoke -- "$PRODUCTION_URL"');
  });
});

describe("vercel.json", () => {
  it("stops Vercel's Git integration deploying on push, even if it is reconnected", () => {
    const config = z
      .object({ git: z.object({ deploymentEnabled: z.literal(false) }) })
      .safeParse(JSON.parse(read("../vercel.json")));
    expect(config.success).toBe(true);
  });
});
