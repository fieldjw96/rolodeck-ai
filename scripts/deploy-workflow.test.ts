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
 * alone, it migrates before it deploys, a failed step stops everything after it, and it
 * hands Vercel the same four variables `deploy-rolodeck.ps1` does. See docs/adr/0014.
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

  it("queues a second merge behind a run in progress rather than cancelling it", () => {
    // A cancelled run can stop between migrating and deploying.
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("migrates, then sets the environment, then deploys, then smoke tests", () => {
    const order = [
      "preflight",
      "link",
      "migrate",
      "environment",
      "deploy",
      "smoke",
    ].map(indexOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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

  it("sets exactly the four variables deploy-rolodeck.ps1 sets", () => {
    const { VERCEL_TOKEN, ...app } = step("environment").env ?? {};
    expect(VERCEL_TOKEN).toBe("${{ secrets.VERCEL_TOKEN }}");
    expect(app).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        "${{ secrets.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}",
      // Both pinned to the pooler, as the script does: Vercel's functions have no IPv6.
      DATABASE_URL: "${{ secrets.SUPABASE_POOLER_URL }}",
      SUPABASE_DB_URL: "${{ secrets.SUPABASE_POOLER_URL }}",
    });
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
      expect(s.run ?? "").not.toContain("SUPABASE_SECRET_KEY");
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
