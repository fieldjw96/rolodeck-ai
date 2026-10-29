"use client";

import { useId, useState, type KeyboardEvent } from "react";

import { NOT_STATED_STAGE } from "../../db/not-stated-stage";
import type { CompanyLinks, Founder } from "../../db/profile-input";
import { SECTOR_LABELS } from "../../db/sector-labels";
import { STAGE_LABELS } from "../../db/stage-labels";
import styles from "./profile-card.module.css";

/**
 * A Sector or Stage's label, or the raw value where it names none: every caller in this repo
 * passes a value out of `SECTOR_VALUES`/`STAGE_VALUES`, but the prop is typed as a plain
 * `string` so a test fixture may pass anything.
 */
function labelOf(
  value: string,
  labels: Readonly<Record<string, string>>,
): string {
  return Object.hasOwn(labels, value) ? labels[value]! : value;
}

/** One article for the News tab, as the Watchlist reads it off `GET /api/profiles/:id/news`. */
export type NewsTabArticle = {
  id: string;
  title: string;
  url: string;
  /** An ISO instant, same as `published_at` travels on the wire. */
  publishedAt: string;
  sourceName: string;
};

/** One Event for the Events tab, as the Watchlist reads it off
 * `GET /api/profiles/:id/events`. */
export type EventsTabEvent = {
  id: string;
  name: string;
  url: string;
  /** A calendar date, `YYYY-MM-DD`, same as `start_date`/`end_date` travel on the wire. */
  startDate: string;
  endDate: string | null;
  location: string | null;
};

/** The News tab's state: the card fetches nothing itself, so whoever passes this prop owns
 * the request and hands the card whichever of these it has reached. */
export type NewsTabState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: readonly NewsTabArticle[] };

/** The Events tab's state, the same shape `NewsTabState` is for the same reason. */
export type EventsTabState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: readonly EventsTabEvent[] };

type ProfileCardProps = {
  name: string;
  sector: string;
  stage: string;
  /** The Watchlist reads no description, so the card renders without one rather than with a
   * gap where one would be. */
  description?: string;
  /** Not every Source states a location, so the field is left off the card rather than
   * shown blank, matching how `description` above is handled. */
  location?: string | null;
  /** The company's own site, the first of its links on the Contact tab. */
  website?: string | null;
  /** The people a Source states are behind the company. Null or absent when it stated nobody,
   * which is never the same claim as a company with no founders: see `founderListSchema`. */
  founders?: readonly Founder[] | null;
  /** The company's own links beyond `website`. Null or absent when the Source stated none. */
  links?: CompanyLinks | null;
  /** The Deck's card is the page's only subject and carries its `h1`; the Watchlist's cards
   * sit under a heading of their own, so theirs are one level down. */
  headingLevel: 1 | 2;
  /** The Watchlist's grid variant: the same card, tighter, with a smaller name, and none of
   * the full card's founder strip or tabs. */
  compact?: boolean;
  /** A News tab after Contact, present exactly when this is passed. The Deck passes neither
   * this nor `events`, so its card keeps its three tabs; the Watchlist's Dialog passes both. */
  news?: NewsTabState;
  /** An Events tab after Contact (and after News, where both are passed), present exactly
   * when this is passed. */
  events?: EventsTabState;
};

/**
 * One Profile as a card. Shared by the Deck and the Watchlist so the two cannot drift: the
 * Ticket asks for a Watchlist "consistent with the Deck's card", and this is that consistency
 * expressed as a single component rather than as two stylesheets that happen to agree.
 *
 * A presentation component: it renders what it is handed and fetches nothing. The only state
 * it holds is which tab is open, and a caller that wants every Profile to open on Company
 * gives each Profile its own `key`.
 */
export function ProfileCard(props: ProfileCardProps) {
  return props.compact === true ? (
    <CompactCard {...props} />
  ) : (
    <FullCard {...props} />
  );
}

