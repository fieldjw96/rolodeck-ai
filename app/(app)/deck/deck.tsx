"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ProfileCard } from "../../../lib/ui/profile-card";
import { StateNotice } from "../../../lib/ui/state-notice";
import styles from "./deck.module.css";

type Profile = {
  id: string;
  name: string;
  description: string;
  sector: string;
  stage: string;
  location: string | null;
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
  | { status: "error"; message: string; detail: string }
  | ReadyState;

type Decision = "keep" | "pass";

/** A real string rather than a blank screen, per the Ticket. */
export const EMPTY_DECK_MESSAGE = "No Profiles left in the Deck.";

/** Shown while the first `GET /api/profiles` is in flight. The Deck used to render nothing
 * at all here, which is indistinguishable from a page that failed to boot. */
export const LOADING_DECK_MESSAGE = "Dealing the Deck…";

/** Shown when the initial `GET /api/profiles` fails, so a dead network leaves Jack looking
 * at an explicit message rather than a Deck stuck on "loading" forever. */
export const LOAD_ERROR_MESSAGE = "Couldn't load the Deck.";

/** Shown when a Keep or Pass is recorded but fetching what comes next fails: the decision
 * already happened server-side, so staying on the same Profile with no explanation would
 * read as though nothing was recorded, not as though the network dropped. */
export const ADVANCE_ERROR_MESSAGE = "Couldn't load the next Profile.";

// The second line of each designed state: what it means, or what to do next. Not exported,
// because the line a test pins a state on is the title above it.
const LOADING_DECK_DETAIL = "Fetching the Profiles you have not judged yet.";
const EMPTY_DECK_DETAIL =
  "Everything in the Deck has been Kept or Passed. More arrive the next time a Source runs.";
const LOAD_ERROR_DETAIL = "Check your connection, then reload the page.";
const ADVANCE_ERROR_DETAIL =
  "Your decision was recorded. Reload the page to carry on from the next Profile.";

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

  // Every state change goes through here, and the ref is written first. An effect would have
  // been a render behind: React flushes a passive effect in a task *after* the commit that
  // painted the new Profile, so a Keep clicked in that window read a stale `stateRef` — still
  // "loading" — and `decide` dropped the click on the floor with nothing to show for it. The
  // click was silently lost in the browser and made `deck.test.tsx` flaky under load.
  const commit = useCallback((next: DeckState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    fetchPage(null)
      .then((page) => commit(stateAfter(page)))
      .catch((error: unknown) => {
        console.error(error);
        commit({
          status: "error",
          message: LOAD_ERROR_MESSAGE,
          detail: LOAD_ERROR_DETAIL,
        });
      });
  }, [commit]);

  // Set synchronously, before the `await` inside `recordSwipe`, so a second Keep or Pass
  // fired before the first one's state update lands (arrow-key auto-repeat, a fast double
  // click) is ignored rather than recording a second swipe against the same Profile.
  const decidingRef = useRef(false);

  // Read from the ref rather than closing over `state`, so this stays one stable function
  // across renders and the keydown listener below does not need to be torn down and rebuilt
  // on every Keep or Pass.
  const decide = useCallback(
    (decision: Decision) => {
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
      // failed `stateAfterAdvancing`, by contrast, follows a swipe that *did* land — staying
      // on the same Profile there would look like the decision was never recorded, so that
      // path gets its own explicit error instead.
      void recordSwipe(profile.id, decision).then(
        () =>
          stateAfterAdvancing(current)
            .then(commit)
            .catch((error: unknown) => {
              console.error(error);
              commit({
                status: "error",
                message: ADVANCE_ERROR_MESSAGE,
                detail: ADVANCE_ERROR_DETAIL,
              });
            })
            .finally(() => {
              decidingRef.current = false;
            }),
        (error: unknown) => {
          console.error(error);
          decidingRef.current = false;
        },
      );
    },
    [commit],
  );

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
    return (
      <main className={styles.deck}>
        <StateNotice
          busy
          title={LOADING_DECK_MESSAGE}
          body={LOADING_DECK_DETAIL}
        />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className={styles.deck}>
        <StateNotice
          tone="danger"
          live="alert"
          title={state.message}
          body={state.detail}
        />
      </main>
    );
  }

  if (state.status === "empty") {
    return (
      <main className={styles.deck}>
        <StateNotice title={EMPTY_DECK_MESSAGE} body={EMPTY_DECK_DETAIL} />
      </main>
    );
  }

  // Same invariant as in `decide`: a "ready" state always has a valid index.
  const profile = state.profiles[state.index]!;

  return (
    <main className={styles.deck}>
      <ProfileCard
        headingLevel={1}
        name={profile.name}
        description={profile.description}
        sector={profile.sector}
        stage={profile.stage}
        location={profile.location}
      />

      {/*
       * Keep and Pass are the page's primary actions and are told apart without being read:
       * Pass is an outlined button carrying a cross, Keep a filled accent button carrying a
       * tick and taking half again the width. Colour is the last of those three signals, not
       * the only one — Ticket #12 asserts exactly that.
       */}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.action} ${styles.pass}`}
          onClick={() => decide("pass")}
        >
          <CrossIcon />
          Pass
          <kbd className={styles.hint} aria-hidden="true">
            ←
          </kbd>
        </button>
        <button
          type="button"
          className={`${styles.action} ${styles.keep}`}
          onClick={() => decide("keep")}
        >
          <TickIcon />
          Keep
          <kbd className={styles.hint} aria-hidden="true">
            →
          </kbd>
        </button>
      </div>
    </main>
  );
}

/*
 * Two paths of inline SVG rather than an icon dependency: `/deck` has a gzipped bundle budget
 * (`e2e/deck-performance.spec.ts`) and these cost a few dozen bytes between them. Both are
 * hidden from assistive tech, so each button's accessible name stays exactly "Pass" or "Keep".
 */

function CrossIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 4.5l7 7m0-7l-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3.5 8.5l3 3 6-6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
