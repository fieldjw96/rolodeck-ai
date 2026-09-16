import { NOT_STATED_STAGE } from "../../db/not-stated-stage";
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
  /** The Deck's card is the page's only subject and carries its `h1`; the Watchlist's cards
   * sit under a heading of their own, so theirs are one level down. */
  headingLevel: 1 | 2;
  /** The Watchlist's grid variant: the same card, tighter, with a smaller name. */
  compact?: boolean;
};

/**
 * One Profile as a card. Shared by the Deck and the Watchlist so the two cannot drift: the
 * Ticket asks for a Watchlist "consistent with the Deck's card", and this is that consistency
 * expressed as a single component rather than as two stylesheets that happen to agree.
 */
export function ProfileCard({
  name,
  sector,
  stage,
  description,
  location,
  headingLevel,
  compact = false,
}: ProfileCardProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <article
      className={compact ? `${styles.card} ${styles.compact}` : styles.card}
    >
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
          {/* A stage the Source never stated reads as that, in words and set apart, rather
              than as a slug that looks like one more stage. See docs/adr/0015. */}
          {stage === NOT_STATED_STAGE ? (
            <dd className={`${styles.fieldValue} ${styles.notStated}`}>
              Not stated
            </dd>
          ) : (
            <dd className={styles.fieldValue}>{stage}</dd>
          )}
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
