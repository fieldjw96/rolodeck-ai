import { z } from "zod";

import { getDb } from "../../../../../db/connection";
import {
  diaryToday,
  readEventsForProfile,
  type ProfileEvent,
} from "../../../../../db/events";
import { asUser } from "../../../../../db/rls";
import { authenticated } from "../../../../../lib/api/authenticated";
import { unprocessable } from "../../../../../lib/api/responses";

/** The dynamic segment is external input like anything else. See `../../swipe.ts`. */
const paramsSchema = z.object({ id: z.guid("must be a Profile id") });

type EventsContext = { params: Promise<{ id: string }> };

/** An Event on the wire, matching `GET /api/events`'s own item shape, minus the Diary-only
 * `important` and `kept_companies`: every Event here is already this one company's own. */
function toJson(event: ProfileEvent) {
  return {
    id: event.id,
    name: event.name,
    start_date: event.startDate,
    end_date: event.endDate,
    location: event.location,
    url: event.url,
  };
}

/**
 * One Company Profile's upcoming Events, for the Watchlist card's Events tab: every Event it
 * has an Attendance at whose end date (or start date, where it states no end) is today or
 * later, soonest first. Unlike `GET /api/events`, not filtered by area and not Keep-gated:
 * Events are Catalogue (docs/adr/0019), so this answers the same way for whoever asks it,
 * about whatever Profile they ask about. See `readEventsForProfile`.
 */
export const GET = authenticated<EventsContext>(
  async (_request, user, context) => {
    const params = paramsSchema.safeParse(await context.params);

    if (!params.success) {
      return unprocessable(params.error);
    }

    const items = await asUser(getDb(), user.id, (tx) =>
      readEventsForProfile(tx, {
        profileId: params.data.id,
        today: diaryToday(),
      }),
    );

    return Response.json({ items: items.map(toJson) });
  },
);
