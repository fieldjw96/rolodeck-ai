import styles from "./state-notice.module.css";

type StateNoticeProps = {
  /** The one line that says what has happened. Kept as a single element's text so the
   * existing tests can still find a message by its exact string. */
  title: string;
  /** A second, quieter line saying what to do about it. Always present: a designed empty
   * state that says only "No Profiles left in the Deck." is still a bare string. */
  body: string;
  tone?: "neutral" | "danger";
  /** `alert` for a failure worth interrupting a screen reader for, `status` for the rest. */
  live?: "alert" | "status";
  busy?: boolean;
};

/**
 * Loading, empty and failed, given the same designed shape. The Ticket asks for these three
 * to be designed rather than left as bare strings, and having one component for them is what
 * stops the next state added somewhere else from being a bare string again.
 */
export function StateNotice({
  title,
  body,
  tone = "neutral",
  live = "status",
  busy = false,
}: StateNoticeProps) {
  const className = [
    styles.notice,
    tone === "danger" ? styles.danger : null,
    busy ? styles.busy : null,
  ]
    .filter((name) => name !== null)
    .join(" ");

  return (
    <div className={className} role={live} aria-busy={busy || undefined}>
      <span className={styles.mark} aria-hidden="true" />
      <p className={styles.title}>{title}</p>
      <p className={styles.body}>{body}</p>
    </div>
  );
}
