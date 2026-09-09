"use client";

import { useEffect, useState } from "react";

type KeptProfile = {
  id: string;
  name: string;
  sector: string;
  stage: string;
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
    return null;
  }

  if (state.status === "error") {
    return <p role="alert">{state.message}</p>;
  }

  if (state.status === "empty") {
    return <p>{EMPTY_WATCHLIST_MESSAGE}</p>;
  }

  return (
    <main>
      <h1>Watchlist</h1>
      <ul>
        {state.profiles.map((profile) => (
          <li key={profile.id}>
            <span>{profile.name}</span>
            <dl>
              <dt>Sector</dt>
              <dd>{profile.sector}</dd>
              <dt>Stage</dt>
              <dd>{profile.stage}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </main>
  );
}
