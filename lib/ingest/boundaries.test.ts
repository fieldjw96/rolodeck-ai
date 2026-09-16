// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import {
  importSpecifiers,
  readSourceFiles,
  type SourceFile,
} from "../testing/sources";

/**
 * Every Source parser under `lib/ingest` and `lib/news` reads bytes a caller already has, and four
 * modules go and get them: `edgar.ts` for the SEC Form D Source, `accelerator-fetch.ts` for the
 * accelerator batch pages, `yc-fetch.ts` for Y Combinator's sitemap and company pages, and
 * `lib/news/feed-fetch.ts` for News's feeds. That split is what lets the parsers be tested
 * offline against committed captures, so it is asserted here rather than left to a comment.
 *
 * A file added tomorrow is covered too: this reads both trees rather than a hand-kept list, and
 * the only way to add a fifth fetching module is to say so on the line below.
 */
const MAY_FETCH = new Set([
  "lib/ingest/accelerator-fetch.ts",
  "lib/ingest/edgar.ts",
  "lib/ingest/yc-fetch.ts",
  "lib/news/feed-fetch.ts",
]);

const SOURCE_DIRECTORIES = ["lib/ingest", "lib/news"];

describe("the ingest boundary", () => {
  const NETWORK_MODULES = new Set([
    "node:http",
    "node:https",
    "node:net",
    "http",
    "https",
    "axios",
    "undici",
    "got",
    "node-fetch",
  ]);

  let sources: SourceFile[];

  beforeAll(async () => {
    sources = await readSourceFiles(SOURCE_DIRECTORIES);
  });

  it.each(SOURCE_DIRECTORIES)("reads the files under %s", (directory) => {
    expect(
      sources.some((source) => source.path.startsWith(`${directory}/`)),
    ).toBe(true);
  });

  it("imports nothing that can open a connection", () => {
    // Not even the fetching modules: they use the platform `fetch`, so a transport library
    // appearing here is a change worth making on purpose rather than by an import someone added
    // in passing.
    expect(
      sources.flatMap((source) =>
        importSpecifiers(source.text)
          .filter((specifier) => NETWORK_MODULES.has(specifier))
          .map((specifier) => `${source.path} imports ${specifier}`),
      ),
    ).toEqual([]);
  });

  it("calls a fetching API from exactly the one module allowed to", () => {
    expect(
      sources
        .filter(
          (source) =>
            !source.path.endsWith(".test.ts") &&
            /\b(?:fetch|XMLHttpRequest)\s*\(/.test(source.text),
        )
        .map((source) => source.path)
        // `readdir` promises no order, so the comparison does not depend on one.
        .sort(),
    ).toEqual([...MAY_FETCH].sort());
  });
});
