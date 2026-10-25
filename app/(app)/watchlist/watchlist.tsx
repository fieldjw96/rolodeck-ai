"use client";

import { useEffect, useRef, useState } from "react";

import type { CompanyLinks, Founder } from "../../../db/profile-input";
import { Dialog } from "../../../lib/ui/dialog";
import { ProfileCard } from "../../../lib/ui/profile-card";
import { StateNotice } from "../../../lib/ui/state-notice";
import styles from "./watchlist.module.css";

type KeptProfile = {
  id: string;
  name: string;
  sector: string;
  stage: string;
  location: string | null;
  // What the full card reads. `GET /api/profiles` sends all of it with every Profile.
  description?: string;
  website?: string | null;
  founders?: Founder[] | null;
  links?: CompanyLinks | null;
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

/** Names the Profile, so the reader knows exactly what did not take back. */
export function passErrorMessage(name: string): string {
  return `Couldn't Pass ${name}.`;
}

type PassState = { status: "idle" } | { status: "pending" } | { status: "error" };

async function fetchKept(): Promise<ProfilesPage> {
  const response = await fetch("/api/profiles?filter=kept");

  if (!response.ok) {
    throw new Error(
      `GET /api/profiles?filter=kept failed with ${response.status}`,
    );
  }

  return (await response.json()) as ProfilesPage;
}

/** Throws on a non-2xx response, the same contract the Deck's own `recordSwipe` keeps, so a
 * Pass that failed server-side is never mistaken for one that was recorded. */
async function recordPass(id: string): Promise<void> {
  const url = `/api/profiles/${id}/pass`;
  const response = await fetch(url, { method: "POST" });

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}`);
  }
}

/**
 * Every Profile Jack has Kept, read through `GET /api/profiles?filter=kept` rather than
 * Postgres directly, per CLAUDE.md. There is no paging and no Keep here: the Watchlist is a
 * read-only view of a decision already made, except that the decision can be taken back — the
 * open card's Pass button sends the same `POST /api/profiles/:id/pass` the Deck does, which
 * `recordSwipe` (`db/deck.ts`) treats as the newer decision overwriting the old one.
 */
export function Watchlist() {
  const [state, setState] = useState<WatchlistState>({ status: "loading" });
  const [openId, setOpenId] = useState<string | null>(null);
  // The row button that opened the card, which the Dialog returns focus to on close.
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [passState, setPassState] = useState<PassState>({ status: "idle" });
  // The Watchlist's own heading, so focus has somewhere to go once a successful Pass has
  // removed the row the Dialog's own return-focus would otherwise have aimed at.
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set the instant a Pass succeeds and read by the effect below once the Dialog has actually
  // unmounted, rather than focusing the heading while it is still behind an open dialog.
  const focusHeadingRef = useRef(false);

  useEffect(() => {
    if (openId === null && focusHeadingRef.current) {
      focusHeadingRef.current = false;
      headingRef.current?.focus();
    }
  }, [openId]);

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
  const open = state.profiles.find((profile) => profile.id === openId);

  async function pass(profile: KeptProfile) {
    setPassState({ status: "pending" });

    try {
      await recordPass(profile.id);
    } catch (error) {
      console.error(error);
      setPassState({ status: "error" });
      return;
    }

    // The opener button is about to be removed along with its row, so the Dialog's own
    // return-focus has nothing left to aim at; the effect above sends focus to the heading
    // once `openId` actually reaches null.
    focusHeadingRef.current = true;
    setOpener(null);
    setOpenId(null);
    setPassState({ status: "idle" });
    setState((previous) => {
      if (previous.status !== "ready") {
        return previous;
      }

      const profiles = previous.profiles.filter((p) => p.id !== profile.id);

      return profiles.length === 0
        ? { status: "empty" }
        : { status: "ready", profiles };
    });
  }

  return (
    <main className={styles.watchlist}>
      <div className={styles.header}>
        <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
          Watchlist
        </h1>
        <p className={styles.count}>
          {count} Kept {count === 1 ? "Profile" : "Profiles"}
        </p>
      </div>
      <ul className={styles.grid}>
        {state.profiles.map((profile) => (
          <li key={profile.id} className={styles.row}>
            <ProfileCard
              compact
              headingLevel={2}
              name={profile.name}
              sector={profile.sector}
              stage={profile.stage}
              location={profile.location}
            />
            {/* The row's way in: a button stretched over the compact card, so the card keeps
                showing exactly what it did and the control is a real one. */}
            <button
              type="button"
              className={styles.open}
              aria-haspopup="dialog"
              onClick={(event) => {
                setOpener(event.currentTarget);
                setOpenId(profile.id);
                setPassState({ status: "idle" });
              }}
            >
              <span className={styles.openLabel}>Open {profile.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {open === undefined ? null : (
        <Dialog
          label={open.name}
          returnFocusTo={opener}
          onClose={() => setOpenId(null)}
        >
          {/* The Deck's card, unchanged, with no Keep: the Watchlist is decisions already
              made. Pass is the one decision a Watchlist row can still change, taking back a
              Keep made by mistake — `recordSwipe` (`db/deck.ts`) treats it as the newer
              decision overwriting the old one, same as a Pass from the Deck itself. */}
          <ProfileCard
            headingLevel={2}
            name={open.name}
            description={open.description}
            sector={open.sector}
            stage={open.stage}
            location={open.location}
            website={open.website}
            founders={open.founders}
            links={open.links}
          />
          {passState.status === "error" ? (
            <div role="alert" className={styles.passError}>
              <p>{passErrorMessage(open.name)}</p>
              <button
                type="button"
                className={styles.retry}
                onClick={() => pass(open)}
              >
                Retry
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.pass}
              disabled={passState.status === "pending"}
              onClick={() => pass(open)}
            >
              Pass
            </button>
          )}
        </Dialog>
      )}
    </main>
  );
}
