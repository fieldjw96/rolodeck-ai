import type { Page } from "@playwright/test";

import { expect, test, type SeededUser } from "./support/real-db-app";

/** Matches `EMPTY_DECK_MESSAGE` in `app/(app)/deck/deck.tsx`. Not imported directly: that
 * module is a client component with a CSS module import Playwright's own runtime, unlike
 * Vitest's, does not know how to load. */
const EMPTY_DECK_MESSAGE = "No Profiles left in the Deck.";

/** Types a throwaway user's credentials into the real login form and submits it, so this
 * spec exercises the same Server Action a person signing in does — not a cookie shortcut. */
async function login(page: Page, baseURL: string, user: SeededUser) {
  await page.goto(`${baseURL}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseURL}/deck`);
}

test("Keep carries a Profile to the Watchlist and Pass leaves it out", async ({
  page,
  app,
  seededUser,
}) => {
  const [older, newer] = seededUser.profileNames;

  await login(page, app.baseURL, seededUser);

  // The Deck deals newest first (`db/deck.ts`), so the second Profile seeded is dealt first.
  await expect(page.getByRole("heading", { name: newer })).toBeVisible();
  await page.getByRole("button", { name: "Keep" }).click();

  await expect(page.getByRole("heading", { name: older })).toBeVisible();
  await page.getByRole("button", { name: "Pass" }).click();

  await expect(page.getByText(EMPTY_DECK_MESSAGE)).toBeVisible();

  await page.getByRole("link", { name: "Watchlist" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/watchlist`);

  await expect(page.getByRole("heading", { name: newer })).toBeVisible();
  await expect(page.getByRole("heading", { name: older })).not.toBeVisible();
});

test("exhausting the Deck shows the empty state from #8", async ({
  page,
  app,
  seededUser,
}) => {
  await login(page, app.baseURL, seededUser);

  for (const name of [...seededUser.profileNames].reverse()) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await page.getByRole("button", { name: "Pass" }).click();
  }

  await expect(page.getByText(EMPTY_DECK_MESSAGE)).toBeVisible();
});
