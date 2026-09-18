"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CompanyLinks, Founder } from "../../../db/profile-input";
import { ProfileCard } from "../../../lib/ui/profile-card";
import { StateNotice } from "../../../lib/ui/state-notice";
import styles from "./deck.module.css";

type Profile = {
  id: string;
  name: string;
  description: string;
  sector: string;
  stage: string;
  website: string | null;
  location: string | null;
  founders: Founder[] | null;
  links: CompanyLinks | null;
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
  // The reader has decided every Profile dealt so far and the next page, fetched by
  // `nextCursor`, has not arrived yet. `PREFETCH_AT_REMAINING` exists so this is rare.
  | { status: "dealing"; nextCursor: string }
  | ReadyState;

type Decision = "keep" | "pass";

/** A Keep or Pass whose write came back failed, kept on screen until a retry lands. */
type UnsavedSwipe = {
  profile: Profile;
  decision: Decision;
  retrying: boolean;
};

/**
 * How many Profiles may be left in hand, counting the one on screen, before the next page is
 * fetched. Fetching a page is one round trip, measured at about 100 ms to production before
 * auth and the query are added, and a reader deciding as fast as they can read a name still
 * spends a few hundred milliseconds a Profile. Five Profiles is over a second of that pace:
 * several page fetches of headroom, so the next page is in hand before the reader reaches the
 * end of this one. In Profiles rather than time, because the reader's pace is what runs the
 * Deck down.
 */
export const PREFETCH_AT_REMAINING = 5;

/** A real string rather than a blank screen, per the Ticket. */
export const EMPTY_DECK_MESSAGE = "No Profiles left in the Deck.";

/** Shown while the first `GET /api/profiles` is in flight. The Deck used to render nothing
 * at all here, which is indistinguishable from a page that failed to boot. */
export const LOADING_DECK_MESSAGE = "Dealing the Deck…";

/** Shown when the initial `GET /api/profiles` fails, so a dead network leaves Jack looking
 * at an explicit message rather than a Deck stuck on "loading" forever. */
export const LOAD_ERROR_MESSAGE = "Couldn't load the Deck.";

/** Shown when the reader reaches the end of what has been dealt and fetching the next page
 * fails, so the Deck does not sit on "loading" forever with no explanation. */
export const ADVANCE_ERROR_MESSAGE = "Couldn't load the next Profile.";

const DECISION_LABEL: Record<Decision, string> = { keep: "Keep", pass: "Pass" };

/** Names the company and the decision, so the reader knows exactly what did not save. */
export function unsavedMessage(name: string, decision: Decision): string {
  return `Couldn't save your ${DECISION_LABEL[decision]} on ${name}.`;
}

// The second line of each designed state: what it means, or what to do next. Not exported,
// because the line a test pins a state on is the title above it.
const LOADING_DECK_DETAIL = "Fetching the Profiles you have not judged yet.";
const EMPTY_DECK_DETAIL =
  "Everything in the Deck has been Kept or Passed. More arrive the next time a Source runs.";
const LOAD_ERROR_DETAIL = "Check your connection, then reload the page.";
const ADVANCE_ERROR_DETAIL =
  "Check your connection, then reload the page to carry on from the next Profile.";

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
 * one that was recorded. `keepalive` lets a write already in flight finish if the reader
 * closes the tab straight after deciding, which they can now that nothing waits on it. */
async function recordSwipe(id: string, decision: Decision): Promise<void> {
  const url = `/api/profiles/${id}/${decision}`;
  const response = await fetch(url, { method: "POST", keepalive: true });

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}`);
  }
}

/**
 * Deals `page` in behind `remaining`, the Profiles still in hand, leaving out any Profile
 * already decided this session or already in hand. The server stops dealing a Profile once
 * its swipe lands, but a swipe can still be in flight, or have failed, when a page is fetched.
 */
function stateAfter(
  remaining: Profile[],
  page: ProfilesPage,
  decided: ReadonlySet<string>,
): DeckState {
  const inHand = new Set(remaining.map((profile) => profile.id));
  const profiles = [
    ...remaining,
    ...page.profiles.filter(
      (profile) => !decided.has(profile.id) && !inHand.has(profile.id),
    ),
  ];

  if (profiles.length > 0) {
    return {
      status: "ready",
      profiles,
      index: 0,
      nextCursor: page.next_cursor,
    };
  }

  return page.next_cursor === null
    ? { status: "empty" }
    : { status: "dealing", nextCursor: page.next_cursor };
}

/**
 * Advances past the Profile at `current.index`, synchronously: the next Profile in hand, or
 * the empty state when the Deck has nothing more, or "dealing" when the next page is still
 * on its way.
 */
function stateAfterAdvancing(current: ReadyState): DeckState {
  const nextIndex = current.index + 1;

  if (nextIndex < current.profiles.length) {
    return { ...current, index: nextIndex };
  }

  return current.nextCursor === null
    ? { status: "empty" }
    : { status: "dealing", nextCursor: current.nextCursor };
}

/** The cursor of the page the Deck needs fetched now, or null if it has enough in hand. */
function cursorToFetch(state: DeckState): string | null {
  if (state.status === "dealing") {
    return state.nextCursor;
  }

  if (
    state.status === "ready" &&
    state.profiles.length - state.index <= PREFETCH_AT_REMAINING
  ) {
    return state.nextCursor;
  }

  return null;
}

/**
 * The core product surface: the current Profile from the Deck, with Keep and Pass. Kept as a
 * Client Component so it can hold the Deck's position and answer arrow keys; `page.tsx` is the
 * server-rendered shell around it. Every read and write still goes through `/api/profiles`
 * rather than Postgres directly, per CLAUDE.md.
 *
 * A decision advances the Deck first and is recorded after: nothing on the network sits
 * between a Keep or Pass and the next Profile. A write that fails is rarer than one that
 * succeeds, so rather than make every swipe wait to be sure, a failure is surfaced by name,
 * with a retry, however far the reader has moved on.
 */
export function Deck() {
  const [state, setState] = useState<DeckState>({ status: "loading" });
  const stateRef = useRef(state);
  const [unsaved, setUnsaved] = useState<UnsavedSwipe[]>([]);

  // Every state change goes through here, and the ref is written first. An effect would have
  // been a render behind: React flushes a passive effect in a task *after* the commit that
  // painted the new Profile, so a Keep clicked in that window read a stale `stateRef` — still
  // "loading" — and `decide` dropped the click on the floor with nothing to show for it. The
  // click was silently lost in the browser and made `deck.test.tsx` flaky under load. It
  // matters more now that decisions come as fast as the reader can make them.
  const commit = useCallback((next: DeckState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Every Profile decided this session, added synchronously in `decide`. This is what makes a
  // decision exactly once per Profile: `decide` refuses a Profile already in it, and no page
  // is dealt with one of them in, whatever order the writes behind them complete in.
  const decidedRef = useRef(new Set<string>());

  // The Profiles with a write in flight, so a retry clicked twice, or clicked while the first
  // write is still out, cannot record the same Profile twice.
  const savingRef = useRef(new Set<string>());

  // The cursor of the page being fetched, so a re-render does not fetch it a second time.
  const fetchingRef = useRef<string | null>(null);

  useEffect(() => {
    fetchPage(null)
      .then((page) => commit(stateAfter([], page, decidedRef.current)))
      .catch((error: unknown) => {
        console.error(error);
        commit({
          status: "error",
          message: LOAD_ERROR_MESSAGE,
          detail: LOAD_ERROR_DETAIL,
        });
      });
  }, [commit]);

  // Fetches the next page ahead of need, and runs after the render that showed the next
  // Profile, never between a decision and it. A prefetch that fails is only worth telling the
  // reader about once they are actually waiting on it; before then the next decision retries.
  useEffect(() => {
    const cursor = cursorToFetch(state);

    if (cursor === null || fetchingRef.current === cursor) {
      return;
    }

    fetchingRef.current = cursor;

    fetchPage(cursor)
      .then((page) => {
        const current = stateRef.current;

        // Only the state that asked for this page can take it: its cursor is the proof.
        if (current.status === "ready" && current.nextCursor === cursor) {
          commit(
            stateAfter(
              current.profiles.slice(current.index),
              page,
              decidedRef.current,
            ),
          );
        } else if (
          current.status === "dealing" &&
          current.nextCursor === cursor
        ) {
          commit(stateAfter([], page, decidedRef.current));
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        fetchingRef.current = null;

        const current = stateRef.current;

        if (current.status === "dealing" && current.nextCursor === cursor) {
          commit({
            status: "error",
            message: ADVANCE_ERROR_MESSAGE,
            detail: ADVANCE_ERROR_DETAIL,
          });
        }
      });
  }, [state, commit]);

  const save = useCallback((profile: Profile, decision: Decision) => {
    if (savingRef.current.has(profile.id)) {
      return;
    }

    savingRef.current.add(profile.id);

    const settle = (failed: boolean) => {
      savingRef.current.delete(profile.id);
      setUnsaved((list) => {
        const others = list.filter((swipe) => swipe.profile.id !== profile.id);

        if (failed) {
          return [...others, { profile, decision, retrying: false }];
        }

        // The common case, a first write that landed: keep the same list so nothing renders.
        return others.length === list.length ? list : others;
      });
    };

    recordSwipe(profile.id, decision).then(
      () => settle(false),
      (error: unknown) => {
        console.error(error);
        settle(true);
      },
    );
  }, []);

  const retry = useCallback(
    (swipe: UnsavedSwipe) => {
      setUnsaved((list) =>
        list.map((other) =>
          other.profile.id === swipe.profile.id
            ? { ...other, retrying: true }
            : other,
        ),
      );
      save(swipe.profile, swipe.decision);
    },
    [save],
  );

  // Read from the ref rather than closing over `state`, so this stays one stable function
  // across renders and the keydown listener below does not need to be torn down and rebuilt
  // on every Keep or Pass.
  const decide = useCallback(
    (decision: Decision) => {
      const current = stateRef.current;

      if (current.status !== "ready") {
        return;
      }

      // `current.index` only ever comes from `stateAfter` or `stateAfterAdvancing`, both of
      // which keep it within `current.profiles`, so a "ready" state always has a Profile here.
      const profile = current.profiles[current.index]!;

      if (decidedRef.current.has(profile.id)) {
        return;
      }

      decidedRef.current.add(profile.id);

      // Advance first, then record. A second decision fired before React re-renders (a fast
      // double click, arrow-key auto-repeat) reads the advanced `stateRef` and decides the
      // next Profile, which is what the reader asked for, rather than being swallowed.
      commit(stateAfterAdvancing(current));
      save(profile, decision);
    },
    [commit, save],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A key something inside the page has already claimed, such as an arrow key moving
      // between the card's tabs, is not a Keep or a Pass.
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "ArrowLeft") {
        decide("pass");
      } else if (event.key === "ArrowRight") {
        decide("keep");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide]);

  // Shown whatever state the Deck is in, since the reader has usually moved on by the time a
  // write comes back failed, possibly to the end of the Deck.
  const unsavedNotice =
    unsaved.length === 0 ? null : (
      <div role="alert" className={styles.unsaved}>
        <ul className={styles.unsavedList}>
          {unsaved.map((swipe) => (
            <li key={swipe.profile.id} className={styles.unsavedItem}>
              <span>{unsavedMessage(swipe.profile.name, swipe.decision)}</span>
              <button
                type="button"
                className={styles.retry}
                disabled={swipe.retrying}
                aria-label={`Retry ${DECISION_LABEL[swipe.decision]} on ${swipe.profile.name}`}
                onClick={() => retry(swipe)}
              >
                {swipe.retrying ? "Retrying…" : "Retry"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  if (state.status === "loading" || state.status === "dealing") {
    return (
      <main className={styles.deck}>
        {unsavedNotice}
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
        {unsavedNotice}
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
        {unsavedNotice}
        <StateNotice title={EMPTY_DECK_MESSAGE} body={EMPTY_DECK_DETAIL} />
      </main>
    );
  }

  // Same invariant as in `decide`: a "ready" state always has a valid index.
  const profile = state.profiles[state.index]!;

  return (
    <main className={styles.deck}>
      {unsavedNotice}

      {/* Keyed by Profile, so every Profile opens on the Company tab rather than on
          whichever tab the last one was left on. */}
      <ProfileCard
        key={profile.id}
        headingLevel={1}
        name={profile.name}
        description={profile.description}
        sector={profile.sector}
        stage={profile.stage}
        location={profile.location}
        website={profile.website}
        founders={profile.founders}
        links={profile.links}
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