/** The Watchlist's card, exactly as it was before the full card grew tabs. */
function CompactCard({
  name,
  sector,
  stage,
  description,
  location,
  headingLevel,
}: ProfileCardProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <article className={`${styles.card} ${styles.compact}`}>
      <Heading className={styles.name}>{name}</Heading>

      {description === undefined ? null : (
        <p className={styles.description}>{description}</p>
      )}

      <dl className={styles.meta}>
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>Sector</dt>
          <dd className={styles.fieldValue}>
            {labelOf(sector, SECTOR_LABELS)}
          </dd>
        </div>
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>Stage</dt>
          <StageValue stage={stage} className={styles.fieldValue} />
        </div>
        {location === null || location === undefined ? null : (
          <div className={styles.field}>
            <dt className={styles.fieldLabel}>Location</dt>
            <dd className={styles.fieldValue}>{location}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

/**
 * A stage the Source never stated reads as that, in words and set apart, rather than as a slug
 * that looks like one more stage. See docs/adr/0015.
 */
function StageValue({
  stage,
  className,
}: {
  stage: string;
  className: string | undefined;
}) {
  return stage === NOT_STATED_STAGE ? (
    <dd className={`${className} ${styles.notStated}`}>
      {labelOf(stage, STAGE_LABELS)}
    </dd>
  ) : (
    <dd className={className}>{labelOf(stage, STAGE_LABELS)}</dd>
  );
}

type Tab = "company" | "team" | "contact" | "news" | "events";

const TAB_LABELS: Record<Tab, string> = {
  company: "Company",
  team: "Team",
  contact: "Contact",
  news: "News",
  events: "Events",
};

function FullCard({
  name,
  sector,
  stage,
  description,
  location,
  website,
  founders,
  links,
  headingLevel,
  news,
  events,
}: ProfileCardProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const stated = founders ?? [];
  // A Profile with no founders has no Team tab at all, rather than one that opens on nothing.
  // News and Events follow Contact, each present exactly when its prop is passed, per the
  // Ticket: the Deck passes neither, so its card is unaffected.
  const tabs: Tab[] = [
    "company",
    ...(stated.length > 0 ? (["team"] as const) : []),
    "contact",
    ...(news === undefined ? [] : (["news"] as const)),
    ...(events === undefined ? [] : (["events"] as const)),
  ];
  const [selected, setSelected] = useState<Tab>("company");
  const id = useId();
  const tabId = (tab: Tab) => `${id}-tab-${tab}`;
  const panelId = (tab: Tab) => `${id}-panel-${tab}`;

  // The WAI-ARIA tabs pattern: one stop in the tab order, the arrow keys (and Home and End)
  // moving between tabs, and selection following focus. `preventDefault` is also what tells
  // the Deck's own arrow-key listener that this key was a tab change and not a Keep or Pass.
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.indexOf(selected);
    const target =
      event.key === "ArrowRight"
        ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs[tabs.length - 1]
              : undefined;

    if (target === undefined) {
      return;
    }

    event.preventDefault();
    setSelected(target);
    document.getElementById(tabId(target))?.focus();
  }

  return (
    <article className={styles.card}>
      <header className={styles.header}>
        <Heading className={`${styles.name} ${styles.displayName}`}>
          {name}
        </Heading>
        {description === undefined ? null : (
          <p className={styles.tagline}>{firstSentence(description)}</p>
        )}
      </header>

      {stated.length === 0 ? null : (
        <div className={styles.strip}>
          <ul className={styles.stack} aria-label="Founders">
            {stated.map((founder, index) => (
              <li key={index} className={styles.stackItem}>
                <Initials name={founder.name} labelled />
              </li>
            ))}
          </ul>
          <p className={styles.headcount}>
            {countOf(stated.length, "founder")}
          </p>
        </div>
      )}

      <div role="tablist" aria-label={`About ${name}`} className={styles.tabs}>
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={tabId(tab)}
            aria-controls={panelId(tab)}
            aria-selected={tab === selected}
            tabIndex={tab === selected ? 0 : -1}
            className={styles.tab}
            onClick={() => setSelected(tab)}
            onKeyDown={onTabKeyDown}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab}
          role="tabpanel"
          id={panelId(tab)}
          aria-labelledby={tabId(tab)}
          hidden={tab !== selected}
          className={styles.panel}
        >
          {tab === "company" ? (
            <CompanyPanel
              description={description}
              sector={sector}
              stage={stage}
              location={location}
            />
          ) : tab === "team" ? (
            <TeamPanel founders={stated} />
          ) : tab === "contact" ? (
            <ContactPanel website={website} links={links} founders={stated} />
          ) : tab === "news" ? (
            // `tabs` only ever includes "news" when `news` is passed.
            <NewsPanel state={news!} />
          ) : (
            // `tabs` only ever includes "events" when `events` is passed.
            <EventsPanel state={events!} />
          )}
        </div>
      ))}
    </article>
  );
}

