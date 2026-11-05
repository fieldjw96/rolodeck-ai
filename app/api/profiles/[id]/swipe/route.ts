import { getDb } from "../../../../../db/connection";
import { undoSwipe } from "../../../../../db/deck";
import { asUser } from "../../../../../db/rls";
import { authenticated } from "../../../../../lib/api/authenticated";
import { notFound, unprocessable } from "../../../../../lib/api/responses";
import { swipeParamsSchema, type SwipeContext } from "../decision";

/**
 * Undo: take back the decision this reader just made about this Company Profile. `DELETE` on
 * the swipe itself rather than a `POST` to an `/undo` of its own, because that is what it is —
 * the one row `keep` and `pass` upsert, removed. A Company Profile with no row is a Company
 * Profile the reader has not judged, which is the state Undo puts them back in.
 *
 * 204 when a decision was deleted and 404 when there was none, so a caller can tell a Pass
 * taken back from a Pass that was never there — a second Undo of the same card, or one racing
 * the write it is undoing. The reader is written into `undoSwipe`'s own `where` as well as
 * being presented to Postgres by `asUser`, per CLAUDE.md.
 */
export const DELETE = authenticated<SwipeContext>(
  async (_request, user, context) => {
    const params = swipeParamsSchema.safeParse(await context.params);

    if (!params.success) {
      return unprocessable(params.error);
    }

    const undone = await asUser(getDb(), user.id, (tx) =>
      undoSwipe(tx, { userId: user.id, profileId: params.data.id }),
    );

    // 204, so there is no body to read: the reader's own Deck is the whole of the answer, and
    // the client already knows which card it asked about.
    return undone ? new Response(null, { status: 204 }) : notFound();
  },
);
