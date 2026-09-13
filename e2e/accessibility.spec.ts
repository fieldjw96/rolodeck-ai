import type { Browser, Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { expect, test, type SignedInApp } from "./support/signed-in-app";

/** One Profile is enough for both pages this suite checks: the Deck renders it as the current
 * card, and the same fixture doubles as the one Kept Profile the Watchlist reads back. */
const PROFILE = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Acme",
  description: "Widgets, but faster.",
  sector: "Hardware",
  stage: "Seed",
};

/** Answers both `GET /api/profiles` (the Deck) and `GET /api/profiles?filter=kept` (the
 * Watchlist) with the same fixture: neither reader this suite exercises cares about the other's
 * query string, and `next_cursor` is simply ignored by the Watchlist's own parsing. */
async function stubProfiles(page: Page): Promise<void> {
  await page.route("**/api/profiles*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ profiles: [PROFILE], next_cursor: null }),
    });
  });
}

/** One important Event and one not, so the Diary's marking is on the page axe inspects. */
const EVENTS = [
  {
    id: "22222222-2222-2222-2222-222222222222",
    name: "Acme Demo Day",
    start_date: "2999-01-01",
    end_date: "2999-01-02",
    location: "San Francisco",
    url: "https://example.com/demo-day",
    important: true,
    kept_companies: [PROFILE.name],
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    name: "Robotics Meetup",
    start_date: "2999-02-01",
    end_date: null,
    location: null,
    url: "https://example.com/meetup",
    important: false,
    kept_companies: [],
  },
];

async function stubEvents(page: Page): Promise<void> {
  await page.route("**/api/events*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: EVENTS }),
    });
  });
}

/** A signed-in, stubbed page in its own browser context, the way `layout.spec.ts` builds one
 * per test — pulled into one helper here because every test in this file needs exactly this. */
async function openSignedInPage(
  browser: Browser,
  app: SignedInApp,
): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies(
    app.cookies.map(({ name, value }) => ({ name, value, url: app.baseURL })),
  );

  const page = await context.newPage();
  await stubProfiles(page);
  await stubEvents(page);
  return page;
}

/** The one focus-visible rule in `app/globals.css` applies to every element alike, so asserting
 * its `outline-style` is enough to know the currently focused element actually shows a ring. */
async function expectVisibleFocusOutline(locator: Locator): Promise<void> {
  await expect(locator).toHaveCSS("outline-style", "solid");
}

test("/diary has no critical or serious accessibility violations, and marks the important Event in words", async ({
  browser,
  app,
}) => {
  const page = await openSignedInPage(browser, app);
  await page.goto(`${app.baseURL}/diary`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Acme Demo Day" }),
  ).toBeVisible();
  await expect(page.getByText("Kept company attending:")).toBeVisible();
  await expect(page.getByRole("link", { name: "Diary" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const results = await new AxeBuilder({ page }).analyze();
  const seriousOrWorse = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );

  expect(seriousOrWorse, JSON.stringify(seriousOrWorse, null, 2)).toEqual([]);

  await page.context().close();
});

test("/deck has no critical or serious accessibility violations", async ({
  browser,
  app,
}) => {
  const page = await openSignedInPage(browser, app);
  await page.goto(`${app.baseURL}/deck`);
  await expect(page.getByRole("heading", { name: PROFILE.name })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const seriousOrWorse = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );

  expect(seriousOrWorse, JSON.stringify(seriousOrWorse, null, 2)).toEqual([]);

  await page.context().close();
});

test("/watchlist has no critical or serious accessibility violations", async ({
  browser,
  app,
}) => {
  const page = await openSignedInPage(browser, app);
  await page.goto(`${app.baseURL}/watchlist`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Watchlist" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: PROFILE.name }),
  ).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const seriousOrWorse = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );

  expect(seriousOrWorse, JSON.stringify(seriousOrWorse, null, 2)).toEqual([]);

  await page.context().close();
});

test("Tab reaches Deck, Watchlist, Diary, Sign out, Pass and Keep on /deck, in DOM order, each with a visible focus outline", async ({
  browser,
  app,
}) => {
  const page = await openSignedInPage(browser, app);
  await page.goto(`${app.baseURL}/deck`);
  await expect(page.getByRole("heading", { name: PROFILE.name })).toBeVisible();

  const focused = page.locator(":focus");

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("link");
  await expect(focused).toHaveAccessibleName("Deck");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("link");
  await expect(focused).toHaveAccessibleName("Watchlist");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("link");
  await expect(focused).toHaveAccessibleName("Diary");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("button");
  await expect(focused).toHaveAccessibleName("Sign out");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("button");
  await expect(focused).toHaveAccessibleName("Pass");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("button");
  await expect(focused).toHaveAccessibleName("Keep");
  await expectVisibleFocusOutline(focused);

  await page.context().close();
});

test("Tab reaches Deck, Watchlist, Diary and Sign out on /watchlist, in DOM order, each with a visible focus outline", async ({
  browser,
  app,
}) => {
  const page = await openSignedInPage(browser, app);
  await page.goto(`${app.baseURL}/watchlist`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Watchlist" }),
  ).toBeVisible();

  const focused = page.locator(":focus");

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("link");
  await expect(focused).toHaveAccessibleName("Deck");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("link");
  await expect(focused).toHaveAccessibleName("Watchlist");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("link");
  await expect(focused).toHaveAccessibleName("Diary");
  await expectVisibleFocusOutline(focused);

  await page.keyboard.press("Tab");
  await expect(focused).toHaveRole("button");
  await expect(focused).toHaveAccessibleName("Sign out");
  await expectVisibleFocusOutline(focused);

  await page.context().close();
});

test("Keep and Pass have distinct accessible names in the accessibility tree", async ({
  browser,
  app,
}) => {
  const page = await openSignedInPage(browser, app);
  await page.goto(`${app.baseURL}/deck`);
  await expect(page.getByRole("heading", { name: PROFILE.name })).toBeVisible();

  const snapshot = await page.locator("main").ariaSnapshot();

  expect(snapshot).toMatch(/button "Pass"/);
  expect(snapshot).toMatch(/button "Keep"/);

  await page.context().close();
});
