import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { needsOnboarding } from "../../lib/auth/onboarding";
import { ONBOARDING_PATH } from "../../lib/auth/paths";
import { requireUser } from "../../lib/auth/session";
import { signOut } from "./actions";
import { Nav } from "./nav";
import styles from "./layout.module.css";

/**
 * Nothing behind this layout is cacheable: it renders for one signed-in user, per request.
 * Saying so explicitly also keeps `next build` from attempting a static render of a segment
 * whose first act is to read a session.
 */
export const dynamic = "force-dynamic";

/**
 * The gate, as structure. Every route under `(app)` inherits this layout, so a page added
 * later is behind the session check by where it sits rather than by someone remembering to
 * add one. `/login` sits outside the group, which is the only reason it is reachable.
 *
 * The first-run screen is gated the same way, and for the same reason. The redirects in
 * `app/login/actions.ts` and `app/auth/callback/route.ts` send a new User to `/onboarding`
 * after they sign in, but those are the two paths that happen to pass through sign-in: a
 * bookmark, a typed URL or a link straight to `/deck` reaches none of them, and a User who
 * arrived that way was never asked. That is exactly the distinction docs/adr/0004 draws
 * between an optimistic check at the edge and the authoritative one in the layout, so the
 * authoritative one goes here, where every route under the group inherits it.
 *
 * `/onboarding` itself sits outside this group, which is what stops this redirect looping; it
 * calls `requireUser()` for itself, and bounces a User who has already been asked back out.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const user = await requireUser();

  if (await needsOnboarding(user.id)) {
    redirect(ONBOARDING_PATH);
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.bar}>
          <span className={styles.wordmark}>Rolodeck AI</span>
          <Nav />
          <div className={styles.account}>
            <span className={styles.email}>{user.email}</span>
            <form action={signOut}>
              <button className={styles.signOut} type="submit">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      {children}
    </>
  );
}
