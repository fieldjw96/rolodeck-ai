import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), {
      digest: `NEXT_REDIRECT;replace;${path};307;`,
    });
  }),
  // `Onboarding`, which this page renders when it does not redirect, calls `useRouter` itself.
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../../lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("../../lib/auth/onboarding", () => ({ needsOnboarding: vi.fn() }));

import { needsOnboarding } from "../../lib/auth/onboarding";
import { requireUser } from "../../lib/auth/session";
import OnboardingPage from "./page";

const USER = { id: "11111111-1111-1111-1111-111111111111" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OnboardingPage", () => {
  it("renders the Onboarding screen for a User who has never been asked", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER as never);
    vi.mocked(needsOnboarding).mockResolvedValue(true);

    render(await OnboardingPage());

    expect(
      screen.getByRole("heading", { name: "Before your Deck" }),
    ).toBeInTheDocument();
  });

  it("redirects to the Deck for a User who already has a User Profile", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER as never);
    vi.mocked(needsOnboarding).mockResolvedValue(false);

    await expect(OnboardingPage()).rejects.toMatchObject({
      digest: expect.stringContaining("/deck"),
    });
  });
});
