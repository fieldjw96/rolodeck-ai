"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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

type DeckState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | ReadyState;

type Decision = "keep" | "pass";

/** A real string rather than a blank screen, per the Ticket. */
export const EMPTY_DECK_MESSAGE = "No Profiles left in the Deck.";

/** Shown when the initial `GET /api/profiles` fails, so a dead network leaves Jack looking
 * at an explicit message rather than a Deck stuck on "loading" forever. */
export const LOAD_ERROR_MESSAGE = "Couldn't load the Deck.";

/** Shown when a Keep or Pass is recorded but fetching what comes next fails: the decision
 * already happened server-side, so staying on the same Profile with no explanation would
 * read as though nothing was recorded, not as though the network dropped. */
export const ADVANCE_ERROR_MESSAGE = "Couldn't load the next Profile.";

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

  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    fetchPage(null)
      .then((page) => setState(stateAfter(page)))
      .catch((error: unknown) => {
        console.error(error);
        setState({ status: "error", message: LOAD_ERROR_MESSAGE });
      });
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

    // `current.index` only ever comes from `stateAfter` or `stateAfterAdvancing`, both of
    // which keep it within `current.profiles`, so a "ready" state always has a Profile here.
    const profile = current.profiles[current.index]!;

    decidingRef.current = true;

    // A failed `recordSwipe` leaves the Deck exactly where it was: nothing happened
    // server-side, so the same Profile with its buttons still live is the honest state. A
    // failed `stateAfterAdvancing`, by contrast, follows a swipe that *did* land — staying on
    // the same Profile there would look like the decision was never recorded, so that path
    // gets its own explicit error instead.
    void recordSwipe(profile.id, decision).then(
      () =>
        stateAfterAdvancing(current)
          .then(setState)
          .catch((error: unknown) => {
            console.error(error);
            setState({ status: "error", message: ADVANCE_ERROR_MESSAGE });
          })
          .finally(() => {
            decidingRef.current = false;
          }),
      (error: unknown) => {
        console.error(error);
        decidingRef.current = false;
      },
    );
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

  if (state.status === "error") {
    return <p role="alert">{state.message}</p>;
  }

  if (state.status === "empty") {
    return <p>{EMPTY_DECK_MESSAGE}</p>;
  }

  // Same invariant as in `decide`: a "ready" state always has a valid index.
  const profile = state.profiles[state.index]!;

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
