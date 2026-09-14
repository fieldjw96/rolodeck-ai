import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { readOwnerId } from "../lib/supabase/env";
import { issueField } from "../lib/zod/issues";
import type { Database } from "./connection";
import { eventInputSchema, type EventInput } from "./event-input";
import { sourceSchema } from "./ingest";
import type { IngestRejection } from "./profile-input";
import {
  eventAttendances,
  events,
  nameKeyOf,
  profiles,
  swipes,
} from "./schema";

/**
 * The Diary: the one write path into `events` and `event_attendances`, and the one read path
 * out of them. The events counterpart to `db/ingest.ts` and `db/deck.ts`, kept apart from both
 * because an Event is not a Company Profile and has its own natural key.
 */

/**
 * What a batch did, counted the way `IngestReport` counts Profiles, plus how many attendances
 * the batch left in place — the one number that says whether a Source's attendees matched
 * anything in the Deck at all.
 */
export type EventIngestReport = {
  readonly inserted: number;
  readonly updated: number;
  readonly rejected: number;
  readonly rejections: readonly IngestRejection[];
  readonly attendances: number;
};

/**
 * Writes a batch of Events from one Source, owned by the single account, idempotently.
 *
 * Idempotent on `(owner_id, source, external_id)`, in the spirit of docs/adr/0008: re-running a
 * Source updates the Events it wrote before rather than adding them again. The Source's own id
 * is the key rather than the name because both events Sources publish one, and it is what
 * survives Techmeme correcting a name or a date.
 *
 * Attendance is replaced, not accumulated: each Event's links are rebuilt from what the Source
 * states today, so a company a Source stops listing stops being linked. Each attendee name is
 * matched to the owner's Company Profiles on `name_key`, through `nameKeyOf` — the expression
 * that column is generated from — so a name matches here exactly when it would collide there.
 * A name that matches nothing is not stored; nothing is invented to hold it.
 *
 * Throws on a Source name or owner id that is wrong, for the reason `persistProfiles` gives.
 */
export async function persistEvents(
  db: Database,
  {
    source,
    events: candidates,
  }: { source: string; events: Iterable<EventInput> },
): Promise<EventIngestReport> {
  const sourceName = sourceSchema.parse(source);
  const ownerId = readOwnerId();

  const accepted: EventInput[] = [];
  const rejections: IngestRejection[] = [];

  for (const candidate of candidates) {
    const parsed = eventInputSchema.safeParse(candidate);

    if (parsed.success) {
      accepted.push(parsed.data);
    } else {
      // A failed safeParse always carries at least one issue.
      const issue = parsed.error.issues[0]!;
      rejections.push({
        field: issueField(issue),
        reason: issue.message,
        raw: candidate,
      });
    }
  }

  const counts = await db.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;
    let attendances = 0;

    // One statement per Event, as in `persistProfiles`: two records in one batch can share a
    // key, and a single multi-row `on conflict do update` may not touch a row twice.
    for (const event of accepted) {
      const [written] = await tx
        .insert(events)
        .values({
          ownerId,
          source: sourceName,
          externalId: event.externalId,
          name: event.name,
          startDate: event.startDate,
          endDate: event.endDate ?? null,
          location: event.location ?? null,
          url: event.url,
        })
        .onConflictDoUpdate({
          target: [events.ownerId, events.source, events.externalId],
          set: {
            name: sql`excluded.name`,
            startDate: sql`excluded.start_date`,
            endDate: sql`excluded.end_date`,
            location: sql`excluded.location`,
            url: sql`excluded.url`,
          },
        })
        // Postgres's own answer to "was this row new?". See `persistProfiles`.
        .returning({ id: events.id, inserted: sql<boolean>`(xmax = 0)` });

      // The upsert either returns its row or raises.
      const eventId = written!.id;

      if (written!.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }

      await tx
        .delete(eventAttendances)
        .where(eq(eventAttendances.eventId, eventId));

      if (event.attendees.length === 0) {
        continue;
      }

      const attendeeKeys = sql.join(
        event.attendees.map((name) => nameKeyOf(sql`${name}::text`)),
        sql`, `,
      );

      const matched = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.ownerId, ownerId),
            sql`${profiles.nameKey} in (${attendeeKeys})`,
          ),
        );

      if (matched.length === 0) {
        continue;
      }

      const linked = await tx
        .insert(eventAttendances)
        .values(matched.map((profile) => ({ eventId, profileId: profile.id })))
        .onConflictDoNothing()
        .returning({ profileId: eventAttendances.profileId });

      attendances += linked.length;
    }

    return { inserted, updated, attendances };
  });

  return {
    inserted: counts.inserted,
    updated: counts.updated,
    rejected: rejections.length,
    rejections,
    attendances: counts.attendances,
  };
}

