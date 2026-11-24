import { describe, expect, it } from "vitest";

import {
  LOAD_ERROR_MESSAGE as DIARY_PAGE_LOAD_ERROR_MESSAGE,
  LOADING_DIARY_MESSAGE as DIARY_PAGE_LOADING_MESSAGE,
} from "../../app/(app)/diary/diary";
import {
  LOAD_ERROR_MESSAGE as NEWS_PAGE_LOAD_ERROR_MESSAGE,
  LOADING_NEWS_MESSAGE as NEWS_PAGE_LOADING_MESSAGE,
} from "../../app/(app)/news/news";
import {
  DIARY_LOAD_ERROR_MESSAGE,
  DIARY_LOADING_MESSAGE,
  NEWS_LOAD_ERROR_MESSAGE,
  NEWS_LOADING_MESSAGE,
} from "./copy";

// Unlike the page modules themselves, this file is plain TypeScript with no CSS module
// import, so `scripts/smoke.ts` (under `tsx`) and a Playwright spec can both import it. What
// keeps it from drifting away from the pages is this test, run only here, under Vitest, where
// a "use client" component's CSS module import resolves.
describe("lib/smoke/copy", () => {
  it("matches News's load-error copy", () => {
    expect(NEWS_LOAD_ERROR_MESSAGE).toBe(NEWS_PAGE_LOAD_ERROR_MESSAGE);
  });

  it("matches News's loading copy", () => {
    expect(NEWS_LOADING_MESSAGE).toBe(NEWS_PAGE_LOADING_MESSAGE);
  });

  it("matches the Diary's load-error copy", () => {
    expect(DIARY_LOAD_ERROR_MESSAGE).toBe(DIARY_PAGE_LOAD_ERROR_MESSAGE);
  });

  it("matches the Diary's loading copy", () => {
    expect(DIARY_LOADING_MESSAGE).toBe(DIARY_PAGE_LOADING_MESSAGE);
  });
});
