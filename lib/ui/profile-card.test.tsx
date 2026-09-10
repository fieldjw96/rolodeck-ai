import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileCard } from "./profile-card";

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
  ])("pairs %s with its value", (label, value) => {
    render(
      <ProfileCard
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
});