/**
 * Where "today" is, for deciding which Events are past. Rolodeck is a Bay Area product and its
 * Events carry Bay Area calendar dates, so the day turns over at midnight there rather than at
 * midnight UTC — which would hide a San Francisco Event at 5pm on the day it happens.
 */
export const DIARY_TIME_ZONE = "America/Los_Angeles";

/**
 * The query `GET /api/events` accepts. Past Events are left out by default; `include=past` is
 * the one way to ask for them, and anything else is refused by name rather than ignored.
 */
export const diaryQuerySchema = z.object({
  include: z.enum(["past"], { error: "must be 'past'" }).optional(),
});

/** Today's date in the Diary's time zone, as `YYYY-MM-DD`. `now` is injectable for tests. */
export function diaryToday(now: Date = new Date()): string {
  // `en-CA` is the locale whose short date is already ISO 8601's `YYYY-MM-DD`.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DIARY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * An Event as the Diary shows it. `important` and `keptCompanies` are part of the query's
 * answer, not something a page works out: an Event is important exactly when a Company Profile
 * the reader has Kept is stated to attend it.
 */
export type DiaryEvent = {
  id: string;
  name: string;
  startDate: string;
  endDate: string | null;
  location: string | null;
  url: string;
  important: boolean;
  /** The Kept companies attending, by name, alphabetically. Empty when `important` is false. */
  keptCompanies: string[];
};

/**
 * The reader's own Events in date order, soonest first, with past ones left out unless asked
 * for. An Event is past once its last day is before `today`, so a three-day conference stays
 * in the Diary until it is over.
 *
 * Every Event is returned whether or not anyone is known to attend it: attendance only ever
 * marks an Event, it never decides whether one is shown.
 *
 * Ownership is written into the `where` clause, the attendance join and the swipe join, as well
 * as being carried by RLS underneath — see CLAUDE.md on RLS as a backstop, never the only
 * control.
 */
export async function readDiary(
  db: Database,
  {
    userId,
    today,
    includePast = false,
  }: { userId: string; today: string; includePast?: boolean },
): Promise<DiaryEvent[]> {
  /** The reader's Kept Company Profiles that attend the Event on the current row. */
  const keptAttendees = (selection: SQL) =>
    sql`select ${selection} from ${eventAttendances} inner join ${profiles} on ${profiles.id} = ${eventAttendances.profileId} inner join ${swipes} on ${swipes.profileId} = ${profiles.id} where ${eventAttendances.eventId} = ${events.id} and ${profiles.ownerId} = ${userId} and ${swipes.userId} = ${userId} and ${swipes.decision} = 'keep'`;

  return db
    .select({
      id: events.id,
      name: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      location: events.location,
      url: events.url,
      important: sql<boolean>`exists (${keptAttendees(sql`1`)})`,
      // `distinct` because a company two Sources both found is two Company Profiles with one
      // name (docs/adr/0008), and the Diary should name it once.
      keptCompanies: sql<
        string[]
      >`array(${keptAttendees(sql`distinct ${profiles.name}`)} order by 1)`,
    })
    .from(events)
    .where(
      and(
        eq(events.ownerId, userId),
        includePast
          ? undefined
          : sql`coalesce(${events.endDate}, ${events.startDate}) >= ${today}::date`,
      ),
    )
    .orderBy(asc(events.startDate), asc(events.name), asc(events.id));
}
