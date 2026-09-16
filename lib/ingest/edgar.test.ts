// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { readFilingFixture, type FilingFixture } from "../testing/fixtures";
import {
  createEdgarClient,
  edgarUserAgent,
  fetchCaliforniaFormDProfiles,
  filingUrl,
  searchUrl,
} from "./edgar";
import {
  createThrottle,
  EDGAR_RATE_WINDOW_MS,
  EDGAR_REQUESTS_PER_SECOND,
} from "./throttle";

/**
 * The fetching half of the SEC Form D Source, against a fake EDGAR: the same captured filings
 * the parser tests use, served over a fake fetch and a clock the test holds. Nothing here
 * makes a request, and the rate limit is asserted by moving that clock rather than by waiting
 * out a second of real time.
 */
const CALIFORNIAN_WITH_A_ROUND = [
  ["sec-form-d-elder-swamp-club", "Elder Swamp Club, Inc."],
  ["sec-form-d-sporty-and-rich", "SPORTY & RICH INC"],
  ["sec-form-d-point2-technology", "Point2 Technology Inc."],
] as const;

const SLUGS = [
  ...CALIFORNIAN_WITH_A_ROUND.map(([slug]) => slug),
  "sec-form-d-krina-ai",
  "sec-form-d-communion",
];

const fixtures = new Map<string, FilingFixture>();

const fixture = (slug: string): FilingFixture => {
  const found = fixtures.get(slug);
  if (found === undefined) throw new Error(`fixture ${slug} was not loaded`);
  return found;
};

beforeAll(async () => {
  for (const slug of SLUGS) {
    fixtures.set(slug, await readFilingFixture(slug));
  }
});
describe("the User-Agent the SEC requires", () => {
  it("names the project and carries the contact", () => {
    expect(edgarUserAgent("ops@example.com")).toBe(
      "rolodeck-ai (ops@example.com)",
    );
  });

  it.each([[""], ["   "], ["rolodeck-ai"], ["https://example.com"]])(
    "refuses to build one from %j, so no anonymous request is ever made",
    (contact) => {
      expect(() => edgarUserAgent(contact)).toThrow("SEC_EDGAR_CONTACT");
    },
  );
});

describe("the EDGAR URLs", () => {
  it("asks the search index for Californian Form D filings by date", () => {
    expect(searchUrl("2026-09-01", "2026-09-08", 0)).toBe(
      "https://efts.sec.gov/LATEST/search-index?q=&forms=D&startdt=2026-09-01&enddt=2026-09-08&locationCodes=CA",
    );
  });

  it("pages with `from` once past the first page", () => {
    expect(searchUrl("2026-09-01", "2026-09-08", 100)).toContain("&from=100");
  });

  it("strips the leading zeros off a CIK and the dashes off an accession number", () => {
    expect(
      filingUrl("0002144996", "0002144996-26-000003", "primary_doc.xml"),
    ).toBe(
      "https://www.sec.gov/Archives/edgar/data/2144996/000214499626000003/primary_doc.xml",
    );
  });

  it("leaves a digit behind rather than stripping a CIK away entirely", () => {
    expect(filingUrl("0000000000", "0000000000-26-000000", "x.xml")).toContain(
      "/data/0/",
    );
  });
});

/** A clock the test holds, so the throttle's second passes without one going by. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
      await Promise.resolve();
    },
    get time() {
      return time;
    },
  };
}

type Call = { url: string; userAgent: string | null; at: number };

/** A fake EDGAR: a search index over the given filings, and the filings themselves. */
function fakeEdgar(
  hits: readonly { id: string; cik: string; xml?: string }[],
  { pageSize = 100 } = {},
) {
  const clock = fakeClock();
  const calls: Call[] = [];

  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      userAgent: new Headers(init?.headers).get("user-agent"),
      at: clock.now(),
    });

    if (url.startsWith("https://efts.sec.gov/")) {
      const from = Number(new URL(url).searchParams.get("from") ?? "0");
      const page = hits.slice(from, from + pageSize);

      return Response.json({
        hits: {
          total: { value: hits.length },
          hits: page.map((hit) => ({
            _id: hit.id,
            _source: { adsh: hit.id.split(":")[0], ciks: [hit.cik] },
          })),
        },
      });
    }

    const hit = hits.find((candidate) =>
      url.includes(candidate.id.split(":")[0]!.replace(/-/g, "")),
    );

    return hit?.xml === undefined
      ? new Response("not found", { status: 404 })
      : new Response(hit.xml);
  }) as unknown as typeof globalThis.fetch;

  return {
    calls,
    clock,
    client: createEdgarClient({
      contact: "ops@example.com",
      fetch,
      throttle: createThrottle({
        limit: EDGAR_REQUESTS_PER_SECOND,
        windowMs: EDGAR_RATE_WINDOW_MS,
        now: clock.now,
        sleep: clock.sleep,
      }),
    }),
  };
}

