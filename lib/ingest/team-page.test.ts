// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readTeamPageFixture } from "../testing/fixtures";
import {
  MAX_TEAM_PAGES_PER_COMPANY,
  sameSite,
  teamPageLinks,
  visibleText,
} from "./team-page";

describe("visibleText", () => {
  it("keeps what a visitor reads and drops scripts, styles and markup", () => {
    const text = visibleText(
      [
        "<html><head><title>Acme</title><style>h1{}</style></head><body>",
        "<script>var founder = 'Not A Person';</script>",
        "<h2>Our team</h2><div><p>Ada&nbsp;Lovelace</p><p>Co-founder &amp; CEO</p></div>",
        "<!-- Hidden Person -->",
        "</body></html>",
      ].join(""),
    );

    expect(text).toBe("Our team\nAda Lovelace\nCo-founder & CEO");
  });

  it("reads the captured Ampcontrol page's leadership as text", async () => {
    const { html } = await readTeamPageFixture("ampcontrol");
    const text = visibleText(html);

    expect(text).toContain("Joachim Lohse\nCEO & Founder");
    expect(text).not.toContain("<");
  });
});

describe("teamPageLinks", () => {
  const HOME = "https://www.acme.dev/";

  it("picks same-site links that look like a team page, team before about", () => {
    const html = [
      '<a href="/about-us">About</a>',
      '<a href="https://acme.dev/team">Meet us</a>',
      '<a href="/pricing">Pricing</a>',
      '<a href="/">Home</a>',
    ].join("");

    expect(teamPageLinks(html, HOME)).toEqual([
      "https://acme.dev/team",
      "https://www.acme.dev/about-us",
    ]);
  });

  it("never follows a link off the company's own site", () => {
    const html = [
      '<a href="https://www.linkedin.com/company/acme/people">Our people</a>',
      '<a href="https://www.crunchbase.com/organization/acme">Team</a>',
      '<a href="https://blog.acme.dev/team">Team</a>',
      '<a href="mailto:founders@acme.dev">Founders</a>',
    ].join("");

    expect(teamPageLinks(html, HOME)).toEqual([]);
  });

  it(`reads at most ${MAX_TEAM_PAGES_PER_COMPANY} pages beyond the homepage`, () => {
    const html = ["/team", "/people", "/leadership", "/founders"]
      .map((path) => `<a href="${path}">x</a>`)
      .join("");

    expect(teamPageLinks(html, HOME)).toHaveLength(MAX_TEAM_PAGES_PER_COMPANY);
  });

  it("counts a link once, whatever its fragment or query", () => {
    const html = '<a href="/team#ceo">Team</a><a href="/team?ref=nav">Team</a>';

    expect(teamPageLinks(html, HOME)).toEqual(["https://www.acme.dev/team"]);
  });
});

describe("sameSite", () => {
  it("treats www and the bare host as one site, and a subdomain as another", () => {
    const home = new URL("https://acme.dev/");

    expect(sameSite(new URL("https://www.acme.dev/x"), home)).toBe(true);
    expect(sameSite(new URL("https://blog.acme.dev/x"), home)).toBe(false);
    expect(sameSite(new URL("https://acme.dev.evil.com/x"), home)).toBe(false);
  });
});
