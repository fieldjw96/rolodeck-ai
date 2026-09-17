import { CronExpressionParser } from "cron-parser";

import type { IngestSource } from "./workflow-schedules";

/**
 * Whether an ingest Source that was supposed to run has.
 *
 * `ingest-run.yml` opens an issue when a run fails, so a Source that breaks loudly is reported.
 * A Source whose scheduled run simply never happened produces no run, no failure and no issue,
 * and a silently dead scraper reads exactly like a quiet week. GitHub's scheduler is best-effort
 * by its own documentation — delayed under load, occasionally dropped, and disabled outright
 * after a period of repository inactivity, which would stop every Source at once — so "it did
 * not run" is a real state that needs noticing, not a hypothetical one.
 *
 * Everything here is a pure function of a cron, a last-success time and a current time.
 * `scripts/check-ingest-freshness.ts` is what fetches the run history and posts the issue; this
 * file only decides, which is why the decision can be tested offline against fixed inputs.
 */

/**
 * How long past a scheduled occurrence a Source is still given before it counts as late.
 *
 * This absorbs one thing: GitHub's own scheduling delay. Scheduled workflows are queued on a
 * best-effort basis and run late routinely by tens of minutes and occasionally by hours,
 * especially on the hour and at the start of an hour, which is when most crons are written. Six
 * hours is comfortably past "occasionally by hours" while still well inside the shortest cadence
 * this repo has, so a dead daily Source is reported within a day of dying and a busy morning on
 * GitHub's runners is not reported at all.
 *
 * One constant for every Source, deliberately. Tuning it per Source would be a second place a
 * schedule is written down, and a checker that restates schedules is the thing this avoids.
 */
export const SCHEDULE_GRACE_MS = 6 * 60 * 60 * 1000;

/** GitHub evaluates every `schedule` cron in UTC, whatever the repository or the runner. */
const CRON_TIMEZONE = "UTC";

/**
 * The latest occurrence of one cron at or before `atOrBefore`.
 *
 * A real cron parser rather than a pattern match over the string: five fields have step values,
 * ranges, lists, and a day-of-month and day-of-week that are OR-ed rather than AND-ed when both
 * are restricted. A regular expression gets those wrong quietly, and the whole point of this
 * checker is that a wrong answer looks exactly like a right one.
 *
 * `prev()` is strictly before its `currentDate`, so asking from one millisecond later is what
 * makes an occurrence landing exactly on `atOrBefore` count as having happened.
 */
function previousOccurrence(cron: string, atOrBefore: Date): Date {
  return CronExpressionParser.parse(cron, {
    currentDate: new Date(atOrBefore.getTime() + 1),
    tz: CRON_TIMEZONE,
  })
    .prev()
    .toDate();
}

/**
 * The most recent `count` occurrences of a Source's whole schedule at or before `atOrBefore`,
 * newest first. A Source may carry more than one cron, in which case its schedule is the union
 * of them, so each step takes whichever cron fired most recently.
 */
export function previousOccurrences(
  crons: readonly string[],
  atOrBefore: Date,
  count: number,
): Date[] {
  if (crons.length === 0) {
    throw new Error("a Source with no cron has no schedule to be late against");
  }

  const occurrences: Date[] = [];
  let cursor = atOrBefore;

  for (let taken = 0; taken < count; taken += 1) {
    const latest = Math.max(
      ...crons.map((cron) => previousOccurrence(cron, cursor).getTime()),
    );

    occurrences.push(new Date(latest));
    // One millisecond earlier, so the next step cannot return the occurrence just taken.
    cursor = new Date(latest - 1);
  }

  return occurrences;
}

export type FreshnessVerdict =
  /** It has succeeded since the occurrence it was due at. */
  | "on-time"
  /** It has succeeded before, but not since the occurrence it was due at. */
  | "late"
  /** It has never succeeded, and has existed long enough that that is a problem. */
  | "never-succeeded"
  /** It has never succeeded, and has not existed long enough to have missed anything. */
  | "too-new-to-judge";

export type Freshness = {
  verdict: FreshnessVerdict;
  /** Whether this Source should be reported. The verdict says why. */
  late: boolean;
  /** The scheduled occurrence it should have succeeded since. */
  dueAt: Date;
  /** When it last succeeded, or null if it never has. */
  lastSuccessAt: Date | null;
};

export type FreshnessInput = {
  /** The Source's own `schedule.cron` entries. */
  crons: readonly string[];
  /** When a run of this Source last completed successfully, or null if none ever has. */
  lastSuccessAt: Date | null;
  /** When this Source's workflow first existed, which bounds how long it has had to run. */
  workflowCreatedAt: Date;
  now: Date;
};

