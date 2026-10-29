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
    past: event.past,
  };
}

/**
 * The Diary: the startup community's Events, with past ones left out unless `include=past`.
 * Without `include=past`, every Event is upcoming, soonest first. With it, at most
 * `DIARY_PAST_LIMIT` past Events come first, newest first, followed by every upcoming Event in
 * that same soonest-first order; `past` on each Event says which group it is in. Read on the
 * server as the signed-in user, per CLAUDE.md, so the RLS policies are underneath the answer as
 * well as the `where` clause. `important` is part of what the query returns; the page only
 * renders it.
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
