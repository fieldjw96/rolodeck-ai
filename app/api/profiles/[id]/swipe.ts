import { z } from "zod";

import { getDb } from "../../../../db/connection";
import { recordSwipe } from "../../../../db/deck";
import { asUser } from "../../../../db/rls";
import type { SwipeDecision } from "../../../../db/schema";
import { authenticated } from "../../../../lib/api/authenticated";
import { notFound, unprocessable } from "../../../../lib/api/responses";

/**
 * The dynamic segment is external input like anything else: whatever sat in that part of the
 * URL arrives here as a string, so an id that is not a Profile id has to be turned away by
 * name rather than reach Postgres and come back as a driver-level type error.
 */
const paramsSchema = z.object({ id: z.guid("must be a Profile id") });

type SwipeContext = { params: Promise<{ id: string }> };

/**
 * Both swipe endpoints, which differ only in the decision they record. Keeping them one
 * function means Keep and Pass cannot drift apart in their validation, their 401 or their
 * 404 — the two `route.ts` files are the URLs, and this is the behaviour.
 */
export function swipeRoute(decision: SwipeDecision) {
  return authenticated<SwipeContext>(async (_request, user, context) => {
    const params = paramsSchema.safeParse(await context.params);

    if (!params.success) {
      return unprocessable(params.error);
    }

    const recorded = await asUser(getDb(), user.id, (tx) =>
      recordSwipe(tx, {
        userId: user.id,
        profileId: params.data.id,
        decision,
      }),
    );

    if (recorded === null) {
      return notFound();
    }

    return Response.json({
      profile_id: recorded.profileId,
      decision: recorded.decision,
      decided_at: recorded.decidedAt.toISOString(),
    });
  });
}
