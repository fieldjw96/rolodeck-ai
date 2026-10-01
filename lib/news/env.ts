import { z } from "zod";

import { parseEnv } from "../env/parse-env";

/**
 * Whose Keeps a News run gathers for.
 *
 * News is Catalogue — an article is the same row for every User, and everyone reads it — but
 * gathering is not. Something has to decide which companies the scrapers are pointed at, and
 * docs/adr/0019 decides it conservatively: Jack's Keeps, and nobody else's. Gathering for every
 * User's Keeps would be better for a User who Keeps a company Jack has not, and it would also
 * let one account aim the scrapers at several hundred companies by swiping, with sign-up open
 * per docs/adr/0020. So that is a Ticket and a rate conversation, not a schema change, and this
 * variable is what records the narrowing in the meantime.
 *
 * It is deliberately not the old `ROLODECK_OWNER_ID` under a new description. That named the one
 * account every row belonged to, which is a thing that no longer exists; this names one User
 * whose swipes are read, and nothing it is set to owns anything. Reusing the name would have let
 * the old meaning survive the column it described.
 */
const newsKeepsSchema = z.object({
  // `z.guid()` rather than `z.uuid()`, matching `db/deck.ts`: Postgres's `uuid` type accepts any
  // 128 bits laid out as hex, and a boundary stricter than the column it is compared against
  // would reject an id the database is perfectly happy to hold.
  ROLODECK_NEWS_KEEPS_USER_ID: z.guid(),
});

/**
 * The User whose Keeps this News run gathers for.
 *
 * A parse rather than a read, because the failure is quiet otherwise: an id nobody has Kept
 * anything under is a run that reads every feed, matches them against no companies, stores
 * nothing, and reports a successful quiet day. Read on every call, not at module scope, so
 * importing a News module needs no environment.
 */
export function readNewsKeepsUserId(): string {
  return parseEnv(
    newsKeepsSchema,
    {
      ROLODECK_NEWS_KEEPS_USER_ID: process.env.ROLODECK_NEWS_KEEPS_USER_ID,
    },
    "The User whose Keeps News gathers for",
  ).ROLODECK_NEWS_KEEPS_USER_ID;
}
