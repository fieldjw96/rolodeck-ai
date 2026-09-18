// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ACCELERATOR_USER_AGENT } from "./accelerator-fetch";
import { createTeamSiteClient } from "./team-page-fetch";
import type { Throttle } from "./throttle";

type Route = {
  status: number;
  body?: string;
  headers?: Record<string, string>;
};

const html = (body: string): Route => ({
  status: 200,
  body,
  headers: { "content-type": "text/html; charset=utf-8" },
});

/** A fake web: every request is logged, in order, with the headers and options it carried. */
function fakeWeb(routes: Record<string, Route | Error>) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const acquired: string[] = [];

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ url, init });
    const route = routes[url] ?? { status: 404 };

    if (route instanceof Error) {
      throw route;
    }

    return new Response(route.body ?? null, {
      status: route.status,
      headers: route.headers,
    });
  }) as typeof globalThis.fetch;

  const createThrottleFor = (host: string): Throttle => ({
    acquire: async () => {
      acquired.push(host);
    },
  });

  return {
    client: createTeamSiteClient({ fetch, createThrottleFor }),
    requests,
    urls: () => requests.map((request) => request.url),
    acquired,
  };
}

describe("the team site client", () => {
  it("reads robots.txt before anything else on the host, and sends an honest User-Agent", async () => {
    const web = fakeWeb({
      "https://acme.dev/robots.txt": {
        status: 200,
        body: "User-agent: *\nAllow: /\n",
      },
      "https://acme.dev/about": html("<h1>Team</h1>"),
    });

    const page = await web.client.get("https://acme.dev/about");

    expect(page).toEqual({
      kind: "page",
      url: "https://acme.dev/about",
      html: "<h1>Team</h1>",
    });
    expect(web.urls()).toEqual([
      "https://acme.dev/robots.txt",
      "https://acme.dev/about",
    ]);
    for (const request of web.requests) {
      expect(new Headers(request.init?.headers).get("User-Agent")).toBe(
        ACCELERATOR_USER_AGENT,
      );
      expect(request.init?.redirect).toBe("manual");
    }
  });

  it("throttles every request, robots.txt included, by its host", async () => {
    const web = fakeWeb({ "https://acme.dev/": html("home") });

    await web.client.get("https://acme.dev/");
    await web.client.get("https://acme.dev/team");

    // robots.txt once for the origin, then each page.
    expect(web.acquired).toEqual(["acme.dev", "acme.dev", "acme.dev"]);
  });

  it("does not request a path robots.txt disallows", async () => {
    const web = fakeWeb({
      "https://acme.dev/robots.txt": {
        status: 200,
        body: "User-agent: *\nDisallow: /team\n",
      },
    });

    expect(await web.client.get("https://acme.dev/team")).toEqual({
      kind: "disallowed",
      url: "https://acme.dev/team",
    });
    expect(web.urls()).toEqual(["https://acme.dev/robots.txt"]);
  });

  it("treats a missing robots.txt as allowing everything, per RFC 9309", async () => {
    const web = fakeWeb({ "https://acme.dev/": html("home") });

    expect(await web.client.get("https://acme.dev/")).toMatchObject({
      kind: "page",
    });
  });

  it.each([
    ["answers 503", { status: 503 }],
    ["cannot be reached", new TypeError("fetch failed")],
  ])(
    "requests nothing on a host whose robots.txt %s",
    async (_label, robots) => {
      const web = fakeWeb({ "https://acme.dev/robots.txt": robots });

      expect(await web.client.get("https://acme.dev/")).toMatchObject({
        kind: "failed",
        reason: expect.stringContaining("robots.txt"),
      });
      expect(web.urls()).toEqual(["https://acme.dev/robots.txt"]);
    },
  );

  it("follows a redirect to www on the same site, reading that host's robots.txt first", async () => {
    const web = fakeWeb({
      "https://acme.dev/": {
        status: 301,
        headers: { location: "https://www.acme.dev/" },
      },
      "https://www.acme.dev/": html("home"),
    });

    expect(await web.client.get("https://acme.dev/")).toEqual({
      kind: "page",
      url: "https://www.acme.dev/",
      html: "home",
    });
    expect(web.urls()).toEqual([
      "https://acme.dev/robots.txt",
      "https://acme.dev/",
      "https://www.acme.dev/robots.txt",
      "https://www.acme.dev/",
    ]);
  });

  it("does not follow a redirect off the company's own site", async () => {
    const web = fakeWeb({
      "https://acme.dev/team": {
        status: 302,
        headers: { location: "https://www.linkedin.com/company/acme" },
      },
    });

    expect(await web.client.get("https://acme.dev/team")).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("www.linkedin.com"),
    });
    expect(web.urls().some((url) => url.includes("linkedin"))).toBe(false);
  });

  it("answers rather than throws for an error status or a page that is not HTML", async () => {
    const web = fakeWeb({
      "https://acme.dev/gone": { status: 404 },
      "https://acme.dev/deck": {
        status: 200,
        body: "%PDF",
        headers: { "content-type": "application/pdf" },
      },
    });

    expect(await web.client.get("https://acme.dev/gone")).toMatchObject({
      kind: "failed",
      reason: "answered 404",
    });
    expect(await web.client.get("https://acme.dev/deck")).toMatchObject({
      kind: "failed",
    });
  });
});
