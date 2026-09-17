/**
 * Notices an ingest Source that never ran.
 *
 * `ingest-run.yml` opens an issue when a run fails, so a Source that breaks loudly is already
 * reported. This is the other half: a Source whose scheduled run simply never happened produces
 * no run, no failure and no issue, and reads exactly like a quiet week. GitHub's scheduler is
 * best-effort by its own documentation — delayed under load, occasionally dropped, and disabled
 * outright after a period of repository inactivity, which would stop every Source at once.
 *
 * This file is the edge: environment in, GitHub's API out, and an issue. Which Sources exist and
 * how often each should run come from the workflow files themselves (`lib/ingest/workflow-schedules.ts`),
 * and whether one is late is decided by a pure function tested offline (`lib/ingest/freshness.ts`).
 * Nothing here decides anything, which is why `.github/workflows/ingest-freshness.yml` can be
 * three steps of YAML instead of a shell script nobody can test.
 *
 * Run by `.github/workflows/ingest-freshness.yml`, or by hand against any repository:
 *
 *     GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/name npm run check:ingest-freshness
 *
 * Exits non-zero only when the check itself could not be carried out. A Source found late is
 * reported by opening or commenting on its issue and is not a failure of this run: red here
 * means the checker is broken, which is a different thing to look at than a dead Source.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { parseEnv } from "../lib/env/parse-env";
import {
  describeLateSource,
  judgeFreshness,
  lateSourceIssueBody,
  lateSourceIssueTitle,
  type LateSourceReport,
} from "../lib/ingest/freshness";
import {
  ingestSources,
  type IngestSource,
  type WorkflowFile,
} from "../lib/ingest/workflow-schedules";

const WORKFLOW_DIRECTORY = ".github/workflows";

const environmentSchema = z.object({
  /** The job token. `actions: read` to see run history, `issues: write` to report. */
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/, {
    error: "must be owner/name, as GitHub Actions sets it",
  }),
  /** Both set by Actions; defaulted so the script runs against github.com from a laptop too. */
  GITHUB_API_URL: z.url().default("https://api.github.com"),
  GITHUB_SERVER_URL: z.url().default("https://github.com"),
});

/**
 * GitHub's API is external and therefore hostile in the sense CLAUDE.md means: a field that has
 * changed shape must fail here, naming itself, rather than propagate `undefined` into a date and
 * make every Source look like it has never run. Only the fields used are named; the rest of each
 * response is ignored rather than refused.
 */
const workflowSchema = z.object({
  /** `active`, `disabled_manually` or `disabled_inactivity` — the last is what inactivity does. */
  state: z.string().min(1),
  /** Offsets as well as `Z`: the workflows endpoint returns both. */
  created_at: z.iso.datetime({ offset: true }),
});

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      /** When the run finished, which is when the Source last actually succeeded. */
      updated_at: z.iso.datetime({ offset: true }),
    }),
  ),
});

const issuesSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    /** Present on pull requests, which this endpoint also returns. */
    pull_request: z.unknown().optional(),
  }),
);

type Environment = z.infer<typeof environmentSchema>;

async function callGitHub(
  environment: Environment,
  route: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${environment.GITHUB_API_URL}${route}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${environment.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });

  if (!response.ok) {
    // The token is never in the message: the route and the status are what say what went wrong.
    throw new Error(
      `GitHub returned ${response.status} for ${init.method ?? "GET"} ${route}: ` +
        `${(await response.text()).slice(0, 400)}`,
    );
  }

  return response.json();
}

/** Every `.yml` and `.yaml` file in `.github/workflows/`, repo-relative and slash-separated. */
async function readWorkflowFiles(): Promise<WorkflowFile[]> {
  const entries = await readdir(WORKFLOW_DIRECTORY, { withFileTypes: true });

  return Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && /\.ya?ml$/.test(entry.name.toLowerCase()),
      )
      .map(async (entry) => ({
        path: `${WORKFLOW_DIRECTORY}/${entry.name}`,
        text: await readFile(path.join(WORKFLOW_DIRECTORY, entry.name), "utf8"),
      })),
  );
}

type SourceHistory = {
  workflowState: string;
  workflowCreatedAt: Date;
  lastSuccessAt: Date | null;
  runsUrl: string;
};

/**
 * What GitHub knows about one Source: when its workflow first existed, and when a run of it last
 * completed successfully. Fetching, and nothing else — the judging happens in `main`.
 *
 * `created_at` on the workflow rather than the file's first commit: it is what GitHub itself
 * dates the workflow from, it is already in this response, and it needs no git history, which a
 * default Actions checkout does not have.
 *
 * Any trigger counts as a success, not only `schedule`. A Source someone ran by hand this morning
 * has run, and the question asked here is whether it ran at all.
 */