/**
 * Is this Source late.
 *
 * The rule is: it is late when it has not completed successfully since its own previous
 * scheduled occurrence, plus the grace. Expressed that way it needs no notion of "daily" or
 * "weekly" and holds for any cron, including one added later at a cadence nobody has thought
 * of yet.
 *
 * The grace is applied by asking the question a grace-period earlier rather than by moving a
 * deadline later. The difference matters: a run that is twenty minutes overdue should not be
 * judged against the occurrence it is twenty minutes into, but neither should a Source that
 * last succeeded a fortnight ago be called on time merely because the clock has just passed a
 * fresh occurrence it has not had its grace against yet.
 *
 * A Source that has never succeeded is late only once its workflow has existed for longer than
 * one interval plus the grace. A Source added an hour ago has not missed anything, and
 * reporting it would teach the reader to skim past the report, which costs more than the
 * delay does.
 */
export function judgeFreshness(input: FreshnessInput): Freshness {
  const { crons, lastSuccessAt, workflowCreatedAt, now } = input;

  const [dueAt, occurrenceBefore] = previousOccurrences(
    crons,
    new Date(now.getTime() - SCHEDULE_GRACE_MS),
    2,
  );

  // `previousOccurrences` returns exactly `count` entries or throws; this is for the compiler,
  // which cannot know that under noUncheckedIndexedAccess.
  if (dueAt === undefined || occurrenceBefore === undefined) {
    throw new Error(`could not read a schedule from ${crons.join(", ")}`);
  }

  if (lastSuccessAt === null) {
    const intervalMs = dueAt.getTime() - occurrenceBefore.getTime();
    const ageMs = now.getTime() - workflowCreatedAt.getTime();

    return ageMs > intervalMs + SCHEDULE_GRACE_MS
      ? { verdict: "never-succeeded", late: true, dueAt, lastSuccessAt }
      : { verdict: "too-new-to-judge", late: false, dueAt, lastSuccessAt };
  }

  return lastSuccessAt.getTime() >= dueAt.getTime()
    ? { verdict: "on-time", late: false, dueAt, lastSuccessAt }
    : { verdict: "late", late: true, dueAt, lastSuccessAt };
}

/**
 * The title an issue about a late Source carries, and the exact string a later check matches on
 * to find it again.
 *
 * Same convention as the "Open or update an issue for a failed run" step in `ingest-run.yml`,
 * and for the same reason: one open issue per Source, commented on rather than duplicated, so a
 * Source that has been dead a week is one issue to read and not seven to ignore. Deliberately
 * unlike that step's "Ingest failure:" prefix — a Source that ran and failed and a Source that
 * never ran are different problems and should not share an issue.
 */
export function lateSourceIssueTitle(sourceName: string): string {
  return `Ingest Source has not run: ${sourceName}`;
}

/** UTC, to the minute, because every cron here is UTC and seconds say nothing. */
function moment(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export type LateSourceReport = {
  source: IngestSource;
  freshness: Freshness;
  /** The workflow's state as GitHub reports it, e.g. `active` or `disabled_inactivity`. */
  workflowState: string;
  /** Where to go and look, linked so the reader does not have to find it. */
  runsUrl: string;
};

/**
 * One line saying what is wrong with this Source, for a log or an issue comment.
 *
 * A reader has to be able to tell "this has never run" from "this stopped four days ago"
 * without opening the Actions tab, so both the last success and the occurrence it was due at
 * are named rather than implied.
 */
export function describeLateSource(report: LateSourceReport): string {
  const { source, freshness } = report;

  const lastSuccess =
    freshness.lastSuccessAt === null
      ? "It has never completed successfully"
      : `It last completed successfully at ${moment(freshness.lastSuccessAt)}`;

  return (
    `**${source.name}** should have run at ${moment(freshness.dueAt)} ` +
    `(cron \`${source.crons.join("`, `")}\` in \`${source.workflowPath}\`, ` +
    `plus ${SCHEDULE_GRACE_MS / (60 * 60 * 1000)}h of grace for GitHub's scheduling delay). ` +
    `${lastSuccess}.`
  );
}

/**
 * The body of the issue opened the first time a Source is found late.
 *
 * Says plainly what this does and does not cover, because the checker is itself a scheduled
 * workflow: whatever would silence every Source at once would silence this too.
 */
export function lateSourceIssueBody(report: LateSourceReport): string {
  const disabled =
    report.workflowState === "active"
      ? ""
      : `\n\nGitHub reports this workflow's state as \`${report.workflowState}\`, so it is not ` +
        "being scheduled at all. Re-enable it from the Actions tab.\n";

  return [
    `${describeLateSource(report)}${disabled}`,
    "",
    `Run history: ${report.runsUrl}`,
    "",
    "Opened by the ingest freshness check, which asks of every Source in " +
      "`.github/workflows/` that calls `ingest-run.yml` whether it has succeeded since its own " +
      "previous scheduled occurrence. This issue stays open and is commented on while the " +
      "Source is still late, rather than being reopened once per check.",
    "",
    "The check is itself a scheduled workflow, so it cannot detect its own absence.",
  ].join("\n");
}
