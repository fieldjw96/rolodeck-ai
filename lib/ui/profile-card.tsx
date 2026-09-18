"use client";

import { useId, useState, type KeyboardEvent } from "react";

import { NOT_STATED_STAGE } from "../../db/not-stated-stage";
import type { CompanyLinks, Founder } from "../../db/profile-input";
import styles from "./profile-card.module.css";

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
  /** The year the company was founded. No Source stores one yet, so it reads "Not stated". */
  founded?: number | null;
  /** Headcount beyond the founders. No Source stores one yet, so it reads "Not stated". */
  staff?: number | null;
  /** The Deck's card is the page's only subject and carries its `h1`; the Watchlist's cards
   * sit under a heading of their own, so theirs are one level down. */
  headingLevel: 1 | 2;
  /** The Watchlist's grid variant: the same card, tighter, with a smaller name, and none of
   * the full card's founder strip or tabs. */
  compact?: boolean;
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
          <dd className={styles.fieldValue}>{sector}</dd>
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
    <dd className={`${className} ${styles.notStated}`}>Not stated</dd>
  ) : (
    <dd className={className}>{stage}</dd>
  );
}

type Tab = "company" | "team" | "contact";

const TAB_LABELS: Record<Tab, string> = {
  company: "Company",
  team: "Team",
  contact: "Contact",
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
  founded,
  staff,
  headingLevel,
}: ProfileCardProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const stated = founders ?? [];
  // A Profile with no founders has no Team tab at all, rather than one that opens on nothing.
  const tabs: Tab[] =
    stated.length > 0 ? ["company", "team", "contact"] : ["company", "contact"];
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
            {staff === null || staff === undefined
              ? null
              : ` · ${countOf(staff, "staff", "staff")}`}
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
              founded={founded}
              teamSize={
                staff === null || staff === undefined
                  ? null
                  : stated.length + staff
              }
            />
          ) : tab === "team" ? (
            <TeamPanel founders={stated} />
          ) : (
            <ContactPanel website={website} links={links} founders={stated} />
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
  founded,
  teamSize,
}: {
  description: string | undefined;
  sector: string;
  stage: string;
  location: string | null | undefined;
  founded: number | null | undefined;
  teamSize: number | null;
}) {
  return (
    <>
      <dl className={styles.figures}>
        <div className={styles.figure}>
          <dt className={styles.fieldLabel}>Stage</dt>
          <StageValue stage={stage} className={styles.figureValue} />
        </div>
        <Figure label="Founded" value={founded} />
        <Figure label="Team" value={teamSize} />
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
        <li className={styles.chip}>{sector}</li>
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

function Figure({
  label,
  value,
}: {
  label: string;
  value: number | null | undefined;
}) {
  return (
    <div className={styles.figure}>
      <dt className={styles.fieldLabel}>{label}</dt>
      {value === null || value === undefined ? (
        <dd className={`${styles.figureValue} ${styles.notStated}`}>
          Not stated
        </dd>
      ) : (
        <dd className={styles.figureValue}>{value}</dd>
      )}
    </div>
  );
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