async function fetchSourceHistory(
  environment: Environment,
  source: IngestSource,
): Promise<SourceHistory> {
  const file = encodeURIComponent(path.posix.basename(source.workflowPath));
  const base = `/repos/${environment.GITHUB_REPOSITORY}/actions/workflows/${file}`;

  const workflow = workflowSchema.parse(await callGitHub(environment, base));
  const runs = runsSchema.parse(
    await callGitHub(environment, `${base}/runs?status=success&per_page=1`),
  );

  const latest = runs.workflow_runs[0];

  return {
    workflowState: workflow.state,
    workflowCreatedAt: new Date(workflow.created_at),
    lastSuccessAt: latest === undefined ? null : new Date(latest.updated_at),
    // Built rather than taken from the workflow's own `html_url`, which points at the YAML file
    // on the default branch. A reader following this link wants the run history.
    runsUrl: `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/workflows/${file}`,
  };
}

/**
 * The open issue with exactly this title, if there is one.
 *
 * Listed and compared rather than searched. `ingest-run.yml` uses `gh issue list --search` and
 * then filters for an exact title for the same reason — GitHub's search matches words, not
 * strings, so "Ingest Source has not run: news" would otherwise find the issue for `news-x` too.
 * The list endpoint also has no search index to lag behind an issue opened minutes ago.
 */
async function findOpenIssue(
  environment: Environment,
  title: string,
): Promise<number | null> {
  const perPage = 100;

  for (let page = 1; page <= 10; page += 1) {
    const issues = issuesSchema.parse(
      await callGitHub(
        environment,
        `/repos/${environment.GITHUB_REPOSITORY}/issues?state=open&per_page=${perPage}&page=${page}`,
      ),
    );

    const match = issues.find(
      (issue) => issue.pull_request === undefined && issue.title === title,
    );

    if (match !== undefined) {
      return match.number;
    }

    if (issues.length < perPage) {
      return null;
    }
  }

  return null;
}

/**
 * One open issue per Source, commented on rather than duplicated while the Source is still late.
 * The same convention as the "Open or update an issue for a failed run" step in
 * `ingest-run.yml`: a Source dead for a week is one issue to read, not seven to ignore.
 */
async function report(
  environment: Environment,
  late: LateSourceReport,
): Promise<void> {
  const title = lateSourceIssueTitle(late.source.name);
  const existing = await findOpenIssue(environment, title);
  const issues = `/repos/${environment.GITHUB_REPOSITORY}/issues`;

  if (existing === null) {
    await callGitHub(environment, issues, {
      method: "POST",
      body: JSON.stringify({ title, body: lateSourceIssueBody(late) }),
    });

    console.log(`  opened an issue: ${title}`);
    return;
  }

  await callGitHub(environment, `${issues}/${existing}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: `Still late. ${describeLateSource(late)}` }),
  });

  console.log(`  commented on issue #${existing}: ${title}`);
}

async function main(): Promise<void> {
  // `parseEnv` rather than a bare `parse`: it reports the variable's name and what is wrong with
  // it and never its value, and one of these is a token. The two optional variables are omitted
  // rather than passed as undefined, so their defaults apply off a runner.
  const environment = parseEnv(
    environmentSchema,
    {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
      ...(process.env.GITHUB_API_URL === undefined
        ? {}
        : { GITHUB_API_URL: process.env.GITHUB_API_URL }),
      ...(process.env.GITHUB_SERVER_URL === undefined
        ? {}
        : { GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL }),
    },
    "The ingest freshness check",
  );

  const sources = ingestSources(await readWorkflowFiles());

  if (sources.length === 0) {
    // Zero Sources means the discovery is broken, not that ingest has been switched off: this
    // repository has six. Reporting nothing would be indistinguishable from a clean bill.
    throw new Error(
      `found no workflow in ${WORKFLOW_DIRECTORY} calling ingest-run.yml, which cannot be right`,
    );
  }

  const now = new Date();
  console.log(
    `Checking ${sources.length} ingest Source(s) at ${now.toISOString()}`,
  );

  let lateCount = 0;

  for (const source of sources) {
    const history = await fetchSourceHistory(environment, source);
    const freshness = judgeFreshness({
      crons: source.crons,
      lastSuccessAt: history.lastSuccessAt,
      workflowCreatedAt: history.workflowCreatedAt,
      now,
    });

    console.log(`- ${source.name}: ${freshness.verdict}`);

    if (!freshness.late) {
      continue;
    }

    lateCount += 1;
    const late: LateSourceReport = {
      source,
      freshness,
      workflowState: history.workflowState,
      runsUrl: history.runsUrl,
    };

    console.log(`  ${describeLateSource(late)}`);
    await report(environment, late);
  }

  console.log(
    lateCount === 0
      ? "Every Source has run since it was last due."
      : `${lateCount} Source(s) reported.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
