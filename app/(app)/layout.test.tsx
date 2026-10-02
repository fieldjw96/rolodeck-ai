import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), {
      digest: `NEXT_REDIRECT;replace;${path};307;`,
    });
  }),
  // `Nav`, which this layout renders, marks the current route with it.
  usePathname: () => "/deck",
}));

vi.mock("../../lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("../../lib/auth/onboarding", () => ({ needsOnboarding: vi.fn() }));
// The sign-out Server Action reaches Supabase, and this layout only renders a form around it.
vi.mock("./actions", () => ({ signOut: vi.fn() }));

import { needsOnboarding } from "../../lib/auth/onboarding";
import { ONBOARDING_PATH } from "../../lib/auth/paths";
import { requireUser } from "../../lib/auth/session";
import AppLayout from "./layout";

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "a@b.test" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * The authoritative first-run gate, per docs/adr/0004's argument that a check at the edge is
 * optimistic and the one in the layout is not. The redirects in `app/login/actions.ts` and
 * `app/auth/callback/route.ts` only cover a User who has just signed in; these cover the User
 * who arrives at `/deck` from a bookmark, a typed URL or a link, which is how somebody reached
 * the Deck without ever being asked.
 */
describe("AppLayout", () => {
  it("sends a User who has never been asked to the first-run screen", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER as never);
    vi.mocked(needsOnboarding).mockResolvedValue(true);

    await expect(AppLayout({ children: <p>the Deck</p> })).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    const { redirect } = await import("next/navigation");
    expect(redirect).toHaveBeenCalledWith(ONBOARDING_PATH);
  });

  it("renders the app for a User who has been asked", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER as never);
    vi.mocked(needsOnboarding).mockResolvedValue(false);

    render(await AppLayout({ children: <p>the Deck</p> }));

    expect(screen.getByText("the Deck")).toBeTruthy();

    const { redirect } = await import("next/navigation");
    expect(redirect).not.toHaveBeenCalled();
  });

  // A User who skipped has a row, so `needsOnboarding` is false for them and they are not asked
  // again. Asserted here rather than only in `db/user-profile.test.ts` because this layout is
  // what would ask, and an infinite redirect between `/deck` and `/onboarding` is the specific
  // failure a wrong answer here produces.
  it("does not ask again once a User has been asked, however they answered", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER as never);
    vi.mocked(needsOnboarding).mockResolvedValue(false);

    render(await AppLayout({ children: <p>the Deck</p> }));

    expect(screen.getByText("the Deck")).toBeTruthy();
  });
});
