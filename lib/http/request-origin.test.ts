// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { requestOrigin } from "./request-origin";

function requestWith(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(url), { headers });
}

describe("the origin a browser used", () => {
  it("prefers the forwarded host and scheme, which is what Vercel sets", () => {
    expect(
      requestOrigin(
        requestWith("http://internal-host/login/google", {
          "x-forwarded-host": "rolodeck-ai.vercel.app",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://rolodeck-ai.vercel.app");
  });

  it("takes the first value when a chain of proxies has appended to the header", () => {
    expect(
      requestOrigin(
        requestWith("http://internal-host/login/google", {
          "x-forwarded-host": "rolodeck-ai.vercel.app, inner.example",
          "x-forwarded-proto": "https,http",
        }),
      ),
    ).toBe("https://rolodeck-ai.vercel.app");
  });

  it("falls back to the Host header", () => {
    expect(
      requestOrigin(
        requestWith("http://unused.example/login/google", {
          host: "rolodeck.example",
        }),
      ),
    ).toBe("https://rolodeck.example");
  });

  it("assumes https for a real host, because a deployment has it and an http redirect loses the cookie", () => {
    expect(requestOrigin(requestWith("http://rolodeck.example/x"))).toBe(
      "https://rolodeck.example",
    );
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"])(
    "leaves %s on http, where https does not exist",
    (host) => {
      expect(
        requestOrigin(requestWith("http://unused.example/x", { host })),
      ).toBe(`http://${host}`);
    },
  );

  it("ignores an empty forwarded header rather than building a hostless origin", () => {
    expect(
      requestOrigin(
        requestWith("http://unused.example/x", {
          "x-forwarded-host": "",
          host: "rolodeck.example",
        }),
      ),
    ).toBe("https://rolodeck.example");
  });
});
