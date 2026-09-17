import { parse } from "yaml";
import { z } from "zod";

/**
 * Which ingest Sources exist, and how often each is expected to run, read out of the caller
 * workflows in `.github/workflows/` rather than restated anywhere.
 *
 * A Source is a workflow that calls `ingest-run.yml`, and its expected cadence is its own
 * `schedule.cron`. That is the whole definition, and it is the reason this reads the directory
 * instead of holding a list: a Source added tomorrow is watched without anyone remembering to
 * come back here, and a cron that changes cannot leave a checker describing a schedule that no
 * longer exists.
 *
 * Pure: the caller supplies the file contents. `scripts/check-ingest-freshness.ts` is what goes
 * and reads them, the same split `lib/ingest/boundaries.test.ts` holds every Source parser to.
 */

/** The shared workflow a caller has to call to be a Source. */
export const INGEST_RUN_WORKFLOW = ".github/workflows/ingest-run.yml";

export type WorkflowFile = {
  /** Repo-relative and slash-separated, e.g. `.github/workflows/ingest-news.yml`. */
  path: string;
  text: string;
};

export type IngestSource = {
  /** The Source's slug, exactly as the caller hands it to `ingest-run.yml`. */
  name: string;
  /** The caller workflow's repo-relative path. */
  workflowPath: string;
  /** Its own `schedule.cron` entries, in file order. Never empty. */
  crons: string[];
};

/**
 * Only the parts a Source is recognised by. Workflow files carry a great deal this does not
 * care about, so everything else is passed through rather than refused — but `jobs` and the
 * shape of a `uses` are needed to answer "does this call `ingest-run.yml`" at all.
 */
const candidateSchema = z.object({
  jobs: z
    .record(
      z.string(),
      z.looseObject({
        uses: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * What a caller of `ingest-run.yml` must look like. Strict where the checker depends on it:
 * a Source with no `schedule.cron` has no cadence to be late against, so rather than quietly
 * dropping out of the report — which is the exact failure this checker exists to notice — it
 * fails here, naming the field. The same goes for a `source-name` the report would have to
 * leave blank.
 */
const sourceSchema = z.object({
  on: z.looseObject({
    schedule: z
      .array(z.object({ cron: z.string().min(1) }))
      .min(1, {
        error: "needs at least one schedule.cron to be watched for staleness",
      }),
  }),
  jobs: z.record(
    z.string(),
    z.looseObject({
      uses: z.string().optional(),
      with: z
        .looseObject({
          "source-name": z.string().min(1),
        })
        .optional(),
    }),
  ),
});

/** `./.github/workflows/x.yml` and `.github/workflows/x.yml` are the same local workflow. */
function callsIngestRun(uses: string | undefined): boolean {
  return (
    uses !== undefined && uses.replace(/^\.\//, "") === INGEST_RUN_WORKFLOW
  );
}

/**
 * Every ingest Source among the given workflow files, ordered by name so a report reads the
 * same way twice.
 *
 * Throws, naming the file, on a workflow that calls `ingest-run.yml` but cannot be read as a
 * Source. Scraped data is hostile and so is a hand-edited YAML file: a shape that has changed
 * has to fail at the edge rather than propagate a Source with no cron into the decision.
 */
export function ingestSources(files: readonly WorkflowFile[]): IngestSource[] {
  const sources: IngestSource[] = [];

  for (const file of files) {
    let document: unknown;

    try {
      document = parse(file.text);
    } catch (error) {
      throw new Error(
        `${file.path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const candidate = candidateSchema.safeParse(document);

    if (
      !candidate.success ||
      !Object.values(candidate.data.jobs ?? {}).some((job) =>
        callsIngestRun(job.uses),
      )
    ) {
      continue;
    }

    const parsed = sourceSchema.safeParse(document);

    if (!parsed.success) {
      throw new Error(
        `${file.path} calls ${INGEST_RUN_WORKFLOW} but cannot be read as a Source: ${z.prettifyError(parsed.error)}`,
      );
    }

    const job = Object.values(parsed.data.jobs).find((candidateJob) =>
      callsIngestRun(candidateJob.uses),
    );
    const name = job?.with?.["source-name"];

    if (name === undefined) {
      throw new Error(
        `${file.path} calls ${INGEST_RUN_WORKFLOW} without a with.source-name, so a report could not say which Source it is`,
      );
    }

    sources.push({
      name,
      workflowPath: file.path,
      crons: parsed.data.on.schedule.map((entry) => entry.cron),
    });
  }

  return sources.sort((left, right) => left.name.localeCompare(right.name));
}
