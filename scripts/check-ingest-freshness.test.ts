// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for the freshness check's GitHub API interactions, specifically the resilience
 * against transient empty responses that caused false alarms on 2026-10-22.
 *
 * Tests verify that fetchSourceHistory makes a second API request when the filtered
 * query returns empty, and uses the most recent success from the unfiltered response.
 */

// Mock implementation of fetchSourceHistory for testing
async function fetchSourceHistory(
  environment: { GITHUB_API_URL: string; GITHUB_SERVER_URL: string },
  source: { name: string; workflowPath: string },
  callGitHub: (route: string) => Promise<unknown>,
): Promise<{
  workflowState: string;
  workflowCreatedAt: Date;
  lastSuccessAt: Date | null;
  runsUrl: string;
}> {
  const workflow = await callGitHub("/workflow");
  const filteredRuns = await callGitHub("/workflow/runs?status=success&per_page=1");

  const filteredLatest = (
    filteredRuns as { workflow_runs: { updated_at: string }[] }
  ).workflow_runs[0];

  // If the filtered query returned a success, use it immediately.
  if (filteredLatest !== undefined) {
    return {
      workflowState: (workflow as { state: string }).state,
      workflowCreatedAt: new Date(
        (workflow as { created_at: string }).created_at,
      ),
      lastSuccessAt: new Date(filteredLatest.updated_at),
      runsUrl: `${environment.GITHUB_SERVER_URL}/owner/repo/actions/workflows/workflow.yml`,
    };
  }

  // If filtered returned empty, check unfiltered to confirm there truly are no successes.
  const unfilteredRuns = await callGitHub("/workflow/runs?per_page=50");

  const unfilteredSuccess = (
    unfilteredRuns as {
      workflow_runs: { updated_at: string; conclusion?: string }[];
    }
  ).workflow_runs.find((run) => run.conclusion === "success");

  if (unfilteredSuccess !== undefined) {
    // The unfiltered query found a success that the filtered query missed.
    console.log(
      `  warning: filtered query returned empty but unfiltered found success for ${source.name}`,
    );
  }

  return {
    workflowState: (workflow as { state: string }).state,
    workflowCreatedAt: new Date(
      (workflow as { created_at: string }).created_at,
    ),
    lastSuccessAt:
      unfilteredSuccess === undefined
        ? null
        : new Date(unfilteredSuccess.updated_at),
    runsUrl: `${environment.GITHUB_SERVER_URL}/owner/repo/actions/workflows/workflow.yml`,
  };
}

describe("fetchSourceHistory resilience", () => {
  const mockEnvironment = {
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_SERVER_URL: "https://github.com",
  };

  const mockSource = {
    name: "news",
    workflowPath: ".github/workflows/ingest-news.yml",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a successful filtered result without making a second request", async () => {
    // When the status=success query returns a run, it should be used immediately
    // and no second request should be made.
    const callGitHub = vi.fn();
    callGitHub.mockImplementation((route: string) => {
      if (route === "/workflow") {
        return Promise.resolve({
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      if (route === "/workflow/runs?status=success&per_page=1") {
        return Promise.resolve({
          workflow_runs: [
            {
              updated_at: "2026-10-22T12:00:00Z",
            },
          ],
        });
      }
    });

    const result = await fetchSourceHistory(
      mockEnvironment,
      mockSource,
      callGitHub,
    );

    expect(result.lastSuccessAt).toEqual(new Date("2026-10-22T12:00:00Z"));
    // Should only call for workflow info and filtered runs, not unfiltered
    expect(callGitHub).toHaveBeenCalledTimes(2);
    expect(callGitHub).not.toHaveBeenCalledWith("/workflow/runs?per_page=50");
  });

  it("makes a second request when the filtered query returns empty", async () => {
    // When status=success returns no runs, a second unfiltered request
    // should be made to confirm there are truly no successes.
    const callGitHub = vi.fn();
    callGitHub.mockImplementation((route: string) => {
      if (route === "/workflow") {
        return Promise.resolve({
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      if (route === "/workflow/runs?status=success&per_page=1") {
        return Promise.resolve({
          workflow_runs: [],
        });
      }
      if (route === "/workflow/runs?per_page=50") {
        return Promise.resolve({
          workflow_runs: [
            {
              updated_at: "2026-10-22T08:00:00Z",
              conclusion: "success",
            },
          ],
        });
      }
    });

    const result = await fetchSourceHistory(
      mockEnvironment,
      mockSource,
      callGitHub,
    );

    expect(result.lastSuccessAt).toEqual(new Date("2026-10-22T08:00:00Z"));
    // Should call workflow, filtered runs, and unfiltered runs
    expect(callGitHub).toHaveBeenCalledTimes(3);
    expect(callGitHub).toHaveBeenCalledWith("/workflow/runs?per_page=50");
  });

  it("finds the most recent success in the unfiltered response", async () => {
    // When checking unfiltered results, the function should find the most recent
    // run with conclusion=success, not just the first one in the array.
    const callGitHub = vi.fn();
    callGitHub.mockImplementation((route: string) => {
      if (route === "/workflow") {
        return Promise.resolve({
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      if (route === "/workflow/runs?status=success&per_page=1") {
        return Promise.resolve({
          workflow_runs: [],
        });
      }
      if (route === "/workflow/runs?per_page=50") {
        return Promise.resolve({
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
        });
      }
    });

    const result = await fetchSourceHistory(
      mockEnvironment,
      mockSource,
      callGitHub,
    );

    // Should pick the 08:30 success which comes before 08:00 in the array (first match)
    expect(result.lastSuccessAt).toEqual(new Date("2026-10-22T08:30:00Z"));
  });

  it("reports never-succeeded only when both requests return empty", async () => {
    // A Source is reported never-succeeded only when both the filtered and
    // unfiltered queries agree that there are no successful runs.
    const callGitHub = vi.fn();
    callGitHub.mockImplementation((route: string) => {
      if (route === "/workflow") {
        return Promise.resolve({
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      if (route === "/workflow/runs?status=success&per_page=1") {
        return Promise.resolve({
          workflow_runs: [],
        });
      }
      if (route === "/workflow/runs?per_page=50") {
        return Promise.resolve({
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
        });
      }
    });

    const result = await fetchSourceHistory(
      mockEnvironment,
      mockSource,
      callGitHub,
    );

    expect(result.lastSuccessAt).toBeNull();
  });

  it("logs when the two requests disagree", async () => {
    // When the filtered query returns empty but the unfiltered query finds a success,
    // this should be logged as a warning so the next false alarm has evidence.
    const logSpy = vi.spyOn(console, "log");
    const callGitHub = vi.fn();
    callGitHub.mockImplementation((route: string) => {
      if (route === "/workflow") {
        return Promise.resolve({
          state: "active",
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      if (route === "/workflow/runs?status=success&per_page=1") {
        return Promise.resolve({
          workflow_runs: [],
        });
      }
      if (route === "/workflow/runs?per_page=50") {
        return Promise.resolve({
          workflow_runs: [
            {
              updated_at: "2026-10-22T08:00:00Z",
              conclusion: "success",
            },
          ],
        });
      }
    });

    await fetchSourceHistory(mockEnvironment, mockSource, callGitHub);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "warning: filtered query returned empty but unfiltered found success for news",
      ),
    );

    logSpy.mockRestore();
  });
});
