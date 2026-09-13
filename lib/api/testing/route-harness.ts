import { events, profiles, swipes } from "../../../db/schema";
import {
  createScratchDb,
  type ScratchDb,
} from "../../../db/testing/scratch-db";
import { seedProfiles } from "../../../db/testing/seed-profiles";
import {
  signInForCookies,
  stubBackend,
  type AuthBackend,
  type CookiePair,
  type ThrowawayUser,
} from "../../auth/testing/auth-backend";
import { apiRateLimiter } from "../rate-limit";

/**
 * Everything a route handler touches that is not the handler: an in-process Postgres with the
 * migrations and the policies applied, and an in-process Supabase Auth to hold a real session.
 * A test file wires these in with two `vi.mock` calls — `next/headers` for the cookies and
 * `db/connection` for the database — and is then exercising the production code path, cookie
 * parsing, RLS and all.
 */
export type RouteHarness = {
  scratch: ScratchDb;
  backend: AuthBackend;
  user: ThrowawayUser;
  /** The account that owns nothing this session's user is allowed to see. */
  strangerId: string;
  /** What the mocked `next/headers` hands back. Empty is a request with no session. */
  cookies: CookiePair[];
  signIn: () => Promise<void>;
  signOut: () => void;
  seed: (count: number, ownerId?: string) => Promise<string[]>;
  /** Empties the database and gives the user back a full rate-limit budget. */
  clear: () => Promise<void>;
  close: () => Promise<void>;
};

const STRANGER = "99999999-9999-9999-9999-999999999999";

export async function startRouteHarness(): Promise<RouteHarness> {
  const scratch = await createScratchDb();
  const backend = await stubBackend();
  const user = await backend.createUser();

  // `profiles.owner_id` and `swipes.user_id` both point into `auth.users`, which the Auth stub
  // knows nothing about: the two halves are joined here, by id.
  await scratch.createUser(user.id);
  await scratch.createUser(STRANGER);

  const harness: RouteHarness = {
    scratch,
    backend,
    user,
    strangerId: STRANGER,
    cookies: [],
    signIn: async () => {
      harness.cookies = await signInForCookies(backend, user);
    },
    signOut: () => {
      harness.cookies = [];
    },
    seed: (count, ownerId = user.id) =>
      seedProfiles(scratch.db, { count, ownerId }),
    clear: async () => {
      // The limiter is module state shared by every handler in the file under test, so a test
      // that made 40 requests would otherwise leave only 20 for the next one.
      apiRateLimiter.reset();
      await scratch.reset();
      // Deleting Events and Profiles cascades to `event_attendances` from both ends.
      await scratch.db.delete(events);
      await scratch.db.delete(swipes);
      await scratch.db.delete(profiles);
    },
    close: async () => {
      await backend.deleteUser(user.id);
      await backend.close();
      await scratch.close();
    },
  };

  return harness;
}
