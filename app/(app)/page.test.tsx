// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import { redirect } from "next/navigation";
import Home from "./page";

describe("Home", () => {
  it("redirects to the Deck", () => {
    Home();

    expect(redirect).toHaveBeenCalledWith("/deck");
  });
});
