import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.home}>
      <h1 className={styles.title}>Rolodeck AI</h1>
      <p className={styles.tagline}>
        A deck of Bay Area startup Profiles, judged one at a time.
      </p>
    </main>
  );
}
