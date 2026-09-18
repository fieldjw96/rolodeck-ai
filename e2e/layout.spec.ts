import type { Page } from "@playwright/test";

import { expect, test } from "./support/signed-in-app";

/** An iPhone 12/13/14 in portrait: the narrowest viewport the Ticket asks the layout to hold. */
const PHONE = { width: 390, height: 844 };

/** The width the card's own Ticket asks it to hold without scrolling sideways, on any tab. */
const NARROW = { width: 400, height: 844 };

/** A laptop, where the failure mode is a column that never stops growing rather than one that
 * overflows. */
const DESKTOP = { width: 1440, height: 900 };

/**
 * A deliberately hostile Profile. The name is one unbroken 44-character token, of the kind a
 * scraper really does produce, and the description is long enough to wrap several times: both
 * are what push a card past its container if nothing wraps them.
 */
const PROFILE = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Hyperconvergentmicromobilityinfrastructure",
  description:
    "Fleet telematics and kerbside routing for shared micromobility operators, sold to city transport authorities as a managed service.",
  sector: "Transportation and logistics",
  stage: "Pre-seed",
  website: "https://hyperconvergentmicromobilityinfrastructure.example",
  // A founder whose name, role and biography each carry an unbroken token, so every row of the
  // Team and Contact tabs has something that would push the card wider if it did not wrap.
  founders: [
    {
      name: "Maximilianalexandervonhohenzollernsigmaringen Smith",
      role: "Cofounderandchiefexecutiveofficerandchairman",
      bio: "Previouslyfoundedthreemicromobilitycompaniesacrossfourcontinents and now builds this one.",
      linkedin: "https://www.linkedin.com/in/maximilian",
    },
    { name: "Ada Quinn", role: "CTO" },
  ],
  links: {
    linkedin: "https://www.linkedin.com/company/hyperconvergent",
    twitter: "https://x.com/hyperconvergent",
    github: "https://github.com/hyperconvergent",
  },
};

/**
 * Answers both reads the app makes, so the layout is measured against a real card rather than
 * against whatever error state a CI runner with no Postgres would otherwise produce. Nothing
 * here changes what the Deck queries: it is the same `/api/profiles` contract, stubbed.
 */
async function stubProfiles(page: Page): Promise<void> {
  await page.route("**/api/profiles*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        profiles: [
          PROFILE,
          { ...PROFILE, id: "22222222-2222-2222-2222-222222222222" },
        ],
        next_cursor: null,
      }),
    });
  });
}

/** The whole assertion: the document is no wider than the window it is being shown in. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  expect(
    scrollWidth,
    `the page is ${String(scrollWidth)}px wide in a ${String(clientWidth)}px viewport`,
  ).toBeLessThanOrEqual(clientWidth);
}

/** The card itself, not just the page, is no wider than the room it is given. */
async function expectCardFits(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page
    .locator("article")
    .evaluate((card) => ({
      scrollWidth: card.scrollWidth,
      clientWidth: card.clientWidth,
    }));

  expect(
    scrollWidth,
    `the card's content is ${String(scrollWidth)}px wide in a ${String(clientWidth)}px card`,
  ).toBeLessThanOrEqual(clientWidth);
}

test("the Deck's card wraps rather than scrolls sideways at 400px, on every tab", async ({
  browser,
  app,
}) => {
  const context = await browser.newContext({ viewport: NARROW });
  await context.addCookies(
    app.cookies.map(({ name: cookie, value }) => ({
      name: cookie,
      value,
      url: app.baseURL,
    })),
  );

  const page = await context.newPage();
  await stubProfiles(page);
  await page.goto(`${app.baseURL}/deck`);

  await expect(page.getByRole("heading", { name: PROFILE.name })).toBeVisible();

  for (const tab of ["Company", "Team", "Contact"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tabpanel", { name: tab })).toBeVisible();

    await expectNoHorizontalScroll(page);
    await expectCardFits(page);
  }

  await context.close();
});

for (const [name, viewport] of [
  ["a 390px phone", PHONE],
  ["a desktop window", DESKTOP],
] as const) {
  test(`the Deck holds at ${name}`, async ({ browser, app }) => {
    const context = await browser.newContext({ viewport });
    await context.addCookies(
      app.cookies.map(({ name: cookie, value }) => ({
        name: cookie,
        value,
        url: app.baseURL,
      })),
    );

    const page = await context.newPage();
    await stubProfiles(page);
    await page.goto(`${app.baseURL}/deck`);

    // Measuring before the card has replaced the loading state would be measuring the wrong
    // page, and would pass whatever the card does.
    await expect(
      page.getByRole("heading", { name: PROFILE.name }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Keep" })).toBeVisible();

    await expectNoHorizontalScroll(page);

    await context.close();
  });

  test(`the Watchlist holds at ${name}`, async ({ browser, app }) => {
    const context = await browser.newContext({ viewport });
    await context.addCookies(
      app.cookies.map(({ name: cookie, value }) => ({
        name: cookie,
        value,
        url: app.baseURL,
      })),
    );

    const page = await context.newPage();
    await stubProfiles(page);
    await page.goto(`${app.baseURL}/watchlist`);

    await expect(
      page.getByRole("heading", { level: 1, name: "Watchlist" }),
    ).toBeVisible();

    await expectNoHorizontalScroll(page);

    await context.close();
  });
}
