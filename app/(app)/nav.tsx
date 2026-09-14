"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./layout.module.css";

export function Nav() {
  const pathname = usePathname();

  const isCurrentRoute = (href: string) => pathname === href;

  return (
    <nav className={styles.nav}>
      <Link
        className={styles.navLink}
        href="/deck"
        aria-current={isCurrentRoute("/deck") ? "page" : undefined}
      >
        Deck
      </Link>
      <Link
        className={styles.navLink}
        href="/watchlist"
        aria-current={isCurrentRoute("/watchlist") ? "page" : undefined}
      >
        Watchlist
      </Link>
      <Link
        className={styles.navLink}
        href="/news"
        aria-current={isCurrentRoute("/news") ? "page" : undefined}
      >
        News
      </Link>
      <Link
        className={styles.navLink}
        href="/diary"
        aria-current={isCurrentRoute("/diary") ? "page" : undefined}
      >
        Diary
      </Link>
      <Link
        className={styles.navLink}
        href="/settings"
        aria-current={isCurrentRoute("/settings") ? "page" : undefined}
      >
        Settings
      </Link>
    </nav>
  );
}
