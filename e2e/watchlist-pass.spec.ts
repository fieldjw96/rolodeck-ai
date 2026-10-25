import type { Page } from "@playwright/test";

import { expect, test, type SeededUser } from "./support/real-db-app";

/** Matches `EMPTY_WATCHLIST_MESSAGE` in `app/(app)/watchlist/watchlist.tsx`. Not imported
 * directly, same reason `swipe-flow.spec.ts` does not import `EMPTY_DECK_MESSAGE`: that module
 * is a client component with a CSS module import Playwright's own runtime does not know how
 * to load. */
const EMPTY_WATCHLIST_MESSAGE = "You haven't Kept any Profiles yet.";

/** Types a throwaway user's credentials into the real login form and submits it, same as
 * `swipe-flow.spec.ts`'s `login()`. */
async function login(page: Page, baseURL: string, user: SeededUser) {
  await page.goto(`${baseURL}/login/password`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseURL}/deck`);
}

/** Clicks the Deck's Keep button and waits for its write to land, so a Watchlist visited
 * right after is reading a Keep that has actually happened rather than racing one `deck.tsx`
 * fired with `keepalive` and never waits on (see its own `recordSwipe`). Started before the
 * click, same as that module's write, so a response fast enough to land inside the click
 * itself is still caught. */
async function keep(page: Page) {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        /\/api\/profiles\/[^/]+\/keep$/.test(response.url()) &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Keep" }).click(),
  ]);
}

test("Passing a Kept Profile from the Watchlist takes it back, and the Watchlist still does not carry it after a reload", async ({
  page,
  app,
  seededUser,
}) => {
  const [older, newer] = seededUser.profileNames;

  await login(page, app.baseURL, seededUser);

  // Keep both Profiles so the Watchlist has one left after the Pass under test.
  await expect(page.getByRole("heading", { name: newer })).toBeVisible();
  await keep(page);

  await expect(page.getByRole("heading", { name: older })).toBeVisible();
  await keep(page);

  await page.getByRole("link", { name: "Watchlist" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/watchlist`);
  await expect(page.getByRole("heading", { name: newer })).toBeVisible();
  await expect(page.getByRole("heading", { name: older })).toBeVisible();

  await page.getByRole("button", { name: `Open ${older}` }).click();
  const dialog = page.getByRole("dialog", { name: older });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Pass" }).click();

  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: older })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: newer })).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name: newer })).toBeVisible();
  await expect(page.getByRole("heading", { name: older })).not.toBeVisible();
});

test("Passing the only Kept Profile from the Watchlist shows the empty state", async ({
  page,
  app,
  seededUser,
}) => {
  const [, newer] = seededUser.profileNames;

  await login(page, app.baseURL, seededUser);

  await expect(page.getByRole("heading", { name: newer })).toBeVisible();
  await keep(page);

  await page.getByRole("link", { name: "Watchlist" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/watchlist`);
  await expect(page.getByRole("heading", { name: newer })).toBeVisible();

  await page.getByRole("button", { name: `Open ${newer}` }).click();
  await page
    .getByRole("dialog", { name: newer })
    .getByRole("button", { name: "Pass" })
    .click();

  await expect(page.getByText(EMPTY_WATCHLIST_MESSAGE)).toBeVisible();

  await page.reload();

  await expect(page.getByText(EMPTY_WATCHLIST_MESSAGE)).toBeVisible();
});
