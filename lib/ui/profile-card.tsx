import styles from "./profile-card.module.css";

type ProfileCardProps = {
  name: string;
  sector: string;
  stage: string;
  /** The Watchlist reads no description, so the card renders without one rather than with a
   * gap where one would be. */
  description?: string;
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
          <dd className={styles.fieldValue}>{stage}</dd>
        </div>
      </dl>
    </article>
  );
}
