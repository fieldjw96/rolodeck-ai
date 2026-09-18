// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseRobots } from "./robots";

const TOKEN = "rolodeck-ai";

describe("parseRobots", () => {
  it("allows everything when the file says nothing", () => {
    expect(parseRobots("", TOKEN).allows("/team")).toBe(true);
  });

  it("obeys the * group when no group names this client", () => {
    const policy = parseRobots(
      "User-agent: *\nDisallow: /about\nDisallow: /private/\n",
      TOKEN,
    );

    expect(policy.allows("/about-us")).toBe(false);
    expect(policy.allows("/private/team")).toBe(false);
    expect(policy.allows("/team")).toBe(true);
  });

  it("refuses everything to a site whose * group disallows /, as LinkedIn's does", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /\n", TOKEN);

    expect(policy.allows("/")).toBe(false);
    expect(policy.allows("/about")).toBe(false);
  });

  it("uses a group naming this client instead of the * group, case-insensitively", () => {
    const text = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: Rolodeck-AI",
      "Disallow:",
    ].join("\n");

    expect(parseRobots(text, TOKEN).allows("/team")).toBe(true);
  });

  it("refuses this client by name even where * is allowed", () => {
    const text = "User-agent: rolodeck-ai\nDisallow: /\n\nUser-agent: *\nAllow: /\n";

    expect(parseRobots(text, TOKEN).allows("/")).toBe(false);
  });

  it("applies consecutive user-agent lines to one group", () => {
    const text = "User-agent: googlebot\nUser-agent: rolodeck-ai\nDisallow: /team\n";

    expect(parseRobots(text, TOKEN).allows("/team")).toBe(false);
    expect(parseRobots(text, TOKEN).allows("/about")).toBe(true);
  });

  it("lets the longest match win, and allow win a tie", () => {
    const text = [
      "User-agent: *",
      "Disallow: /company",
      "Allow: /company/team",
      "Disallow: /x",
      "Allow: /x",
    ].join("\n");
    const policy = parseRobots(text, TOKEN);

    expect(policy.allows("/company/news")).toBe(false);
    expect(policy.allows("/company/team")).toBe(true);
    expect(policy.allows("/x")).toBe(true);
  });

  it("reads * as a wildcard and $ as an end anchor, and ignores comments", () => {
    const text = [
      "User-agent: * # everyone",
      "Disallow: /*.pdf$",
      "Disallow: /*_page=",
    ].join("\n");
    const policy = parseRobots(text, TOKEN);

    expect(policy.allows("/deck.pdf")).toBe(false);
    expect(policy.allows("/deck.pdf.html")).toBe(true);
    expect(policy.allows("/blog?55c_page=2")).toBe(false);
  });
});
