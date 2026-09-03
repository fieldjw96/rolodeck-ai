"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Profile = {
  id: string;
  name: string;
  description: string;
  sector: string;
  stage: string;
};

type ProfilesPage = {
  profiles: Profile[];
  next_cursor: string | null;
};

type ReadyState = {
  status: "ready";
  profiles: Profile[];
  index: number;
  nextCursor: string | null;
};

type DeckState = { status: "loading" } | { status: "empty" } | ReadyState;

type Decision = "keep" | "pass";

/** A real string rather than a blank screen, per the Ticket. */
export const EMPTY_DECK_MESSAGE = "No Profiles left in the Deck.";

async function fetchPage(cursor: string | null): Promise<ProfilesPage> {
  const url =
    cursor === null
      ? "/api/profiles"
      : `/api/profiles?cursor=${encodeURIComponent(cursor)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }

  return (await response.json()) as ProfilesPage;
}

/** Throws on a non-2xx response, so a swipe that failed server-side is never mistaken for
 * one that was recorded and the Deck advances past it anyway. */
async function recordSwipe(id: string, decision: Decision): Promise<void> {
  const url = `/api/profiles/${id}/${decision}`;
  const response = await fetch(url, { method: "POST" });

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}`);
  }
}

function stateAfter(page: ProfilesPage): DeckState {
  return page.profiles.length === 0
    ? { status: "empty" }
    : {
        status: "ready",
        profiles: page.profiles,
        index: 0,
        nextCursor: page.next_cursor,
      };
}

/**
 * Advances past the Profile at `current.index`: the next Profile in the current page, or the
 * next page fetched by its cursor, or the empty state when the Deck has neither.
 */
async function stateAfterAdvancing(current: ReadyState): Promise<DeckState> {
  const nextIndex = current.index + 1;

  if (nextIndex < current.profiles.length) {
    return { ...current, index: nextIndex };
  }

  if (current.nextCursor === null) {
    return { status: "empty" };
  }

  return stateAfter(await fetchPage(current.nextCursor));
}

/**
 * The core product surface: the current Profile from the Deck, with Keep and Pass. Kept as a
 * Client Component so it can hold the Deck's position and answer arrow keys; `page.tsx` is the
 * server-rendered shell around it. Every read and write still goes through `/api/profiles`
 * rather than Postgres directly, per CLAUDE.md.
 */
export function Deck() {
  const [state, setState] = useState<DeckState>({ status: "loading" });
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    fetchPage(null).then((page) => setState(stateAfter(page)));
  }, []);

  // Set synchronously, before the `await` inside `recordSwipe`, so a second Keep or Pass
  // fired before the first one's state update lands (arrow-key auto-repeat, a fast double
  // click) is ignored rather than recording a second swipe against the same Profile.
  const decidingRef = useRef(false);

  // Read from the ref rather than closing over `state`, so this stays one stable function
  // across renders and the keydown listener below does not need to be torn down and rebuilt
  // on every Keep or Pass.
  const decide = useCallback((decision: Decision) => {
    const current = stateRef.current;

    if (current.status !== "ready" || decidingRef.current) {
      return;
    }

    const profile = current.profiles[current.index];

    if (profile === undefined) {
      return;
    }

    decidingRef.current = true;

    void recordSwipe(profile.id, decision)
      .then(() => stateAfterAdvancing(current))
      .then(setState)
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => {
        decidingRef.current = false;
      });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") {
        decide("pass");
      } else if (event.key === "ArrowRight") {
        decide("keep");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide]);

  if (state.status === "loading") {
    return null;
  }

  if (state.status === "empty") {
    return <p>{EMPTY_DECK_MESSAGE}</p>;
  }

  const profile = state.profiles[state.index];

  if (profile === undefined) {
    return <p>{EMPTY_DECK_MESSAGE}</p>;
  }

  return (
    <main>
      <h1>{profile.name}</h1>
      <p>{profile.description}</p>
      <dl>
        <dt>Sector</dt>
        <dd>{profile.sector}</dd>
        <dt>Stage</dt>
        <dd>{profile.stage}</dd>
      </dl>
      <button type="button" onClick={() => decide("pass")}>
        Pass
      </button>
      <button type="button" onClick={() => decide("keep")}>
        Keep
      </button>
    </main>
  );
}
