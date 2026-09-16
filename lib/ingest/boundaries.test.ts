// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import {
  importSpecifiers,
  readSourceFiles,
  type SourceFile,
} from "../testing/sources";

/**
 * Every Source parser under `lib/ingest` reads bytes a caller already has, and three modules —
 * `edgar.ts` for the SEC Form D Source, `accelerator-fetch.ts` for the accelerator batch pages,
 * `yc-fetch.ts` for Y Combinator's sitemap and company pages — go and get them. That split is
 * what lets the parsers be tested offline against committed captures, so it is asserted here
 * rather than left to a comment.
 *
 * A file added tomorrow is covered too: this reads the tree rather than a hand-kept list, and
 * the only way to add a fourth fetching module is to say so on the line below.
 */
const MAY_FETCH = new Set([
  "lib/ingest/accelerator-fetch.ts",
  "lib/ingest/edgar.ts",
  "lib/ingest/yc-fetch.ts",
]);

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
    sources = await readSourceFiles(["lib/ingest"]);
  });

  it("reads every file under lib/ingest", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("imports nothing that can open a connection", () => {
    // Not even `edgar.ts`: it uses the platform `fetch`, so a transport library appearing here
    // is a change worth making on purpose rather than by an import someone added in passing.
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
