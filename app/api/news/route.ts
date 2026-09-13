import { getDb } from "../../../db/connection";
import { readNews, type NewsGroup } from "../../../db/news";
import { asUser } from "../../../db/rls";
import { authenticated } from "../../../lib/api/authenticated";

/**
 * A Kept Company Profile's News on the wire. `confidence` travels with each item because it is
 * the one thing that says why an item is here, and a caller has no other way to see it; the
 * items below the threshold do not travel at all. Keys follow `GET /api/profiles`'s snake case.
 */
function toJson(group: NewsGroup) {
  return {
    profile: group.profile,
    items: group.items.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      published_at: item.publishedAt.toISOString(),
      source_name: item.sourceName,
      confidence: item.confidence,
    })),
  };
}

/**
 * The signed-in user's News, grouped by company and newest first. Like every other read, it
 * runs inside `asUser()`, so the `news_items` RLS policy is underneath the `where` clause.
 * Unpaged: News only covers Kept companies, which is a short list by construction.
 */
export const GET = authenticated(async (_request, user) => {
  const groups = await asUser(getDb(), user.id, (tx) => readNews(tx, user.id));

  return Response.json({ companies: groups.map(toJson) });
});
