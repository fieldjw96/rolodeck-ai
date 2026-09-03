import { getDb } from "../../../db/connection";
import {
  deckQuerySchema,
  readDeckPage,
  type DeckProfile,
} from "../../../db/deck";
import { asUser } from "../../../db/rls";
import { authenticated } from "../../../lib/api/authenticated";
import { unprocessable } from "../../../lib/api/responses";

/**
 * A Profile on the wire. `owner_id` is not on it: it is always the caller, and the Deck has
 * no use for it. Keys are the column names, which is also where `next_cursor` gets its shape.
 */
function toJson(profile: DeckProfile) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    sector: profile.sector,
    stage: profile.stage,
    website: profile.website,
    provenance: profile.provenance,
    created_at: profile.createdAt.toISOString(),
  };
}

/**
 * One page of the Deck. This is the only way Profiles reach a browser, per CLAUDE.md: the
 * query runs on the server, inside a transaction that presents itself to Postgres as the
 * signed-in user, so the RLS policy is underneath the answer as well as the `where` clause.
 */
export const GET = authenticated(async (request, user) => {
  const searchParams = request.nextUrl.searchParams;
  const query = deckQuerySchema.safeParse({
    limit: searchParams.get("limit") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
  });

  if (!query.success) {
    return unprocessable(query.error);
  }

  const page = await asUser(getDb(), user.id, (tx) =>
    readDeckPage(tx, { userId: user.id, ...query.data }),
  );

  return Response.json({
    profiles: page.profiles.map(toJson),
    next_cursor: page.nextCursor,
  });
});