describe("createEdgarClient", () => {
  it("puts the User-Agent on every request", async () => {
    const edgar = fakeEdgar([]);

    await edgar.client.get(searchUrl("2026-09-01", "2026-09-08", 0));

    expect(edgar.calls[0]?.userAgent).toBe("rolodeck-ai (ops@example.com)");
  });

  it("throws rather than returning an error page as if it were a filing", async () => {
    const edgar = fakeEdgar([{ id: "0000000000-26-000001:x", cik: "1" }]);

    await expect(
      edgar.client.get("https://www.sec.gov/Archives/edgar/data/1/2/nope.xml"),
    ).rejects.toThrow("EDGAR answered 404");
  });
});

describe("fetchCaliforniaFormDProfiles", () => {
  const hitsFrom = (slugs: readonly string[]) =>
    slugs.map((slug, index) => ({
      id: `000000000${index}-26-00000${index}:primary_doc.xml`,
      cik: `000000000${index}`,
      xml: fixture(slug).xml,
    }));

  it("returns the Profiles readable from what EDGAR served", async () => {
    const edgar = fakeEdgar(hitsFrom(SLUGS));

    const batch = await fetchCaliforniaFormDProfiles(edgar.client, {
      since: "2026-09-01",
      until: "2026-09-08",
      today: "2026-09-09",
    });

    // Krina names no round and is still a Profile, its stage `not-stated`. See docs/adr/0015.
    expect(batch.profiles.map((profile) => profile.input.name)).toEqual([
      ...CALIFORNIAN_WITH_A_ROUND.map(([, name]) => name),
      "Krina AI, Inc.",
    ]);
    expect(batch.filtered).toBe(1);
    expect(batch.rejections).toEqual([]);
  });

  it("stamps every Profile with the filing's own URL and the capture date", async () => {
    const edgar = fakeEdgar(hitsFrom(["sec-form-d-sporty-and-rich"]));

    const batch = await fetchCaliforniaFormDProfiles(edgar.client, {
      since: "2026-09-01",
      until: "2026-09-08",
      today: "2026-09-09",
    });

    expect(batch.profiles[0]?.attribution.name).toEqual({
      sourceUrl:
        "https://www.sec.gov/Archives/edgar/data/0/000000000026000000/primary_doc.xml",
      capturedAt: "2026-09-09",
      provenance: "scraped",
    });
  });

  it("stays inside ten requests a second however many filings come back", async () => {
    const edgar = fakeEdgar(
      Array.from({ length: 24 }, (_, index) => ({
        id: `00000000${String(index).padStart(2, "0")}-26-000001:primary_doc.xml`,
        cik: String(index),
        xml: fixture("sec-form-d-sporty-and-rich").xml,
      })),
    );

    await fetchCaliforniaFormDProfiles(edgar.client, {
      since: "2026-09-01",
      until: "2026-09-08",
      today: "2026-09-09",
    });

    // 1 search + 24 filings = 25 requests, which cannot fit in fewer than three seconds.
    expect(edgar.calls).toHaveLength(25);
    for (const call of edgar.calls) {
      const inWindow = edgar.calls.filter(
        (other) =>
          other.at >= call.at && other.at < call.at + EDGAR_RATE_WINDOW_MS,
      );
      expect(inWindow.length).toBeLessThanOrEqual(EDGAR_REQUESTS_PER_SECOND);
    }
  });

  it("pages until EDGAR runs out of hits", async () => {
    const edgar = fakeEdgar(hitsFrom(SLUGS), { pageSize: 2 });

    const batch = await fetchCaliforniaFormDProfiles(edgar.client, {
      since: "2026-09-01",
      until: "2026-09-08",
      today: "2026-09-09",
    });

    expect(
      edgar.calls.filter((call) => call.url.startsWith("https://efts")),
    ).toHaveLength(3);
    expect(batch.profiles).toHaveLength(4);
  });

  it("reads no more filings than it was asked for", async () => {
    const edgar = fakeEdgar(hitsFrom(SLUGS));

    const batch = await fetchCaliforniaFormDProfiles(edgar.client, {
      since: "2026-09-01",
      until: "2026-09-08",
      limit: 2,
      today: "2026-09-09",
    });

    expect(edgar.calls).toHaveLength(3);
    expect(batch.profiles).toHaveLength(2);
  });

  it("counts a filing EDGAR will not serve, and keeps the rest", async () => {
    const edgar = fakeEdgar([
      { id: "0000000001-26-000001:primary_doc.xml", cik: "1" },
      ...hitsFrom(["sec-form-d-sporty-and-rich"]),
    ]);

    const batch = await fetchCaliforniaFormDProfiles(edgar.client, {
      since: "2026-09-01",
      until: "2026-09-08",
      today: "2026-09-09",
    });

    expect(batch.profiles).toHaveLength(1);
    expect(batch.rejections).toEqual([
      expect.objectContaining({ field: "document" }),
    ]);
  });

  it("throws when the search response changes shape, rather than reporting a quiet week", async () => {
    const fetch = (async () =>
      Response.json({
        hits: { total: { value: 3 } },
      })) as unknown as typeof globalThis.fetch;

    await expect(
      fetchCaliforniaFormDProfiles(
        createEdgarClient({ contact: "ops@example.com", fetch }),
        { since: "2026-09-01", until: "2026-09-08" },
      ),
    ).rejects.toThrow("EDGAR search response changed shape at hits.hits");
  });
});
