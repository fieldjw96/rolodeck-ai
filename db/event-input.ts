import { z } from "zod";

import { issueField } from "../lib/zod/issues";
import type { IngestRejection } from "./profile-input";

/**
 * The one shared boundary schema for anything that produces an Event, the Diary's counterpart
 * to `profileInputSchema`. Every events Source parses its own payload its own way — an
 * iCalendar feed, a page's JSON-LD — and then validates against this before a value reaches
 * Postgres. Per CLAUDE.md, scraped data is hostile: a Source that changes shape is rejected
 * here naming the field, rather than letting an `undefined` into the Diary.
 */
const nonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "must not be blank",
  });

export const eventInputSchema = z
  .strictObject({
    /**
     * The Source's own identifier for the Event — an iCalendar `UID`, a JSON-LD `@id` — and
     * half of what ingest is idempotent on. See `persistEvents` in `db/events.ts`.
     */
    externalId: nonBlankString,
    name: nonBlankString,
    /** A calendar date, `YYYY-MM-DD`, in the Event's own local time. */
    startDate: z.iso.date(),
    /** Inclusive, and only where the Source states one. */
    endDate: z.iso.date().optional(),
    location: nonBlankString.optional(),
    // Restricted to http(s) for the reason `profileInputSchema` gives for `website`: the Diary
    // renders this as a link, and a scraped `javascript:` URL must not survive to become one.
    url: z.url({ protocol: /^https?$/ }),
    /**
     * Company names the Source itself states take part in the Event. Never inferred: ADR 0002
     * rules out invented data, and a guessed attendance is worse than none. Matched to Company
     * Profiles at ingest, on `name_key`.
     */
    attendees: z.array(nonBlankString),
  })
  .refine(
    (event) => event.endDate === undefined || event.endDate >= event.startDate,
    { error: "must not be before startDate", path: ["endDate"] },
  );

export type EventInput = z.infer<typeof eventInputSchema>;

export type EventInputResult =
  | { readonly success: true; readonly data: EventInput }
  | { readonly success: false; readonly rejection: IngestRejection };

/** Parses a raw, untrusted record, reporting the first offending field. See `parseProfileInput`. */
export function parseEventInput(raw: unknown): EventInputResult {
  const result = eventInputSchema.safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }

  // A failed safeParse always carries at least one issue.
  const issue = result.error.issues[0]!;
  return {
    success: false,
    rejection: { field: issueField(issue), reason: issue.message, raw },
  };
}
