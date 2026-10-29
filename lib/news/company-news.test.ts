import { describe, expect, it } from "vitest";

import {
  BELOW_NEWS_DISPLAY_THRESHOLD,
  isCompanyNews,
  ownSiteConfidence,
} from "./company-news";
import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";

/**
 * The news-only rule for a company's own writing, from docs/adr/0024. The titles below are the
 * ones Ticket #255 named, which are the ones a retune has to keep answering the same way.
 */

/** An own-site post, on the company's own blog unless the test says otherwise. */
const post = (title: string, url = "https://acme.com/blog/post") => ({
  title,
  url,
});

const IS_NEWS = [
  "Sierra raises $175M Series B",
  "Introducing Agent OS",
  "Announcing our seed round",
  "Acme acquires Widgetly",
  "Acme is now generally available",
  "Launch HN: Acme (YC W25) – AI for invoices",
  "We're partnering with Stripe",
  "Welcoming Jane Doe as our new CTO",
  "Acme 2.0 is here",
];

const IS_NOT_NEWS = [
  "Why agents need guardrails",
  "How we think about pricing",
  "What we learned building an eval harness",
  "The case for small models",
  "A guide to prompt caching",
  "Thoughts on the future of support",
  "Lessons from 1,000 customer calls",
  "Is RAG dead?",
  "Building a fast tokenizer in Rust",
];

describe("isCompanyNews", () => {
  it.each(IS_NEWS)("reads %s as news", (title) => {
    expect(isCompanyNews(post(title))).toBe(true);
  });

  it.each(IS_NOT_NEWS)("reads %s as not news", (title) => {
    expect(isCompanyNews(post(title))).toBe(false);
  });

  it("lets an opinion signal override an announcement one, whichever way round they are", () => {
    // Each of these carries a term from the news list as well.
    expect(
      isCompanyNews(post("Why we're announcing a new pricing model")),
    ).toBe(false);
    expect(isCompanyNews(post("How we think about launching a product"))).toBe(
      false,
    );
    expect(isCompanyNews(post("Lessons from raising our Series A"))).toBe(
      false,
    );
    expect(isCompanyNews(post("A guide to the partnership we announced"))).toBe(
      false,
    );
  });

  it("reads the url's path where the headline alone says nothing", () => {
    // Nothing in this headline is an announcement word, so the path is what decides.
    expect(
      isCompanyNews(post("Acme and Globex", "https://acme.com/blog/x")),
    ).toBe(false);
    expect(
      isCompanyNews(
        post("Acme and Globex", "https://acme.com/press/acme-globex"),
      ),
    ).toBe(true);
    expect(
      isCompanyNews(
        post("Acme and Globex", "https://acme.com/newsroom/2026/x"),
      ),
    ).toBe(true);
    // And a path that says essay or tutorial overrides an announcement headline.
    expect(
      isCompanyNews(
        post("Introducing Agent OS", "https://acme.com/guides/agent-os"),
      ),
    ).toBe(false);
  });

  it("is quiet by default: a headline with no signal either way is not news", () => {
    expect(isCompanyNews(post("Agent OS"))).toBe(false);
    expect(isCompanyNews(post("Our 2026 pricing"))).toBe(false);
  });

  it("answers for a url that does not parse, reading the headline alone", () => {
    expect(isCompanyNews({ title: "Announcing our seed round", url: "" })).toBe(
      true,
    );
    expect(
      isCompanyNews({ title: "Why agents need guardrails", url: "" }),
    ).toBe(false);
  });
});

describe("ownSiteConfidence", () => {
  const acme = { name: "Acme", sector: "ai-ml" };

  it("shows a company's own announcement, whether or not it names the company", () => {
    const unnamed = {
      title: "Introducing Agent OS",
      description: null,
      url: "https://acme.com/blog/agent-os",
    };

    // The matcher scores it zero: a company's own post rarely names itself.
    expect(scoreNewsMatch(acme, unnamed)).toBe(0);
    expect(ownSiteConfidence(acme, unnamed)).toBe(NEWS_DISPLAY_THRESHOLD);
  });

  it("keeps the matcher's score when it is already above the threshold", () => {
    const named = {
      title: "Acme raises a seed round for its AI agents",
      description: null,
      url: "https://acme.com/blog/seed",
    };
    const scored = scoreNewsMatch(acme, named);

    expect(scored).toBeGreaterThan(NEWS_DISPLAY_THRESHOLD);
    expect(ownSiteConfidence(acme, named)).toBe(scored);
  });

  it("caps an essay strictly below the threshold, so it is stored and never shown", () => {
    const essay = {
      title: "Why Acme thinks AI agents need guardrails",
      description: null,
      url: "https://acme.com/blog/guardrails",
    };

    expect(BELOW_NEWS_DISPLAY_THRESHOLD).toBeLessThan(NEWS_DISPLAY_THRESHOLD);
    expect(scoreNewsMatch(acme, essay)).toBeGreaterThan(
      BELOW_NEWS_DISPLAY_THRESHOLD,
    );
    expect(ownSiteConfidence(acme, essay)).toBe(BELOW_NEWS_DISPLAY_THRESHOLD);
  });

  it("leaves an essay the matcher scored zero at zero, so nothing stores the pair", () => {
    const essay = {
      title: "Why agents need guardrails",
      description: null,
      url: "https://acme.com/blog/guardrails",
    };

    expect(scoreNewsMatch(acme, essay)).toBe(0);
    expect(ownSiteConfidence(acme, essay)).toBe(0);
  });
});
