import { z } from "zod";

import { getDb } from "../../../../../db/connection";
import { readNewsForProfile, type NewsEntry } from "../../../../../db/news";
import { asUser } from "../../../../../db/rls";
import { authenticated } from "../../../../../lib/api/authenticated";
import { unprocessable } from "../../../../../lib/api/responses";

/** The dynamic segment is external input like anything else. See `../../swipe.ts`. */
const paramsSchema = z.object({ id: z.guid("must be a Profile id") });

type NewsContext = { params: Promise<{ id: string }> };

/** An article on the wire, matching `GET /api/news`'s own item shape. */
function toJson(item: NewsEntry) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    published_at: item.publishedAt.toISOString(),
    source_name: item.sourceName,
    confidence: item.confidence,
  };
}

/**
 * One Kept company's News, for the Watchlist card's News tab: the same articles `GET
 * /api/news` groups under this company, read for one company rather than every one the
 * reader Kept. Answers with no items, rather than 404, for a Profile the reader has Passed
 * or never swiped — see `readNewsForProfile`.
 */
export const GET = authenticated<NewsContext>(
  async (_request, user, context) => {
    const params = paramsSchema.safeParse(await context.params);

    if (!params.success) {
      return unprocessable(params.error);
    }

    const items = await asUser(getDb(), user.id, (tx) =>
      readNewsForProfile(tx, { userId: user.id, profileId: params.data.id }),
    );

    return Response.json({ items: items.map(toJson) });
  },
);
