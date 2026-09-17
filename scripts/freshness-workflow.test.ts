// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { SCHEDULE_GRACE_MS } from "../lib/ingest/freshness";
import { ingestSources } from "../lib/ingest/workflow-schedules";

/**
 * Ticket #165: the freshness checker's guarantees, asserted against the workflow file itself,
 * the way `deploy-workflow.test.ts` asserts the deploy's.
 *
 * Two properties are worth holding here. It asks for only the permissions it needs, because a
 * workflow that opens issues with a token that could also push is a wider blast radius than the
 * job warrants. And it stays thin: the moment logic moves into a `run:` block it stops being
 * covered by `npm test`, which is how the failure-reporting step in `ingest-run.yml` came to be
 * wrong and stay wrong.
 */

const WORKFLOW_DIRECTORY = fileURLToPath(
  new URL("../.github/workflows/", import.meta.url),
);

const read = (name: string): string =>
  readFileSync(`${WORKFLOW_DIRECTORY}${name}`, "utf8");

const CHECK_SCRIPT = "npm run check:ingest-freshness";

const workflowSchema = z.object({
  on: z.object({
    schedule: z.array(z.object({ cron: z.string() })).min(1),
    workflow_dispatch: z.unknown(),
  }),
  concurrency: z.object({
    group: z.string(),
    "cancel-in-progress": z.boolean(),
  }),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(
    z.string(),
    z.object({
      "runs-on": z.string(),
      steps: z.array(
        z.looseObject({
          uses: z.string().optional(),
          run: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
        }),
      ),
    }),
  ),
});

const workflow = workflowSchema.parse(parse(read("ingest-freshness.yml")));

const jobs = Object.values(workflow.jobs);
const job = jobs[0]!;
const runs = job.steps.map((step) => step.run?.trim()).filter(Boolean);

/** Minutes past midnight UTC, for a cron whose minute and hour are both plain numbers. */
function minutesPastMidnight(cron: string): number {
  const [minute, hour] = cron.trim().split(/\s+/);

  return Number(hour) * 60 + Number(minute);
}

describe("the ingest freshness workflow", () => {
  it("is one job", () => {
    expect(jobs).toHaveLength(1);
  });

  it("asks for reading the repository and Actions, and writing issues, and nothing else", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      issues: "write",
    });
  });

  it("can be run by hand, since the first thing anyone does with a stale report is re-run it", () => {
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });

  it("serialises its own runs, as every ingest workflow does", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("checks out, installs, and runs one npm script — no logic in the YAML", () => {
    expect(runs).toEqual(["npm ci", CHECK_SCRIPT]);

    expect(job.steps.map((step) => step.uses).filter(Boolean)).toEqual([
      "actions/checkout@v6",
      "actions/setup-node@v5",
    ]);
  });

  it("hands the job token to the one step that needs it, and to no other", () => {
    expect(
      job.steps
        .filter((step) => step.env?.["GITHUB_TOKEN"] !== undefined)
        .map((step) => step.run?.trim()),
    ).toEqual([CHECK_SCRIPT]);
  });

  it("runs daily, late enough to reach a verdict on every Source the same day", () => {
    // A Source cannot be judged until its own occurrence plus the grace has passed. A check
    // scheduled before that is not wrong — the rule is absolute, so the Source is simply
    // reported a day later — but it is a day of latency nobody chose. Both schedules are read
    // from the files rather than restated, so a Source added at a later hour says so here.
    const checkCrons = workflow.on.schedule.map((entry) => entry.cron);

    expect(checkCrons).toHaveLength(1);
    expect(checkCrons[0]!.trim().split(/\s+/).slice(2).join(" ")).toBe("* * *");

    const latestSourceMinutes = Math.max(
      ...ingestSources(
        readdirSync(WORKFLOW_DIRECTORY)
          .filter((name) => /\.ya?ml$/.test(name))
          .map((name) => ({
            path: `.github/workflows/${name}`,
            text: read(name),
          })),
      ).flatMap((source) => source.crons.map(minutesPastMidnight)),
    );

    expect(minutesPastMidnight(checkCrons[0]!)).toBeGreaterThanOrEqual(
      latestSourceMinutes + SCHEDULE_GRACE_MS / 60_000,
    );
  });
});