function CompanyPanel({
  description,
  sector,
  stage,
  location,
}: {
  description: string | undefined;
  sector: string;
  stage: string;
  location: string | null | undefined;
}) {
  return (
    <>
      <dl className={styles.figures}>
        <div className={styles.figure}>
          <dt className={styles.fieldLabel}>Stage</dt>
          <StageValue stage={stage} className={styles.figureValue} />
        </div>
        {location === null || location === undefined ? null : (
          <div className={styles.figure}>
            <dt className={styles.fieldLabel}>Location</dt>
            <dd className={styles.figureValue}>{location}</dd>
          </div>
        )}
      </dl>

      {/* The longer description, in full, where the header could only carry its first
          sentence. One that is a single sentence already reads whole in the header, so the
          panel does not repeat it and the figures lead straight into the sectors. */}
      {description === undefined ||
      firstSentence(description) === description.trim() ? null : (
        <p className={styles.longDescription}>{description.trim()}</p>
      )}

      <ul className={styles.chips} aria-label="Sectors">
        <li className={styles.chip}>{labelOf(sector, SECTOR_LABELS)}</li>
      </ul>
    </>
  );
}

/**
 * The header's one line: a Profile stores one description, which for a Source like YC is a
 * paragraph, so the header takes its first sentence and the Company panel carries the rest.
 * A sentence ends at `.`, `!` or `?` followed by whitespace; a description with no such break
 * is one sentence, returned whole.
 */
export function firstSentence(description: string): string {
  const trimmed = description.trim();
  const end = /[.!?](?=\s)/.exec(trimmed);
  return end === null ? trimmed : trimmed.slice(0, end.index + 1);
}

