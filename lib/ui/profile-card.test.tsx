import { readFileSync } from "node:fs";
import path from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Founder } from "../../db/profile-input";
import { initialsOf, ProfileCard } from "./profile-card";

afterEach(cleanup);

describe("a Profile card", () => {
  it("leads with the name as the heading, at the level the page asks for", () => {
    render(
      <ProfileCard
        headingLevel={1}
        name="Acme"
        description="Widgets, but faster."
        sector="Hardware"
        stage="Seed"
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Acme" }),
    ).toBeInTheDocument();

    cleanup();

    render(
      <ProfileCard
        headingLevel={2}
        name="Acme"
        sector="Hardware"
        stage="Seed"
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Acme" }),
    ).toBeInTheDocument();
  });

  // The Ticket's complaint about the unstyled build: `Sector` and `Stage` sat on their own
  // lines above their values, four lines of equal weight. Each is now a term paired with its
  // definition, which is what the styling then leans on.
  it.each([
    ["Sector", "Hardware"],
    ["Stage", "Seed"],
  ])("pairs %s with its value on the compact card", (label, value) => {
    render(
      <ProfileCard
        compact
        headingLevel={1}
        name="Acme"
        description="Widgets, but faster."
        sector="Hardware"
        stage="Seed"
      />,
    );

    const term = screen.getByText(label);

    expect(term.tagName).toBe("DT");
    expect(term.nextElementSibling?.tagName).toBe("DD");
    expect(term.nextElementSibling).toHaveTextContent(value);
  });

  it("renders a `not-stated` stage as `Not stated`, set apart from a stated one", () => {
    render(
      <ProfileCard
        headingLevel={1}
        name="Stated"
        sector="Hardware"
        stage="seed"
      />,
    );
    const stated = screen.getByText("Stage").nextElementSibling;

    cleanup();

    render(
      <ProfileCard
        headingLevel={1}
        name="Unstated"
        sector="Hardware"
        stage="not-stated"
      />,
    );
    const unstated = screen.getByText("Stage").nextElementSibling;

    expect(unstated?.tagName).toBe("DD");
    expect(unstated).toHaveTextContent(/^Not stated$/);
    expect(screen.queryByText("not-stated")).not.toBeInTheDocument();
    // Visibly distinct: the unstated value carries a class the stated one does not.
    expect(unstated?.className).not.toBe(stated?.className);
    expect(stated?.className).not.toBe("");
  });

  it("renders no description when there is none to render", () => {
    render(
      <ProfileCard
        headingLevel={2}
        name="Acme"
        sector="Hardware"
        stage="Seed"
      />,
    );

    expect(screen.queryByText("Widgets, but faster.")).not.toBeInTheDocument();
    expect(screen.getByText("Hardware")).toBeInTheDocument();
  });

  it("pairs Location with its value when the Profile states one", () => {
    render(
      <ProfileCard
        headingLevel={1}
        name="Acme"
        sector="Hardware"
        stage="Seed"
        location="San Francisco, CA"
      />,
    );

    const term = screen.getByText("Location");

    expect(term.tagName).toBe("DT");
    expect(term.nextElementSibling?.tagName).toBe("DD");
    expect(term.nextElementSibling).toHaveTextContent("San Francisco, CA");
  });

  it.each([
    ["null, because the Profile's location is unknown", null],
    ["undefined, because the caller reads no location at all", undefined],
  ])("renders no Location field when it is %s", (_description, location) => {
    render(
      <ProfileCard
        headingLevel={1}
        name="Acme"
        sector="Hardware"
        stage="Seed"
        location={location}
      />,
    );

    expect(screen.queryByText("Location")).not.toBeInTheDocument();
  });
});

// Shaped after the real rows the Ticket names: Versive's two founders state full biographies
// and both links, Mulligan's state LinkedIn only, and Tailornova's one founder has a
// biography that reads exactly "Retired", beside no company LinkedIn and no X.
const versive: Founder[] = [
  {
    name: "Ada Quinn",
    role: "CEO",
    bio: "Previously led platform engineering at a payments company.",
    linkedin: "https://www.linkedin.com/in/ada-quinn",
    twitter: "https://x.com/adaquinn",
  },
  {
    name: "Ben Ortiz",
    role: "CTO",
    bio: "Built distributed storage systems for a decade.",
    linkedin: "https://www.linkedin.com/in/ben-ortiz",
    twitter: "https://x.com/benortiz",
  },
];

const mulligan: Founder[] = [
  {
    name: "Cara Lind",
    role: "Co-founder",
    linkedin: "https://www.linkedin.com/in/cara-lind",
  },
  {
    name: "Dev Rao",
    role: "Co-founder",
    linkedin: "https://www.linkedin.com/in/dev-rao",
  },
];

