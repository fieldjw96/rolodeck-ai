"use client";

import { useEffect, useRef, useState } from "react";

import type { CompanyLinks, Founder } from "../../../db/profile-input";
import { Dialog } from "../../../lib/ui/dialog";
import {
  ProfileCard,
  type EventsTabEvent,
  type EventsTabState,
  type NewsTabArticle,
  type NewsTabState,
} from "../../../lib/ui/profile-card";
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

/** Names the Profile, so the reader knows exactly which Pass did not save. */
export function passErrorMessage(name: string): string {
  return `Couldn't Pass ${name}.`;
}

type PassStatus = "pending" | "error";

async function fetchKept(): Promise<ProfilesPage> {
  const response = await fetch("/api/profiles?filter=kept");

  if (!response.ok) {
    throw new Error(
      `GET /api/profiles?filter=kept failed with ${response.status}`,
    );
  }

  return (await response.json()) as ProfilesPage;
}

type NewsItemWire = {
  id: string;
  title: string;
  url: string;
  published_at: string;
  source_name: string;
};

/** The open card's News tab, read through `GET /api/profiles/:id/news` rather than Postgres
 * directly, per CLAUDE.md. */
async function fetchProfileNews(profileId: string): Promise<NewsTabArticle[]> {
  const url = `/api/profiles/${profileId}/news`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }

  const body = (await response.json()) as { items: NewsItemWire[] };

  return body.items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    publishedAt: item.published_at,
    sourceName: item.source_name,
  }));
}

type EventItemWire = {
  id: string;
  name: string;
  url: string;
  start_date: string;
  end_date: string | null;
  location: string | null;
};

/** The open card's Events tab, read through `GET /api/profiles/:id/events` rather than
 * Postgres directly, per CLAUDE.md. */
async function fetchProfileEvents(
  profileId: string,
): Promise<EventsTabEvent[]> {
  const url = `/api/profiles/${profileId}/events`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }

  const body = (await response.json()) as { items: EventItemWire[] };

  return body.items.map((item) => ({
    id: item.id,
    name: item.name,
    url: item.url,
    startDate: item.start_date,
    endDate: item.end_date,
    location: item.location,
  }));
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
  // Keyed by Profile id rather than held as one Watchlist-wide value, so a Pass that lands
  // after the reader has closed its Dialog, or opened a different Profile, updates only the
  // row it was ever about rather than whichever Dialog happens to be open when it lands.
  const [passStatuses, setPassStatuses] = useState<
    ReadonlyMap<string, PassStatus>
  >(new Map());
  // The Watchlist's own heading, so focus has somewhere to go once a successful Pass has
  // removed the row the Dialog's own return-focus would otherwise have aimed at.
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set the instant a Pass succeeds and read by the effect below once the Dialog has actually
  // unmounted, rather than focusing the heading while it is still behind an open dialog.
  const focusHeadingRef = useRef(false);
  // The Profile id whose Dialog is open right now, read by `pass` once its request settles.
  // `openId` itself is stale inside that closure: a late response must act on the Dialog that
  // is open when it lands, not the one that was open when the request was sent.
  const openIdRef = useRef(openId);

  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

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
        {/* The Pass that emptied the Watchlist focuses this heading below, same as the
            ready branch's: without it here, that focus would land nowhere. */}
        <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
          Watchlist
        </h1>
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
    setPassStatuses((statuses) => new Map(statuses).set(profile.id, "pending"));

    try {
      await recordPass(profile.id);
    } catch (error) {
      console.error(error);
      setPassStatuses((statuses) => new Map(statuses).set(profile.id, "error"));
      return;
    }

    setPassStatuses((statuses) => {
      const next = new Map(statuses);
      next.delete(profile.id);
      return next;
    });
    setState((previous) => {
      if (previous.status !== "ready") {
        return previous;
      }

      const profiles = previous.profiles.filter((p) => p.id !== profile.id);

      return profiles.length === 0
        ? { status: "empty" }
        : { status: "ready", profiles };
    });

    // Only the Dialog that is still open on this Profile closes over a Pass that lands late:
    // the reader may since have closed it, or opened a different Profile, while this request
    // was in flight, and that Dialog's own close is not this Pass's to take.
    if (openIdRef.current === profile.id) {
      // The opener button is about to be removed along with its row, so the Dialog's own
      // return-focus has nothing left to aim at; the effect above sends focus to the heading
      // once `openId` actually reaches null.
      focusHeadingRef.current = true;
      setOpener(null);
      setOpenId(null);
    }
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
                // Clear a stale error from a previous attempt so the reopened Dialog starts
                // clean; a request already in flight for this Profile is left alone, so the
                // Pass button stays disabled rather than inviting a second POST.
                setPassStatuses((statuses) => {
                  if (statuses.get(profile.id) !== "error") {
                    return statuses;
                  }

                  const next = new Map(statuses);
                  next.delete(profile.id);
                  return next;
                });
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
              made, except that the Pass button below can still take one back. Keyed by
              Profile id so a different Profile's `OpenCard` is a fresh mount rather than one
              carrying over the last one's News and Events. */}
          <OpenCard
            key={open.id}
            profile={open}
            passStatus={passStatuses.get(open.id)}
            onPass={() => pass(open)}
          />
        </Dialog>
      )}
    </main>
  );
}

/**
 * The open Dialog's card, its News and Events tabs, and its Pass button. Split out from
 * `Watchlist` so its own `useState` starts fresh at "loading" on every mount rather than
 * needing an effect to reset it: a new `OpenCard` mounts exactly when a different Profile's
 * Dialog opens, since the Dialog unmounts entirely while none is open (per CLAUDE.md on the
 * card fetching nothing itself, this is the caller that does).
 */
function OpenCard({
  profile,
  passStatus,
  onPass,
}: {
  profile: KeptProfile;
  passStatus: PassStatus | undefined;
  onPass: () => void;
}) {
  const [newsState, setNewsState] = useState<NewsTabState>({
    status: "loading",
  });
  const [eventsState, setEventsState] = useState<EventsTabState>({
    status: "loading",
  });

  // Two small, separate requests rather than one, so a slow or failed one never holds up the
  // other tab or the Company tab beside them. `current` guards both against a response for a
  // card the reader has since closed.
  useEffect(() => {
    let current = true;

    fetchProfileNews(profile.id)
      .then((items) => {
        if (current) {
          setNewsState({ status: "ready", items });
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        if (current) {
          setNewsState({ status: "error" });
        }
      });

    fetchProfileEvents(profile.id)
      .then((items) => {
        if (current) {
          setEventsState({ status: "ready", items });
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        if (current) {
          setEventsState({ status: "error" });
        }
      });

    return () => {
      current = false;
    };
  }, [profile.id]);

  return (
    <>
      <ProfileCard
        headingLevel={2}
        name={profile.name}
        description={profile.description}
        sector={profile.sector}
        stage={profile.stage}
        location={profile.location}
        website={profile.website}
        founders={profile.founders}
        links={profile.links}
        news={newsState}
        events={eventsState}
      />
      {passStatus === "error" ? (
        <div role="alert" className={styles.passError}>
          <p>{passErrorMessage(profile.name)}</p>
          <button type="button" className={styles.retry} onClick={onPass}>
            Retry
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={styles.pass}
          disabled={passStatus === "pending"}
          onClick={onPass}
        >
          Pass
        </button>
      )}
    </>
  );
}
