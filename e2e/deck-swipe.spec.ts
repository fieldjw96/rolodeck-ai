import type { Locator, Page } from "@playwright/test";

import { expect, test, type SeededUser } from "./support/real-db-app";

/** An iPhone 12/13/14 in portrait, the same viewport `layout.spec.ts` pins the layout at:
 * the phone is where a swipe is the only input a reader has. */
test.use({ viewport: { width: 390, height: 844 } });

/** Matches `SWIPE_COMMIT_FRACTION` in `app/(app)/deck/deck.tsx`. Not imported directly, for
 * the reason `swipe-flow.spec.ts` gives for `EMPTY_DECK_MESSAGE`: that module is a client
 * component with a CSS module import Playwright's own runtime does not know how to load. */
const SWIPE_COMMIT_FRACTION = 0.25;

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
 * Drags the card to the right by `fraction` of its own width and lets go, pressing on the
 * company's name so the gesture starts on the card itself rather than on one of its tabs or
 * links. Several small moves rather than one jump, because that is what a pointer does and
 * because the first of them is what fixes the gesture's axis.
 */
async function dragRight(page: Page, card: Locator, fraction: number) {
  const box = await card.boundingBox();
  expect(box, "the card has no layout to drag").not.toBeNull();

  const from = {
    x: box!.x + box!.width / 2,
    y: box!.y + Math.min(box!.height / 2, 60),
  };
  const distance = box!.width * fraction;

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();

  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(from.x + (distance * step) / 10, from.y);
  }

  await page.mouse.up();
}

test("dragging the card past the threshold Keeps the Profile and deals the next one", async ({
  page,
  app,
  seededUser,
}) => {
  const [older, newer] = seededUser.profileNames;

  await login(page, app.baseURL, seededUser);

  // The Deck deals newest first (`db/deck.ts`), so the second Profile seeded is dealt first.
  await expect(page.getByRole("heading", { name: newer })).toBeVisible();

  // Waited on the way the Watchlist spec waits on its Keep: `deck.tsx` fires the write and
  // never waits on it, so a Watchlist visited straight after would otherwise race it.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        /\/api\/profiles\/[^/]+\/keep$/.test(response.url()) &&
        response.request().method() === "POST",
    ),
    dragRight(page, page.getByRole("article"), SWIPE_COMMIT_FRACTION + 0.15),
  ]);

  await expect(page.getByRole("heading", { name: older })).toBeVisible();

  await page.getByRole("link", { name: "Watchlist" }).click();
  await expect(page).toHaveURL(`${app.baseURL}/watchlist`);

  await expect(page.getByRole("heading", { name: newer })).toBeVisible();
  await expect(page.getByRole("heading", { name: older })).not.toBeVisible();
});
