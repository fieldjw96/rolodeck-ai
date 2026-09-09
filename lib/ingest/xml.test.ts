// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseXml } from "./xml";

describe("parseXml", () => {
  it("reads a nested document as a nested record", () => {
    expect(
      parseXml(
        `<?xml version="1.0"?>
         <edgarSubmission>
           <submissionType>D</submissionType>
           <primaryIssuer>
             <entityName>Sprocket, Inc.</entityName>
             <issuerAddress><stateOrCountry>CA</stateOrCountry></issuerAddress>
           </primaryIssuer>
         </edgarSubmission>`,
      ),
    ).toEqual({
      root: "edgarSubmission",
      content: {
        submissionType: "D",
        primaryIssuer: {
          entityName: "Sprocket, Inc.",
          issuerAddress: { stateOrCountry: "CA" },
        },
      },
    });
  });

  it("decodes the entities EDGAR escapes element text with", () => {
    expect(
      parseXml(
        "<a><b>SPORTY &amp; RICH, &quot;Series A&quot; &lt;x&gt;</b></a>",
      ).content,
    ).toEqual({ b: 'SPORTY & RICH, "Series A" <x>' });
  });

  it("collects repeated siblings into an array, so a schema can see the change", () => {
    expect(parseXml("<a><b>one</b><b>two</b></a>").content).toEqual({
      b: ["one", "two"],
    });
  });

  it("reads an empty element as an empty string, however it is written", () => {
    expect(parseXml("<a><b></b><c/><d /></a>").content).toEqual({
      b: "",
      c: "",
      d: "",
    });
  });

  it("keeps CDATA and drops comments, prologs and doctypes", () => {
    expect(
      parseXml(
        "<!DOCTYPE a><!-- <b>ignored</b> --><a><b><![CDATA[ raw & <text> ]]></b></a>",
      ).content,
    ).toEqual({ b: "raw & <text>" });
  });

  it("does not mistake a > inside an attribute for the end of a tag", () => {
    expect(parseXml(`<a><b note="x > y">kept</b></a>`).content).toEqual({
      b: "kept",
    });
  });

  it.each([
    ["a mismatched closing tag", "<a><b></c></a>", "unexpected closing tag"],
    ["an unclosed element", "<a><b>text</b>", "unclosed element"],
    ["a document with no root", "<!-- nothing -->", "no root element"],
    ["a second root", "<a/><b/>", "a second root element"],
    ["text outside the root", "loose <a/>", "text outside the root"],
    ["an unterminated tag", "<a><b", "unterminated tag"],
    ["an unterminated comment", "<a><!-- open</a>", "unterminated comment"],
    ["an unterminated CDATA", "<a><![CDATA[ open</a>", "unterminated CDATA"],
  ])("throws on %s", (_, source, message) => {
    expect(() => parseXml(source)).toThrow(message);
  });
});
