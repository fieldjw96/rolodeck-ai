import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StateNotice } from "./state-notice";

afterEach(cleanup);

describe("a state notice", () => {
  it("says what happened and what to do about it, rather than one bare string", () => {
    render(<StateNotice title="Nothing left." body="More arrive later." />);

    const notice = screen.getByRole("status");

    expect(notice).toHaveTextContent("Nothing left.");
    expect(notice).toHaveTextContent("More arrive later.");
    expect(notice).not.toHaveAttribute("aria-busy");
  });

  it("interrupts for a failure and stays quiet for the rest", () => {
    render(
      <StateNotice
        tone="danger"
        live="alert"
        title="Couldn't load it."
        body="Try again."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load it.");
  });

  it("marks itself busy while something is in flight", () => {
    render(<StateNotice busy title="Loading…" body="One moment." />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("hides its decoration from assistive tech, because the title already says it", () => {
    const { container } = render(
      <StateNotice title="Nothing left." body="More arrive later." />,
    );

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
