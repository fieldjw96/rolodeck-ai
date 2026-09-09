import { z } from "zod";

import type { IngestReport } from "../../db/ingest";
import type { FormDFetchOptions } from "./edgar";
import type { FormDBatch } from "./sec-form-d";

/**
 * Everything `scripts/ingest-sec-form-d.ts` does that is worth testing. The script itself is
 * argv in, stdout out, and a process exit code — the same split `lib/auth/provisioning.ts`
 * makes with `scripts/provision-account.ts`.
 */

const USAGE =
  "usage: SEC_EDGAR_CONTACT=you@example.com npm run ingest:sec-form-d -- [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N]\n" +
  "Defaults to the last seven days of filings, up to a hundred of them.";

/** How far back a run with no `--since` looks. A week of Form Ds is a readable Deck. */
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_LIMIT = 100;

const isoDate = z.iso.date();

function shiftDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);

  if (at === -1) {
    return undefined;
  }

  const value = argv[at + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} needs a value\n${USAGE}`);
  }

  return value;
}

function date(argv: readonly string[], name: string): string | undefined {
  const raw = flag(argv, name);

  if (raw === undefined) {
    return undefined;
  }

  if (!isoDate.safeParse(raw).success) {
    throw new Error(
      `--${name} must be a YYYY-MM-DD date, not ${raw}\n${USAGE}`,
    );
  }

  return raw;
}

/**
 * The window and size of one run. Everything is optional and defaulted, because the common
 * invocation is "whatever has been filed lately" and a run that needs three arguments to say
 * that is a run nobody makes.
 */
export function parseFormDArgs(
  argv: readonly string[],
  today: string,
): FormDFetchOptions {
  const until = date(argv, "until") ?? today;
  const since = date(argv, "since") ?? shiftDays(until, -DEFAULT_WINDOW_DAYS);

  if (since > until) {
    throw new Error(`--since ${since} is after --until ${until}\n${USAGE}`);
  }

  const rawLimit = flag(argv, "limit");
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `--limit must be a positive whole number, not ${rawLimit}\n${USAGE}`,
    );
  }

  return { since, until, limit, today };
}

/**
 * The contact the SEC requires. Deliberately not defaulted: the address has to be one the
 * operator actually reads, and a hard-coded one in a public repository would put somebody
 * else's inbox on every request this makes.
 */
export function readEdgarContact(): string {
  const contact = process.env.SEC_EDGAR_CONTACT;

  if (contact === undefined || contact.trim() === "") {
    throw new Error(
      "SEC_EDGAR_CONTACT is not set. The SEC answers 403 to a client that does not " +
        "identify itself, so set it to an email address it can reach you at.",
    );
  }

  return contact.trim();
}

/**
 * Whether the run should fail.
 *
 * A scraper whose selectors have gone stale returns zero rows and reports success, which is
 * the failure this project keeps meeting — so a run that put nothing in the table is an error,
 * not a quiet week. Inserts and updates both count: ingest is idempotent on
 * `(owner_id, source, name_key)` per docs/adr/0008, so the second run of a healthy pipeline
 * inserts nothing at all and updates everything, and failing that would be crying wolf.
 */
export function wroteNothing(report: IngestReport): boolean {
  return report.inserted + report.updated === 0;
}

/** What the run did, in the order an operator wants to read it. */
export function summariseRun(batch: FormDBatch, report: IngestReport): string {
  const lines = [
    `Read ${batch.profiles.length + batch.rejections.length + batch.filtered} filings from EDGAR.`,
    `  ${batch.filtered} outside California, ${batch.rejections.length} rejected.`,
    `Wrote ${report.inserted} new Profiles and updated ${report.updated}.`,
  ];

  // Named, not counted: a rising number against one field is how a source that has quietly
  // changed shape announces itself, and the name is the whole of the announcement.
  for (const rejection of [...batch.rejections, ...report.rejections]) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}
