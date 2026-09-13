"use client";

import { useEffect, useState } from "react";

import { ProfileCard } from "../../../lib/ui/profile-card";
import { StateNotice } from "../../../lib/ui/state-notice";
import styles from "./watchlist.module.css";

type KeptProfile = {
  id: string;
  name: string;
  sector: string;
  stage: string;
  location: string | null;
};

type ProfilesPage = {
  profiles: KeptProfile[];
};

type WatchlistState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; profiles: KeptProfile[] };

/** A real string rather than a blank screen, per the Ticket. */
export const EMPTY_WATCHLIST_MESSAGE = "You haven't Kept any Profiles yet.";

/** Shown when `GET /api/profiles?filter=kept` fails, so a dead network leaves Jack looking
 * at an explicit message rather than a Watchlist stuck on "loading" forever. */
export const LOAD_ERROR_MESSAGE = "Couldn't load the Watchlist.";

/** Shown while `GET /api/profiles?filter=kept` is in flight, so assistive tech has something
 * to announce rather than a screen that renders nothing at all. */
export const LOADING_WATCHLIST_MESSAGE = "Loading Watchlist…";

// The second line of each designed state, as in the Deck: what it means, or what to do next.
const LOADING_WATCHLIST_DETAIL = "Reading back everything you have Kept.";
const EMPTY_WATCHLIST_DETAIL =
  "Profiles you Keep in the Deck collect here, ready for a conversation.";
const LOAD_ERROR_DETAIL = "Check your connection, then reload the page.";

async function fetchKept(): Promise<ProfilesPage> {
  const response = await fetch("/api/profiles?filter=kept");

  if (!response.ok) {
    throw new Error(
      `GET /api/profiles?filter=kept failed with ${response.status}`,
    );
  }

  return (await response.json()) as ProfilesPage;
}

/**
 * Every Profile Jack has Kept, read through `GET /api/profiles?filter=kept` rather than
 * Postgres directly, per CLAUDE.md. There is no paging and no Keep/Pass here: the Watchlist
 * is a read-only view of a decision already made, not a second Deck.
 */
export function Watchlist() {
  const [state, setState] = useState<WatchlistState>({ status: "loading" });

  useEffect(() => {
    fetchKept()
      .then((page) =>
        setState(
          page.profiles.length === 0
            ? { status: "empty" }
            : { status: "ready", profiles: page.profiles },
        ),
      )
      .catch((error: unknown) => {
        console.error(error);
        setState({ status: "error", message: LOAD_ERROR_MESSAGE });
      });
  }, []);

  if (state.status === "loading") {
    return (
      <main className={styles.watchlist}>
        <StateNotice
          busy
          title={LOADING_WATCHLIST_MESSAGE}
          body={LOADING_WATCHLIST_DETAIL}
        />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className={styles.watchlist}>
        <StateNotice
          tone="danger"
          live="alert"
          title={state.message}
          body={LOAD_ERROR_DETAIL}
        />
      </main>
    );
  }

  if (state.status === "empty") {
    return (
      <main className={styles.watchlist}>
        <StateNotice
          title={EMPTY_WATCHLIST_MESSAGE}
          body={EMPTY_WATCHLIST_DETAIL}
        />
      </main>
    );
  }

  const count = state.profiles.length;

  return (
    <main className={styles.watchlist}>
      <div className={styles.header}>
        <h1 className={styles.title}>Watchlist</h1>
        <p className={styles.count}>
          {count} Kept {count === 1 ? "Profile" : "Profiles"}
        </p>
      </div>
      <ul className={styles.grid}>
        {state.profiles.map((profile) => (
          <li key={profile.id}>
            <ProfileCard
              compact
              headingLevel={2}
              name={profile.name}
              sector={profile.sector}
              stage={profile.stage}
              location={profile.location}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}
