// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { TeamPageCandidate } from "../../db/team-pages";
import type { TeamPageResponse, TeamSiteClient } from "./team-page-fetch";
import {
  applyTeamAnswers,
  gatherTeamPages,
  summariseTeamPagesRun,
  teamPagesRunFailed,
  type TeamPageWork,
} from "./team-pages-run";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const candidate = (n: number, website: string): TeamPageCandidate => ({
  profileId: id(n),
  name: `Company ${n}`,
  website,
});

/** A site client answering from a table, logging every URL it was asked for. */
function fakeClient(pages: Record<string, TeamPageResponse>) {
  const asked: string[] = [];
  const client: TeamSiteClient = {
    get: async (url) => {
      asked.push(url);
      return pages[url] ?? { kind: "failed", url, reason: "answered 404" };
    },
  };
  return { client, asked };
}

const page = (url: string, html: string): TeamPageResponse => ({
  kind: "page",
  url,
  html,
});

const work = (n: number, overrides: Partial<TeamPageWork>): TeamPageWork => ({
  profileId: id(n),
  name: `Company ${n}`,
  website: `https://c${n}.dev`,
  outcome: "read",
  pages: [`https://c${n}.dev/`],
  text: "Our team\nAda Lovelace\nCo-founder",
  ...overrides,
});

describe("gatherTeamPages", () => {
  it("reads the homepage and the team page it links to, and records each outcome", async () => {
    const { client, asked } = fakeClient({
      "https://one.dev/": page(
        "https://one.dev/",
        '<p>Welcome</p><a href="/team">Team</a><a href="https://x.com/one">X</a>',
      ),
      "https://one.dev/team": page(
        "https://one.dev/team",
        "<p>Ada Lovelace, founder</p>",
      ),
      "https://two.dev/": { kind: "disallowed", url: "https://two.dev/" },
    });

    const gathered = await gatherTeamPages(
      [
        candidate(1, "https://one.dev/"),
        candidate(2, "https://two.dev/"),
        candidate(3, "https://three.dev/"),
      ],
      client,
    );

    expect(asked).toEqual([
      "https://one.dev/",
      "https://one.dev/team",
      "https://two.dev/",
      "https://three.dev/",
    ]);
    expect(gathered.map((item) => item.outcome)).toEqual([
      "read",
      "robots-disallowed",
      "not-found",
    ]);
    expect(gathered[0]!.pages).toEqual([
      "https://one.dev/",
      "https://one.dev/team",
    ]);
    expect(gathered[0]!.text).toContain("Ada Lovelace, founder");
    expect(gathered[2]!.reason).toBe("answered 404");
  });
});

describe("applyTeamAnswers", () => {
  it("counts every outcome the Ticket asks for, and records each attempt", () => {
    const items = [
      work(1, {}),
      work(2, { outcome: "robots-disallowed", pages: [], text: "" }),
      work(3, {
        outcome: "not-found",
        reason: "answered 404",
        pages: [],
        text: "",
      }),
      work(4, { text: "We make widgets." }),
      work(5, {}),
      work(6, {}),
    ];
    const answers = new Map([
      [
        id(1),
        JSON.stringify({
          founders: [{ name: "Ada Lovelace" }, { name: "Invented Person" }],
        }),
      ],
      [id(4), '{"founders":[]}'],
      [id(5), "Here are the founders: Ada Lovelace"],
    ]);

    const { results, report } = applyTeamAnswers(items, answers);

    expect(report).toMatchObject({
      taken: 6,
      robotsSkipped: 1,
      notFound: 1,
      namedNobody: 1,
      peopleDropped: 1,
      unanswered: 1,
    });
    expect(report.rejections).toEqual([
      expect.objectContaining({ company: "Company 5", field: "(answer)" }),
    ]);
    expect(results).toEqual([
      { profileId: id(1), founders: [{ name: "Ada Lovelace" }] },
      { profileId: id(2), founders: null },
      { profileId: id(3), founders: null },
      { profileId: id(4), founders: null },
      { profileId: id(5), founders: null },
      // Company 6 had no answer at all, so it is not recorded, and is read again next run.
    ]);
  });

  it("reports every count by name", () => {
    const { report } = applyTeamAnswers([work(1, {})], new Map());
    const summary = summariseTeamPagesRun(report, 0);

    for (const phrase of [
      "1 candidates taken",
      "0 skipped on robots.txt",
      "0 pages not found",
      "0 companies where the page named nobody",
      "0 people dropped for not appearing in the page",
      "0 profiles updated",
    ]) {
      expect(summary).toContain(phrase);
    }
  });
});

describe("teamPagesRunFailed", () => {
  const reportOf = (items: TeamPageWork[]) =>
    applyTeamAnswers(items, new Map()).report;

  it("fails a run where every candidate failed to fetch", () => {
    expect(
      teamPagesRunFailed(
        reportOf([
          work(1, { outcome: "not-found", pages: [], text: "" }),
          work(2, { outcome: "not-found", pages: [], text: "" }),
        ]),
      ),
    ).toBe(true);
  });

  it("passes a run that read its quota and found nobody, and one with nothing to take", () => {
    expect(
      teamPagesRunFailed(
        applyTeamAnswers(
          [work(1, {}), work(2, {})],
          new Map([
            [id(1), '{"founders":[]}'],
            [id(2), '{"founders":[]}'],
          ]),
        ).report,
      ),
    ).toBe(false);
    expect(teamPagesRunFailed(reportOf([]))).toBe(false);
  });
});
