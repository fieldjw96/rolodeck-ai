import type { IngestReport } from "../../db/ingest";
import { wroteNothing } from "./form-d-run";

/**
 * One Source's result within a run that ingests more than one — the shape
 * `scripts/ingest-accelerator-batches.ts` and `scripts/ingest-events.ts` both loop over.
 * Summing every Source's counts into one total before checking for failure hides exactly the
 * failure this project keeps meeting: a run where one Source's markup changed and it wrote
 * nothing, sitting next to another Source that wrote thirty rows and pulled the sum above
 * zero.
 */
export type SourceRun = {
  readonly source: string;
  readonly report: IngestReport;
};

/**
 * The Sources, out of a whole run, that wrote nothing — by the same inserted-plus-updated rule
 * a single-Source run fails on (`wroteNothing`), applied per Source rather than to the run's
 * total.
 */
export function emptySources(runs: readonly SourceRun[]): readonly string[] {
  return runs
    .filter(({ report }) => wroteNothing(report))
    .map(({ source }) => source);
}

/**
 * The error message for a run where `emptySources` found at least one. Names every empty
 * Source on the first line, so the GitHub issue the workflow opens off this message is
 * readable without opening the run.
 */
export function describeEmptySources(
  empty: readonly string[],
  noun: string,
): string {
  return (
    `${empty.join(", ")} wrote no ${noun} this run. Either its markup changed shape, or ` +
    "something upstream is down — check the rejections above before believing it is simply " +
    "empty."
  );
}
