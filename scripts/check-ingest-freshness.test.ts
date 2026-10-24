// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as freshness from "./check-ingest-freshness";

/**
 * Tests for the freshness check's GitHub API interactions, specifically the resilience
 * against transient empty responses that caused false alarms on 2026-10-22.
 *
 * Tests verify that fetchSourceHistory makes a second API request when the filtered
 * query returns empty, and uses the most recent success from the unfiltered response.
 */

describe("fetchSourceHistory resilience", () => {
  const mockEnvironment = {
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "test/repo",
    GITHUB_SERVER_URL: "https://github.com",
  };

  const mockSource = {
    name: "news",
    workflowPath: ".github/workflows/ingest-news.yml",
    crons: ["20 8 * * *"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockFetch(responses: Map<string, unknown>) {
    const fetchMock = vi.fn(async (url: string) => {
      const response = responses.get(url);
      if (!response) {
        return new Response(
          JSON.stringify({
            message: "Not found",
            documentation_url: "https://docs.github.com/rest",
          }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("uses a successful filtered result without making a second request", async () => {
    // When the status=success query returns a run, it should be used immediately
    // and no second request should be made.
    const responses = new Map([
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml",
        {
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?status=success&per_page=1",
        {
          workflow_runs: [
            {
              updated_at: "2026-10-22T12:00:00Z",
            },
          ],
        },
      ],
    ]);

    const fetchMock = mockFetch(responses);

    const result = await freshness.fetchSourceHistory(
      mockEnvironment as Parameters<typeof freshness.fetchSourceHistory>[0],
      mockSource as Parameters<typeof freshness.fetchSourceHistory>[1],
    );

    expect(result.lastSuccessAt).toEqual(new Date("2026-10-22T12:00:00Z"));
    // Should only call for workflow info and filtered runs, not unfiltered
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const callArgs = fetchMock.mock.calls.map((c) => c[0]);
    expect(callArgs.some((arg) => arg.includes("per_page=50"))).toBe(false);
  });

  it("makes a second request when the filtered query returns empty", async () => {
    // When status=success returns no runs, a second unfiltered request
    // should be made to confirm there are truly no successes.
    const responses = new Map([
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml",
        {
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?status=success&per_page=1",
        {
          workflow_runs: [],
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?per_page=50",
        {
          workflow_runs: [
            {
              updated_at: "2026-10-22T08:00:00Z",
              conclusion: "success",
            },
          ],
        },
      ],
    ]);

    const fetchMock = mockFetch(responses);

    const result = await freshness.fetchSourceHistory(
      mockEnvironment as Parameters<typeof freshness.fetchSourceHistory>[0],
      mockSource as Parameters<typeof freshness.fetchSourceHistory>[1],
    );

    expect(result.lastSuccessAt).toEqual(new Date("2026-10-22T08:00:00Z"));
    // Should call workflow, filtered runs, and unfiltered runs
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const callArgs = fetchMock.mock.calls.map((c) => c[0]);
    expect(callArgs.some((arg) => arg.includes("per_page=50"))).toBe(true);
  });

  it("finds the most recent success in the unfiltered response", async () => {
    // When checking unfiltered results, the function should find the first
    // run with conclusion=success in the array (GitHub returns in reverse chronological order).
    const responses = new Map([
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml",
        {
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?status=success&per_page=1",
        {
          workflow_runs: [],
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?per_page=50",
        {
          workflow_runs: [
            {
              updated_at: "2026-10-22T10:00:00Z",
              conclusion: "failure",
            },
            {
              updated_at: "2026-10-22T08:30:00Z",
              conclusion: "success",
            },
            {
              updated_at: "2026-10-22T08:00:00Z",
              conclusion: "success",
            },
          ],
        },
      ],
    ]);

    void mockFetch(responses);

    const result = await freshness.fetchSourceHistory(
      mockEnvironment as Parameters<typeof freshness.fetchSourceHistory>[0],
      mockSource as Parameters<typeof freshness.fetchSourceHistory>[1],
    );

    // Should pick the 08:30 success which comes before 08:00 in the array (first match)
    expect(result.lastSuccessAt).toEqual(new Date("2026-10-22T08:30:00Z"));
  });

  it("reports never-succeeded only when both requests return empty", async () => {
    // A Source is reported never-succeeded only when both the filtered and
    // unfiltered queries agree that there are no successful runs.
    const responses = new Map([
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml",
        {
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?status=success&per_page=1",
        {
          workflow_runs: [],
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?per_page=50",
        {
          workflow_runs: [
            {
              updated_at: "2026-10-22T15:00:00Z",
              conclusion: "failure",
            },
            {
              updated_at: "2026-10-22T14:00:00Z",
              conclusion: "failure",
            },
          ],
        },
      ],
    ]);

    void mockFetch(responses);

    const result = await freshness.fetchSourceHistory(
      mockEnvironment as Parameters<typeof freshness.fetchSourceHistory>[0],
      mockSource as Parameters<typeof freshness.fetchSourceHistory>[1],
    );

    expect(result.lastSuccessAt).toBeNull();
  });

  it("logs when the two requests disagree", async () => {
    // When the filtered query returns empty but the unfiltered query finds a success,
    // this should be logged as a warning so the next false alarm has evidence.
    const responses = new Map([
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml",
        {
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?status=success&per_page=1",
        {
          workflow_runs: [],
        },
      ],
      [
        "https://api.github.com/repos/test/repo/actions/workflows/ingest-news.yml/runs?per_page=50",
        {
          workflow_runs: [
            {
              updated_at: "2026-10-22T08:00:00Z",
              conclusion: "success",
            },
          ],
        },
      ],
    ]);

    void mockFetch(responses);
    const logSpy = vi.spyOn(console, "log");

    await freshness.fetchSourceHistory(
      mockEnvironment as Parameters<typeof freshness.fetchSourceHistory>[0],
      mockSource as Parameters<typeof freshness.fetchSourceHistory>[1],
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "warning: filtered query returned empty but unfiltered found success for news",
      ),
    );

    logSpy.mockRestore();
  });
});
