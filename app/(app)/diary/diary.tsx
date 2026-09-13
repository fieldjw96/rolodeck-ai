"use client";

import { useEffect, useState } from "react";

import { StateNotice } from "../../../lib/ui/state-notice";
import styles from "./diary.module.css";

/** An Event as `GET /api/events` sends it. */
export type DiaryEntry = {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  location: string | null;
  url: string;
  important: boolean;
  kept_companies: string[];
};

type DiaryPage = {
  events: DiaryEntry[];
};

type DiaryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; events: DiaryEntry[] };

/** A designed empty state rather than a blank list, as on the Deck and the Watchlist. */
export const EMPTY_DIARY_MESSAGE = "No upcoming Events in the Diary.";
export const EMPTY_DIARY_WITH_PAST_MESSAGE = "No Events in the Diary yet.";

export const LOAD_ERROR_MESSAGE = "Couldn't load the Diary.";

export const LOADING_DIARY_MESSAGE = "Loading the Diary…";

/** The words that mark an important Event, so the marking never rests on colour alone. */
export const KEPT_ATTENDING_LABEL = "Kept company attending";

export const SHOW_PAST_LABEL = "Show past Events";

// The second line of each designed state, as in the Deck: what it means, or what to do next.
const LOADING_DIARY_DETAIL = "Reading the calendar of startup Events.";
const EMPTY_DIARY_DETAIL =
  "Events arrive when a Source is ingested. The ones a Kept company attends are marked.";
const EMPTY_DIARY_WITH_PAST_DETAIL =
  "Nothing has been ingested from an events Source yet.";
const LOAD_ERROR_DETAIL = "Check your connection, then reload the page.";

async function fetchDiary(includePast: boolean): Promise<DiaryPage> {
  const url = includePast ? "/api/events?include=past" : "/api/events";
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }

  return (await response.json()) as DiaryPage;
}

// Event dates are calendar dates, not instants, so they are formatted in UTC: formatting
// `2026-09-15` in the viewer's own zone would show the 14th anywhere west of Greenwich.
const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const formatDate = (isoDate: string): string =>
  dateFormat.format(new Date(`${isoDate}T00:00:00Z`));

function EventDates({ start, end }: { start: string; end: string | null }) {
  return (
    <p className={styles.when}>
      <time dateTime={start}>{formatDate(start)}</time>
      {end === null || end === start ? null : (
        <>
          {" – "}
          <time dateTime={end}>{formatDate(end)}</time>
        </>
      )}
    </p>
  );
}

function EventItem({ event }: { event: DiaryEntry }) {
  return (
    <article
      className={
        event.important ? `${styles.event} ${styles.important}` : styles.event
      }
    >
      <EventDates start={event.start_date} end={event.end_date} />
      <h2 className={styles.name}>
        <a
          className={styles.link}
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {event.name}
        </a>
      </h2>
      {event.location === null ? null : (
        <p className={styles.location}>{event.location}</p>
      )}
      {event.important ? (
        <p className={styles.flag}>
          <span className={styles.flagMark} aria-hidden="true">
            ★
          </span>
          <span className={styles.flagLabel}>{KEPT_ATTENDING_LABEL}:</span>{" "}
          {event.kept_companies.join(", ")}
        </p>
      ) : null}
    </article>
  );
}

/**
 * The calendar of startup Events, read through `GET /api/events` rather than Postgres
 * directly, per CLAUDE.md. Whether an Event is important arrives with it: this component
 * renders `important`, and never works it out.
 *
 * Every Event is listed, soonest first. An important one is marked three ways, so it reads as
 * important to someone who cannot tell the accent from the rest of the page: a heavier rule
 * down its edge, a star, and the words naming the Kept companies attending.
 */
export function Diary() {
  const [includePast, setIncludePast] = useState(false);
  const [state, setState] = useState<DiaryState>({ status: "loading" });

  useEffect(() => {
    let current = true;

    fetchDiary(includePast)
      .then((page) => {
        if (current) {
          setState({ status: "ready", events: page.events });
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        if (current) {
          setState({ status: "error" });
        }
      });

    // A toggle pressed twice quickly must not let the slower, older answer land last.
    return () => {
      current = false;
    };
  }, [includePast]);

  const togglePast = () => {
    setState({ status: "loading" });
    setIncludePast((shown) => !shown);
  };

  let body;

  if (state.status === "loading") {
    body = (
      <StateNotice
        busy
        title={LOADING_DIARY_MESSAGE}
        body={LOADING_DIARY_DETAIL}
      />
    );
  } else if (state.status === "error") {
    body = (
      <StateNotice
        tone="danger"
        live="alert"
        title={LOAD_ERROR_MESSAGE}
        body={LOAD_ERROR_DETAIL}
      />
    );
  } else if (state.events.length === 0) {
    body = includePast ? (
      <StateNotice
        title={EMPTY_DIARY_WITH_PAST_MESSAGE}
        body={EMPTY_DIARY_WITH_PAST_DETAIL}
      />
    ) : (
      <StateNotice title={EMPTY_DIARY_MESSAGE} body={EMPTY_DIARY_DETAIL} />
    );
  } else {
    body = (
      <ol className={styles.list}>
        {state.events.map((event) => (
          <li key={event.id}>
            <EventItem event={event} />
          </li>
        ))}
      </ol>
    );
  }

  const count = state.status === "ready" ? state.events.length : null;

  return (
    <main className={styles.diary}>
      <div className={styles.header}>
        <h1 className={styles.title}>Diary</h1>
        {count === null ? null : (
          <p className={styles.count}>
            {count} {count === 1 ? "Event" : "Events"}
          </p>
        )}
        <button
          className={styles.toggle}
          type="button"
          aria-pressed={includePast}
          onClick={togglePast}
        >
          {SHOW_PAST_LABEL}
        </button>
      </div>
      {body}
    </main>
  );
}
