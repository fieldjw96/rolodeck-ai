import type { Page } from "@playwright/test";

import {
  DIARY_LOAD_ERROR_MESSAGE,
  DIARY_LOADING_MESSAGE,
  NEWS_LOAD_ERROR_MESSAGE,
  NEWS_LOADING_MESSAGE,
} from "../lib/smoke/copy";
import { expect, test, type SeededUser } from "./support/real-db-app";

/** Types a throwaway user's credentials into the real login form and submits it, same as
 * `swipe-flow.spec.ts`'s `login()`. */
async function login(page: Page, baseURL: string, user: SeededUser) {
  await page.goto(`${baseURL}/login/password`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseURL}/deck`);
}

/**
 * Ticket #339: the deploy smoke test's "News renders" and "Diary renders" checks only ever
 * ran against production. Nothing rendered either page against a real Postgres before this,
 * so a page that only breaks once Postgres is real — rather than the mocked `/api/*` routes
 * `e2e/accessibility.spec.ts` stubs — could ship behind a green suite. Neither route is
 * stubbed here on purpose: `seededUser` has Profiles but has Kept none of them and nothing
 * ingested an Event, so both pages answer from Postgres into their own designed empty state,
 * which is a healthy page, not a failure to reach the network tab wasn't open for.
 */
test("News and the Diary both reach a real answer from Postgres, not their loading or error state", async ({
  page,
  app,
  seededUser,
}) => {
  await login(page, app.baseURL, seededUser);

  await page.getByRole("link", { name: "News" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/news`);
  await expect(page.getByText(NEWS_LOADING_MESSAGE)).not.toBeVisible();
  await expect(page.getByText(NEWS_LOAD_ERROR_MESSAGE)).not.toBeVisible();

  await page.getByRole("link", { name: "Diary" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/diary`);
  await expect(page.getByText(DIARY_LOADING_MESSAGE)).not.toBeVisible();
  await expect(page.getByText(DIARY_LOAD_ERROR_MESSAGE)).not.toBeVisible();
});
