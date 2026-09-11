import type { ReactNode } from "react";

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
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const user = await requireUser();

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
