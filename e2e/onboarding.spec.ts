import type { Page } from "@playwright/test";

import { expect, test, type NewUser } from "./support/real-db-app";

/** Matches `EMPTY_DECK_MESSAGE` in `app/(app)/deck/deck.tsx`, same reason `swipe-flow.spec.ts`
 * does not import it: that module is a client component with a CSS module import Playwright's
 * own runtime does not know how to load. Nothing is seeded for `newUser`, so the empty state is
 * exactly what landing on a real Deck looks like here. */
const EMPTY_DECK_MESSAGE = "No Profiles left in the Deck.";

/** Types a throwaway user's credentials into the real login form and submits it — the same
 * Server Action a person signing in does, not a cookie shortcut — and stops short of the
 * redirect `login()` in `swipe-flow.spec.ts` waits for, since this user's very point is that
 * it lands somewhere else first. */
async function login(page: Page, baseURL: string, user: NewUser) {
  await page.goto(`${baseURL}/login/password`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a User who has never saved a User Profile is asked before the Deck, and stating preferences reaches it", async ({
  page,
  app,
  newUser,
}) => {
  await login(page, app.baseURL, newUser);

  await expect(page).toHaveURL(`${app.baseURL}/onboarding`);
  await expect(
    page.getByRole("heading", { name: "Before your Deck" }),
  ).toBeVisible();

  // Both groups default to everything selected, which is the Acceptance Criterion: stating
  // nothing read back as every box checked, not as a blank form.
  await expect(page.getByRole("checkbox", { name: "ai-ml" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "seed" })).toBeChecked();

  await page.getByRole("button", { name: "Save and see my Deck" }).click();

  await expect(page).toHaveURL(`${app.baseURL}/deck`);
  await expect(page.getByText(EMPTY_DECK_MESSAGE)).toBeVisible();
});

test("the same User signing in again is not asked a second time", async ({
  page,
  app,
  newUser,
}) => {
  await login(page, app.baseURL, newUser);
  await expect(page).toHaveURL(`${app.baseURL}/onboarding`);
  await page.getByRole("button", { name: "Save and see my Deck" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/deck`);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/login`);

  await login(page, app.baseURL, newUser);
  await expect(page).toHaveURL(`${app.baseURL}/deck`);
});

test("skipping is one click, saves every preference empty, and is still editable afterwards in Settings", async ({
  page,
  app,
  newUser,
}) => {
  await login(page, app.baseURL, newUser);
  await expect(page).toHaveURL(`${app.baseURL}/onboarding`);

  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/deck`);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/settings`);

  const sectors = page.getByRole("group", { name: "Sectors" });
  await expect(
    sectors.getByRole("checkbox", { name: "ai-ml" }),
  ).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "seed" })).not.toBeChecked();

  // Not a one-time-only screen: the User who skipped can still state a preference later from
  // the same Settings page everyone else edits.
  await sectors.getByRole("checkbox", { name: "fintech" }).click();
  await page.getByRole("button", { name: /save/i }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");
});