function TeamPanel({ founders }: { founders: readonly Founder[] }) {
  return (
    <ul className={styles.people}>
      {founders.map((founder, index) => (
        <li key={index} className={styles.person}>
          <Initials name={founder.name} />
          {/* Name, then role, then biography, each only where stated: an empty biography
              leaves no gap where it would have been. */}
          <div className={styles.personText}>
            <p className={styles.personName}>{founder.name}</p>
            {founder.role === undefined ? null : (
              <p className={styles.personRole}>{founder.role}</p>
            )}
            {founder.bio === undefined ? null : (
              <p className={styles.personBio}>{founder.bio}</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ContactPanel({
  website,
  links,
  founders,
}: {
  website: string | null | undefined;
  links: CompanyLinks | null | undefined;
  founders: readonly Founder[];
}) {
  const companyLinks = [
    { label: "Website", href: website },
    { label: "LinkedIn", href: links?.linkedin },
    { label: "X", href: links?.twitter },
    { label: "GitHub", href: links?.github },
  ].filter(isStated);

  return (
    <>
      {companyLinks.length === 0 ? (
        <p className={styles.absent}>No company links stated.</p>
      ) : (
        <LinkChips links={companyLinks} label="Company links" />
      )}

      {founders.length === 0 ? null : (
        <ul className={styles.people}>
          {founders.map((founder, index) => {
            const founderLinks = [
              { label: "LinkedIn", href: founder.linkedin },
              { label: "X", href: founder.twitter },
            ].filter(isStated);

            return (
              <li key={index} className={styles.contact}>
                <p className={styles.personName}>{founder.name}</p>
                {founderLinks.length === 0 ? (
                  <p className={styles.absent}>No public profile stated.</p>
                ) : (
                  <LinkChips
                    links={founderLinks}
                    label={`${founder.name}'s links`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

type StatedLink = { label: string; href: string };

function isStated(link: {
  label: string;
  href: string | null | undefined;
}): link is StatedLink {
  return link.href !== null && link.href !== undefined;
}

function LinkChips({
  links,
  label,
}: {
  links: readonly StatedLink[];
  label: string;
}) {
  return (
    <ul className={styles.chips} aria-label={label}>
      {links.map((link) => (
        <li key={link.label}>
          <a
            className={`${styles.chip} ${styles.linkChip}`}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export const LOADING_NEWS_TAB_MESSAGE = "Loading News…";
export const NEWS_TAB_ERROR_MESSAGE = "Couldn't load News.";
export const EMPTY_NEWS_TAB_MESSAGE = "No News about this company yet.";

/** Dates in UTC and a fixed locale, matching `app/(app)/news`'s own formatting, so an article's
 * date reads the same wherever it is shown. */
const ARTICLE_DATE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/**
 * The News tab: this company's articles, in the order the card is handed them — newest first,
 * per `readNewsForProfile`. The card fetches nothing, so loading and error are states the
 * caller reached and passed in, not anything this renders a request for.
 */
function NewsPanel({ state }: { state: NewsTabState }) {
  if (state.status === "loading") {
    return <p className={styles.absent}>{LOADING_NEWS_TAB_MESSAGE}</p>;
  }

  if (state.status === "error") {
    return (
      <p role="alert" className={styles.absent}>
        {NEWS_TAB_ERROR_MESSAGE}
      </p>
    );
  }

  if (state.items.length === 0) {
    return <p className={styles.absent}>{EMPTY_NEWS_TAB_MESSAGE}</p>;
  }

  return (
    <ol className={styles.tabItems} aria-label="News">
      {state.items.map((item) => (
        <li key={item.id} className={styles.tabItem}>
          <a
            className={styles.headline}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {item.title}
          </a>
          <p className={styles.tabItemMeta}>
            <span>{item.sourceName}</span>
            <time dateTime={item.publishedAt}>
              {ARTICLE_DATE.format(new Date(item.publishedAt))}
            </time>
          </p>
        </li>
      ))}
    </ol>
  );
}

export const LOADING_EVENTS_TAB_MESSAGE = "Loading Events…";
export const EVENTS_TAB_ERROR_MESSAGE = "Couldn't load Events.";
export const EMPTY_EVENTS_TAB_MESSAGE = "No upcoming Events for this company.";

/** Event dates are calendar dates, not instants, so they are formatted in UTC, matching
 * `app/(app)/diary`'s own formatting: formatting `2026-09-15` in the viewer's own zone would
 * show the 14th anywhere west of Greenwich. */
const EVENT_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const formatEventDate = (isoDate: string): string =>
  EVENT_DATE.format(new Date(`${isoDate}T00:00:00Z`));

/** The Events tab: this company's upcoming Events, in the order the card is handed them —
 * soonest first, per `readEventsForProfile`. */
function EventsPanel({ state }: { state: EventsTabState }) {
  if (state.status === "loading") {
    return <p className={styles.absent}>{LOADING_EVENTS_TAB_MESSAGE}</p>;
  }

  if (state.status === "error") {
    return (
      <p role="alert" className={styles.absent}>
        {EVENTS_TAB_ERROR_MESSAGE}
      </p>
    );
  }

  if (state.items.length === 0) {
    return <p className={styles.absent}>{EMPTY_EVENTS_TAB_MESSAGE}</p>;
  }

  return (
    <ol className={styles.tabItems} aria-label="Events">
      {state.items.map((item) => (
        <li key={item.id} className={styles.tabItem}>
          <p className={styles.tabItemWhen}>
            <time dateTime={item.startDate}>
              {formatEventDate(item.startDate)}
            </time>
            {item.endDate === null || item.endDate === item.startDate ? null : (
              <>
                {" – "}
                <time dateTime={item.endDate}>
                  {formatEventDate(item.endDate)}
                </time>
              </>
            )}
          </p>
          <a
            className={styles.headline}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {item.name}
          </a>
          {item.location === null ? null : (
            <p className={styles.tabItemMeta}>{item.location}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * A founder as a circle of initials. Never a photograph: no avatar is stored or fetched, by
 * decision. In the founder strip the circle is the only mention of the person, so it carries
 * their name; in the Team panel the name is written beside it, so the circle is decoration.
 */
function Initials({
  name,
  labelled = false,
}: {
  name: string;
  labelled?: boolean;
}) {
  return labelled ? (
    <span className={styles.initials} role="img" aria-label={name}>
      {initialsOf(name)}
    </span>
  ) : (
    <span className={styles.initials} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

/**
 * At most two letters from the stated name: the first letter of its first word and of its
 * last. Words with no letter in them, such as an initial's stray punctuation, are skipped.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0])
    .filter((letter): letter is string => letter !== undefined);
  const first = letters[0];
  const last = letters.length > 1 ? letters[letters.length - 1] : undefined;

  return `${first ?? ""}${last ?? ""}`.toUpperCase();
}

function countOf(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
