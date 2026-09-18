// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readFiles } from "../testing/sources";
import {
  ingestSources,
  INGEST_RUN_WORKFLOW,
  type WorkflowFile,
} from "./workflow-schedules";

/**
 * Two questions: does a workflow file read as a Source, and does the real
 * `.github/workflows/` directory still read as the set of Sources it is supposed to.
 *
 * The second is the one that keeps this honest. A Source added tomorrow, or a cron changed
 * tomorrow, has to be picked up here without anyone editing a list — so the fixtures below
 * prove the shape and the directory proves the behaviour against the files that actually ship.
 */

const caller = (name: string, crons: string[]): string =>
  [
    "name: Ingest - Example",
    "on:",
    "  schedule:",
    ...crons.map((cron) => `    - cron: "${cron}"`),
    "  workflow_dispatch: {}",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  ingest:",
    `    uses: ./${INGEST_RUN_WORKFLOW}`,
    "    with:",
    `      source-name: ${name}`,
    "      npm-script: ingest:example",
    "",
  ].join("\n");

const file = (path: string, text: string): WorkflowFile => ({ path, text });

describe("ingestSources", () => {
  it("reads a Source's name and its own crons out of the caller workflow", () => {
    expect(
      ingestSources([
        file(
          ".github/workflows/ingest-example.yml",
          caller("example", ["20 8 * * *"]),
        ),
      ]),
    ).toEqual([
      {
        name: "example",
        workflowPath: ".github/workflows/ingest-example.yml",
        crons: ["20 8 * * *"],
      },
    ]);
  });

  it("keeps every cron a Source declares", () => {
    expect(
      ingestSources([
        file(
          ".github/workflows/ingest-example.yml",
          caller("example", ["20 8 * * *", "30 7 * * 1"]),
        ),
      ])[0]?.crons,
    ).toEqual(["20 8 * * *", "30 7 * * 1"]);
  });

  it("ignores a workflow that does not call the shared ingest workflow", () => {
    const ci = [
      "name: CI",
      "on:",
      "  pull_request:",
      "jobs:",
      "  ci:",
      "    steps:",
      "      - run: npm ci",
      "",
    ].join("\n");

    expect(ingestSources([file(".github/workflows/ci.yml", ci)])).toEqual([]);
  });

  it("ignores the shared ingest workflow itself, which has no schedule of its own", () => {
    const shared = [
      "name: Ingest run",
      "on:",
      "  workflow_call:",
      "jobs:",
      "  run:",
      "    steps:",
      "      - run: npm ci",
      "",
    ].join("\n");

    expect(ingestSources([file(INGEST_RUN_WORKFLOW, shared)])).toEqual([]);
  });

  it("refuses a Source with no schedule rather than dropping it from the report", () => {
    // A caller reachable only by hand has no cadence to be late against. Silently skipping it
    // is the exact failure this checker exists to notice, so it fails by name instead.
    const dispatchOnly = caller("example", ["20 8 * * *"]).replace(
      /  schedule:\n    - cron: "20 8 \* \* \*"\n/,
      "",
    );

    expect(() =>
      ingestSources([
        file(".github/workflows/ingest-example.yml", dispatchOnly),
      ]),
    ).toThrow(/ingest-example\.yml/);
  });

  it("refuses a caller with no source-name, which a report could not name", () => {
    const nameless = caller("example", ["20 8 * * *"]).replace(
      "      source-name: example\n",
      "",
    );

    expect(() =>
      ingestSources([file(".github/workflows/ingest-example.yml", nameless)]),
    ).toThrow(/ingest-example\.yml/);
  });

  it("names the file when the YAML itself will not parse", () => {
    expect(() =>
      ingestSources([
        file(".github/workflows/broken.yml", "jobs:\n  a: [unclosed\n"),
      ]),
    ).toThrow(/broken\.yml/);
  });

  it("orders Sources by name so a report reads the same way twice", () => {
    expect(
      ingestSources([
        file(".github/workflows/b.yml", caller("zulu", ["0 1 * * *"])),
        file(".github/workflows/a.yml", caller("alpha", ["0 2 * * *"])),
      ]).map((source) => source.name),
    ).toEqual(["alpha", "zulu"]);
  });
});

describe("this repository's own workflows", () => {
  it("every Source has a name, a path and at least one parseable cron", async () => {
    const sources = ingestSources(
      await readFiles([".github/workflows"], [".yml", ".yaml"]),
    );

    // Six Sources exist as this is written. Asserting "more than one" rather than "six" is
    // deliberate: the list comes from the directory, and a seventh must not fail a test here.
    expect(sources.length).toBeGreaterThan(1);

    for (const source of sources) {
      expect(source.name).not.toBe("");
      expect(source.workflowPath).toMatch(/^\.github\/workflows\/.+\.ya?ml$/);
      expect(source.crons.length).toBeGreaterThan(0);

      for (const cron of source.crons) {
        expect(cron.trim().split(/\s+/)).toHaveLength(5);
      }
    }
  });

  it("does not mistake the checker, CI or the deploy for a Source", async () => {
    const paths = ingestSources(
      await readFiles([".github/workflows"], [".yml", ".yaml"]),
    ).map((source) => source.workflowPath);

    expect(paths).not.toContain(".github/workflows/ci.yml");
    expect(paths).not.toContain(".github/workflows/deploy.yml");
    expect(paths).not.toContain(".github/workflows/ingest-freshness.yml");
    expect(paths).not.toContain(INGEST_RUN_WORKFLOW);
  });
});
