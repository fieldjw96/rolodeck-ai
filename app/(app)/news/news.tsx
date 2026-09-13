"use client";

import { useEffect, useState } from "react";

import { StateNotice } from "../../../lib/ui/state-notice";
import styles from "./news.module.css";

type NewsItem = {
  id: string;
  title: string;
  url: string;
  published_at: string;
  source_name: string;
};

type NewsCompany = {
  profile: { id: string; name: string; sector: string };
  items: NewsItem[];
};

type NewsBody = {
  companies: NewsCompany[];
};

type NewsState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; companies: NewsCompany[] };

export const EMPTY_NEWS_MESSAGE = "No News about the companies you Kept yet.";

export const LOAD_ERROR_MESSAGE = "Couldn't load News.";

export const LOADING_NEWS_MESSAGE = "Loading News…";

// The second line of each designed state, as on the Watchlist: what it means, or what to do.
const LOADING_NEWS_DETAIL =
  "Reading back articles about everything you have Kept.";
const EMPTY_NEWS_DETAIL =
  "Articles about the Company Profiles you Keep collect here, grouped by company, once News has been fetched for them.";
const LOAD_ERROR_DETAIL = "Check your connection, then reload the page.";

/**
 * Dates in UTC and a fixed locale, so the page reads the same wherever it renders and a test
 * can assert on the text.
 */
const PUBLISHED = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

async function fetchNews(): Promise<NewsBody> {
  const response = await fetch("/api/news");

  if (!response.ok) {
    throw new Error(`GET /api/news failed with ${response.status}`);
  }

  return (await response.json()) as NewsBody;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * News about every Company Profile Jack has Kept, read through `GET /api/news` rather than
 * Postgres directly, per CLAUDE.md. Grouped by company, the freshest company first and each
 * company's articles newest first — the order the endpoint already returns them in.
 */
export function News() {
  const [state, setState] = useState<NewsState>({ status: "loading" });

  useEffect(() => {
    fetchNews()
      .then((body) =>
        setState(
          body.companies.length === 0
            ? { status: "empty" }
            : { status: "ready", companies: body.companies },
        ),
      )
      .catch((error: unknown) => {
        console.error(error);
        setState({ status: "error", message: LOAD_ERROR_MESSAGE });
      });
  }, []);

  if (state.status === "loading") {
    return (
      <main className={styles.news}>
        <StateNotice
          busy
          title={LOADING_NEWS_MESSAGE}
          body={LOADING_NEWS_DETAIL}
        />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className={styles.news}>
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
      <main className={styles.news}>
        <StateNotice title={EMPTY_NEWS_MESSAGE} body={EMPTY_NEWS_DETAIL} />
      </main>
    );
  }

  const articles = state.companies.reduce(
    (total, company) => total + company.items.length,
    0,
  );

  return (
    <main className={styles.news}>
      <div className={styles.header}>
        <h1 className={styles.title}>News</h1>
        <p className={styles.count}>
          {plural(articles, "article", "articles")} about{" "}
          {plural(state.companies.length, "company", "companies")}
        </p>
      </div>
      {state.companies.map((company) => {
        const headingId = `news-${company.profile.id}`;

        return (
          <section
            key={company.profile.id}
            className={styles.company}
            aria-labelledby={headingId}
          >
            <div className={styles.companyHeader}>
              <h2 id={headingId} className={styles.companyName}>
                {company.profile.name}
              </h2>
              <p className={styles.sector}>{company.profile.sector}</p>
            </div>
            <ol className={styles.items}>
              {company.items.map((item) => (
                <li key={item.id} className={styles.item}>
                  <a
                    className={styles.headline}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.title}
                  </a>
                  <p className={styles.meta}>
                    <span>{item.source_name}</span>
                    <time dateTime={item.published_at}>
                      {PUBLISHED.format(new Date(item.published_at))}
                    </time>
                  </p>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </main>
  );
}
