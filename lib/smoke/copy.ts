/**
 * Copy from `app/(app)/news/news.tsx` and `app/(app)/diary/diary.tsx`, copied here rather than
 * imported where it is needed: `scripts/smoke.ts` runs under `tsx`, and a Playwright spec runs
 * under Playwright's own test runner, and neither resolves a `"use client"` component's CSS
 * module import. `lib/smoke/copy.test.ts` asserts these stay equal to the real exports, so this
 * copy cannot drift from the pages without a test failing.
 */

export const NEWS_LOAD_ERROR_MESSAGE = "Couldn't load News.";
export const NEWS_LOADING_MESSAGE = "Loading News…";

export const DIARY_LOAD_ERROR_MESSAGE = "Couldn't load the Diary.";
export const DIARY_LOADING_MESSAGE = "Loading the Diary…";
