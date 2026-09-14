import { getDb } from "../../../db/connection";
import {
  diaryQuerySchema,
  diaryToday,
  readDiary,
  type DiaryEvent,
} from "../../../db/events";
import { asUser } from "../../../db/rls";
import { authenticated } from "../../../lib/api/authenticated";
import { unprocessable } from "../../../lib/api/responses";

/** An Event on the wire. Keys are the column names, as on `GET /api/profiles`. */
function toJson(event: DiaryEvent) {
  return {
    id: event.id,
    name: event.name,
    start_date: event.startDate,
    end_date: event.endDate,
    location: event.location,
    url: event.url,
    important: event.important,
    kept_companies: event.keptCompanies,
  };
}

/**
 * The Diary: every Event, soonest first, with past ones left out unless `include=past`. Read on
 * the server as the signed-in user, per CLAUDE.md, so the RLS policies are underneath the
 * answer as well as the `where` clause. `important` is part of what the query returns; the page
 * only renders it.
 */
export const GET = authenticated(async (request, user) => {
  const query = diaryQuerySchema.safeParse({
    include: request.nextUrl.searchParams.get("include") ?? undefined,
  });

  if (!query.success) {
    return unprocessable(query.error);
  }

  const diary = await asUser(getDb(), user.id, (tx) =>
    readDiary(tx, {
      userId: user.id,
      today: diaryToday(),
      includePast: query.data.include === "past",
    }),
  );

  return Response.json({ events: diary.map(toJson) });
});
