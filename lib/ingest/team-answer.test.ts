// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { readTeamPageFixture, type TeamPageFixture } from "../testing/fixtures";
import { pageStates, parseTeamAnswer } from "./team-answer";
import { visibleText } from "./team-page";

/**
 * The model's reading of a team page, checked against the page it read. The first test is the
 * point of Ticket #175: a real page capture, a synthetic model answer naming one person the
 * page states and one it does not, and only the real one survives. See docs/adr/0016.
 */

const REAL = "Joachim Lohse";
const INVENTED = "Priya Venkataraman";

let page: TeamPageFixture;
let text: string;

beforeAll(async () => {
  page = await readTeamPageFixture("ampcontrol");
  text = visibleText(page.html);
});

describe("parseTeamAnswer", () => {
  it("keeps a person the captured page names and drops one it never does", () => {
    // The premise, so the test cannot pass by the fixture changing under it.
    expect(text).toContain(REAL);
    expect(page.html).not.toContain(INVENTED);

    const answer = JSON.stringify({
      founders: [
        { name: REAL, role: "CEO & Founder" },
        {
          name: INVENTED,
          role: "Co-founder & CTO",
          bio: "Previously led grid software at a utility.",
        },
      ],
    });

    expect(parseTeamAnswer(answer, text)).toEqual({
      success: true,
      founders: [{ name: REAL, role: "CEO & Founder" }],
      dropped: [INVENTED],
    });
  });

  it("drops a name that differs from the page's by anything but whitespace", () => {
    const answer = JSON.stringify({
      founders: [{ name: "Joachim Lohs" }, { name: "joachim lohse" }],
    });

    expect(parseTeamAnswer(answer, `${text} `)).toMatchObject({
      success: true,
      founders: [],
      dropped: ["Joachim Lohs", "joachim lohse"],
    });
  });

  it("counts a name only where the page states it whole", () => {
    expect(pageStates("Jo Lohse, CEO", "Jo Lohs")).toBe(false);
    expect(pageStates("Ann Lee-Smith", "Ann Lee")).toBe(true);
    expect(pageStates("Joanne Lee", "Anne Lee")).toBe(false);
    expect(pageStates("(Anne Lee)", "Anne Lee")).toBe(true);
  });

  it("treats a page broken across lines or spaced with nbsp as stating the name", () => {
    expect(pageStates("Meet\nJoachim\n  Lohse\nCEO", REAL)).toBe(true);
    expect(pageStates(visibleText("<td>Joachim&nbsp;Lohse</td>"), REAL)).toBe(
      true,
    );
  });

  it("reads a page that names nobody as an empty team, not a rejection", () => {
    expect(parseTeamAnswer('{"founders":[]}', text)).toEqual({
      success: true,
      founders: [],
      dropped: [],
    });
  });

  it("keeps a name given twice once", () => {
    const answer = JSON.stringify({
      founders: [{ name: REAL }, { name: ` ${REAL} ` }],
    });

    expect(parseTeamAnswer(answer, text)).toMatchObject({
      founders: [{ name: REAL }],
    });
  });

  it("rejects an answer that is not JSON, saying so", () => {
    const result = parseTeamAnswer('```json\n{"founders":[]}\n```', text);

    expect(result).toMatchObject({
      success: false,
      rejection: { field: "(answer)" },
    });
    expect(!result.success && result.rejection.reason).toMatch(/is not JSON/);
  });

  it.each([
    ["an email address", { name: REAL, email: "jl@example.com" }, "founders.0"],
    [
      "a photo",
      { name: REAL, image: "https://example.com/j.png" },
      "founders.0",
    ],
    ["a blank name", { name: "  " }, "founders.0.name"],
    ["a missing name", { role: "CEO" }, "founders.0.name"],
  ])(
    "rejects a person carrying %s, naming the field",
    (_label, person, field) => {
      const result = parseTeamAnswer(
        JSON.stringify({ founders: [person] }),
        text,
      );

      expect(result.success).toBe(false);
      expect(!result.success && result.rejection.field).toContain(field);
    },
  );

  it("rejects an answer with keys beyond the team", () => {
    expect(
      parseTeamAnswer(JSON.stringify({ founders: [], company: "x" }), text),
    ).toMatchObject({ success: false, rejection: { field: "company" } });
  });
});