const tailornova: Founder[] = [
  { name: "Elena Marsh", role: "Founder", bio: "Retired" },
];

function renderFull(
  overrides: Partial<Parameters<typeof ProfileCard>[0]> = {},
) {
  return render(
    <ProfileCard
      headingLevel={1}
      name="Versive"
      description="Security analytics for the enterprise."
      sector="B2B"
      stage="seed"
      website="https://versive.example"
      founders={versive}
      links={{ linkedin: "https://www.linkedin.com/company/versive" }}
      {...overrides}
    />,
  );
}

function tabNames(): string[] {
  return screen.getAllByRole("tab").map((tab) => tab.textContent ?? "");
}

describe("the full card", () => {
  it("shows Company, Team and Contact tabs, in that order, and opens on Company", () => {
    renderFull();

    expect(tabNames()).toEqual(["Company", "Team", "Contact"]);
    expect(screen.getByRole("tab", { name: "Company" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows exactly one panel at a time, associated with its tab", () => {
    renderFull();

    const panels = screen.getAllByRole("tabpanel");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toHaveAccessibleName("Company");

    fireEvent.click(screen.getByRole("tab", { name: "Contact" }));

    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    const contact = screen.getByRole("tabpanel", { name: "Contact" });
    expect(screen.getByRole("tab", { name: "Contact" })).toHaveAttribute(
      "aria-controls",
      contact.id,
    );
  });

  it("puts the name and the one-line description in the header", () => {
    renderFull();

    expect(
      screen.getByRole("heading", { level: 1, name: "Versive" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Security analytics for the enterprise."),
    ).toBeInTheDocument();
  });

  it("shows the founders as initials above the tabs, with a count beside them", () => {
    renderFull();

    const strip = screen.getByRole("list", { name: "Founders" });
    const circles = within(strip).getAllByRole("img");

    expect(circles.map((circle) => circle.textContent)).toEqual(["AQ", "BO"]);
    expect(circles[0]).toHaveAccessibleName("Ada Quinn");
    expect(screen.getByText("2 founders")).toBeInTheDocument();
  });

  it("counts staff beside the founders when a headcount is given", () => {
    renderFull({ staff: 3 });

    expect(screen.getByText("2 founders · 3 staff")).toBeInTheDocument();
    expect(
      screen.getByText("Team", { selector: "dt" }).nextElementSibling,
    ).toHaveTextContent(/^5$/);
  });

  it("shows Stage, Founded and Team as figures on the Company panel, then the sector", () => {
    renderFull({ founded: 2014 });

    const panel = screen.getByRole("tabpanel", { name: "Company" });
    const valueOf = (label: string) =>
      within(panel).getByText(label, { selector: "dt" }).nextElementSibling;

    expect(valueOf("Stage")).toHaveTextContent("seed");
    expect(valueOf("Founded")).toHaveTextContent("2014");
    expect(valueOf("Team")).toHaveTextContent("Not stated");
    expect(
      within(within(panel).getByRole("list", { name: "Sectors" })).getByText(
        "B2B",
      ),
    ).toBeInTheDocument();
  });

  it("lists each founder on the Team panel with their name, role and biography", () => {
    renderFull();

    fireEvent.click(screen.getByRole("tab", { name: "Team" }));
    const panel = screen.getByRole("tabpanel", { name: "Team" });
    const rows = within(panel).getAllByRole("listitem");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(
      "AQAda QuinnCEOPreviously led platform engineering at a payments company.",
    );
  });

  it('renders a founder whose biography is just "Retired" as it was stated', () => {
    renderFull({
      name: "Tailornova",
      founders: tailornova,
      links: null,
      stage: "not-stated",
    });

    fireEvent.click(screen.getByRole("tab", { name: "Team" }));

    expect(screen.getByText("Retired")).toBeInTheDocument();
  });

  it("renders a founder with no biography as their name and role and nothing else", () => {
    renderFull({ founders: mulligan });

    fireEvent.click(screen.getByRole("tab", { name: "Team" }));
    const [row] = within(
      screen.getByRole("tabpanel", { name: "Team" }),
    ).getAllByRole("listitem");
    const lines = row?.querySelector("div")?.children ?? [];

    // Two lines, name then role: no empty element where the biography would sit.
    expect(Array.from(lines).map((line) => line.textContent)).toEqual([
      "Cara Lind",
      "Co-founder",
    ]);
  });

  it("lists the company's own links, then each founder's, on the Contact panel", () => {
    renderFull();

    fireEvent.click(screen.getByRole("tab", { name: "Contact" }));
    const panel = screen.getByRole("tabpanel", { name: "Contact" });
    const company = within(panel).getByRole("list", { name: "Company links" });

    expect(
      within(company)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Website", "https://versive.example"],
      ["LinkedIn", "https://www.linkedin.com/company/versive"],
    ]);

    const ada = within(panel).getByRole("list", { name: "Ada Quinn's links" });
    expect(
      within(ada)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["LinkedIn", "X"]);
  });

  it("says plainly, per founder, when a founder states no public profile", () => {
    renderFull({ founders: tailornova, links: null });

    fireEvent.click(screen.getByRole("tab", { name: "Contact" }));
    const panel = screen.getByRole("tabpanel", { name: "Contact" });

    expect(
      within(panel).getByRole("link", { name: "Website" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getAllByText("No public profile stated."),
    ).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["absent", undefined],
  ])(
    "shows no founder strip and no Team tab when founders are %s",
    (_description, founders) => {
      renderFull({ founders });

      expect(
        screen.queryByRole("list", { name: "Founders" }),
      ).not.toBeInTheDocument();
      expect(tabNames()).toEqual(["Company", "Contact"]);

      fireEvent.click(screen.getByRole("tab", { name: "Contact" }));
      expect(screen.getByRole("link", { name: "LinkedIn" })).toHaveAttribute(
        "href",
        "https://www.linkedin.com/company/versive",
      );
    },
  );

  it("says so when neither the company nor anyone behind it states a link", () => {
    renderFull({ founders: null, links: null, website: null });

    fireEvent.click(screen.getByRole("tab", { name: "Contact" }));

    expect(screen.getByText("No company links stated.")).toBeInTheDocument();
  });

  it("still renders a `not-stated` stage as Not stated, set apart", () => {
    renderFull({ stage: "seed" });
    const stated = screen.getByText("Stage").nextElementSibling;

    cleanup();
    renderFull({ stage: "not-stated" });
    const unstated = screen.getByText("Stage").nextElementSibling;

    expect(unstated).toHaveTextContent(/^Not stated$/);
    expect(screen.queryByText("not-stated")).not.toBeInTheDocument();
    expect(unstated?.className).not.toBe(stated?.className);
  });

  it("renders no image anywhere", () => {
    const { container } = renderFull();

    expect(container.querySelector("img")).toBeNull();
  });
});

describe("the card's tabs from the keyboard", () => {
  it("are one stop in the tab order", () => {
    renderFull();

    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex")),
    ).toEqual(["0", "-1", "-1"]);
  });

  it("move and select with the arrow keys, wrapping at either end", () => {
    renderFull();
    const company = screen.getByRole("tab", { name: "Company" });
    company.focus();

    fireEvent.keyDown(company, { key: "ArrowRight" });

    const team = screen.getByRole("tab", { name: "Team" });
    expect(team).toHaveFocus();
    expect(team).toHaveAttribute("aria-selected", "true");
    expect(team).toHaveAttribute("tabindex", "0");
    expect(company).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Team");

    fireEvent.keyDown(team, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Contact" }), {
      key: "ArrowRight",
    });

    expect(company).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Company");

    fireEvent.keyDown(company, { key: "ArrowLeft" });

    expect(screen.getByRole("tab", { name: "Contact" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Contact");
  });

  it("jump to the first and last tab with Home and End", () => {
    renderFull();
    const company = screen.getByRole("tab", { name: "Company" });
    company.focus();

    fireEvent.keyDown(company, { key: "End" });
    expect(screen.getByRole("tab", { name: "Contact" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Contact" }), {
      key: "Home",
    });
    expect(company).toHaveFocus();
  });

  it("claim the arrow key, so nothing listening further up reads it as well", () => {
    renderFull();

    // `fireEvent` returns false when a handler called `preventDefault`.
    expect(
      fireEvent.keyDown(screen.getByRole("tab", { name: "Company" }), {
        key: "ArrowRight",
      }),
    ).toBe(false);
  });
});

describe("the compact card", () => {
  it("grows no tabs and no founder strip, whatever it is given", () => {
    render(
      <ProfileCard
        compact
        headingLevel={2}
        name="Versive"
        sector="B2B"
        stage="seed"
        founders={versive}
        links={{ linkedin: "https://www.linkedin.com/company/versive" }}
      />,
    );

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Founders" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Ada Quinn")).not.toBeInTheDocument();
  });
});

describe("initials", () => {
  it.each([
    ["Ada Quinn", "AQ"],
    ["Ada Byron Quinn", "AQ"],
    ["Madonna", "M"],
    ["  ada   quinn  ", "AQ"],
    ["J. R. R. Tolkien", "JT"],
    ["Élodie Ørsted", "ÉØ"],
    ["(Ada) Quinn", "AQ"],
  ])("of %j are %j", (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });

  it("never come from an avatar: no photograph is stored or fetched", () => {
    const source = readFileSync(
      path.join(process.cwd(), "lib", "ui", "profile-card.tsx"),
      "utf8",
    );

    expect(source).not.toMatch(/avatar_thumb_url/);
  });
});
