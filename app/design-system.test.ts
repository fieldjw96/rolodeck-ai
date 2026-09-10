import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  contrastRatio,
  darkSchemeTokens,
  resolve,
  rootTokens,
  toRgb,
  type Rgb,
  type Tokens,
} from "../lib/testing/css-tokens";
import { readFiles, STYLE_EXTENSIONS } from "../lib/testing/sources";

const GLOBALS = path.join(process.cwd(), "app", "globals.css");

let css: string;
let light: Tokens;
let dark: Tokens;

beforeAll(async () => {
  css = await readFile(GLOBALS, "utf8");
  light = rootTokens(css);
  dark = darkSchemeTokens(css);
});

function colorNames(tokens: Tokens): string[] {
  return Object.keys(tokens)
    .filter((name) => name.startsWith("--color-"))
    .sort();
}

function rgb(name: string, tokens: Tokens): Rgb {
  const value = tokens[name];

  if (value === undefined) {
    throw new Error(`${name} is not defined in this scheme`);
  }

  const resolved = resolve(value, tokens, light);
  const color = toRgb(resolved);

  if (color === null) {
    throw new Error(`${name} resolved to "${resolved}", which is not a colour`);
  }

  return color;
}

/**
 * Every pairing the design actually puts on screen, with the WCAG 2.1 AA minimum that applies
 * to it: 4.5 for text, and 3 for the two non-text boundaries that carry meaning of their own —
 * the outlined Pass button and the focus ring.
 */
const PAIRINGS: [foreground: string, background: string, minimum: number][] = [
  ["--color-text", "--color-canvas", 4.5],
  ["--color-text", "--color-surface", 4.5],
  ["--color-text", "--color-surface-muted", 4.5],
  ["--color-text", "--color-accent-soft", 4.5],
  ["--color-text", "--color-danger-soft", 4.5],
  ["--color-text-muted", "--color-canvas", 4.5],
  ["--color-text-muted", "--color-surface", 4.5],
  ["--color-text-muted", "--color-surface-muted", 4.5],
  ["--color-text-faint", "--color-canvas", 4.5],
  ["--color-text-faint", "--color-surface", 4.5],
  ["--color-accent", "--color-canvas", 4.5],
  ["--color-accent", "--color-surface", 4.5],
  ["--color-accent-contrast", "--color-accent", 4.5],
  ["--color-accent-contrast", "--color-accent-hover", 4.5],
  ["--color-danger", "--color-surface", 4.5],
  ["--color-danger", "--color-danger-soft", 4.5],
  ["--color-border-strong", "--color-canvas", 3],
  ["--color-border-strong", "--color-surface", 3],
  ["--color-focus", "--color-canvas", 3],
  ["--color-focus", "--color-surface", 3],
];

/** The pairings that fall short, named and measured, so a failure says which and by how much. */
function illegiblePairings(tokens: Tokens): string[] {
  return PAIRINGS.flatMap(([foreground, background, minimum]) => {
    const ratio = contrastRatio(
      rgb(foreground, tokens),
      rgb(background, tokens),
    );

    return ratio >= minimum
      ? []
      : [
          `${foreground} on ${background}: ${ratio.toFixed(2)}:1, short of ${String(minimum)}:1`,
        ];
  });
}

describe("the design system", () => {
  it("defines the same colour tokens in both schemes, so neither is half-finished", () => {
    expect(colorNames(dark)).toEqual(colorNames(light));
  });

  it("derives every accent colour from one hue, so moving the accent is a single edit", () => {
    for (const scheme of [light, dark]) {
      const accents = colorNames(scheme).filter(
        (name) => name.startsWith("--color-accent") || name === "--color-focus",
      );

      expect(accents.length).toBeGreaterThan(0);

      for (const name of accents) {
        expect(scheme[name]).toContain("var(--accent-h)");
      }
    }
  });

  // The Ticket asks for the dark scheme to be checked rather than asserted. These two are the
  // check: every pairing the components render, resolved through the same var() chains a
  // browser resolves, measured against WCAG 2.1.
  it("is legible in the light scheme", () => {
    expect(illegiblePairings(light)).toEqual([]);
  });

  it("is legible in the dark scheme", () => {
    expect(illegiblePairings(dark)).toEqual([]);
  });

  it("renders the faces the root layout loads, and no longer asks for Arial", () => {
    expect(light["--font-sans"]).toContain("var(--font-geist-sans)");
    expect(light["--font-mono"]).toContain("var(--font-geist-mono)");
    expect(css).not.toMatch(/arial/i);
  });
});

// A named colour is as much of a hardcoded colour as a hex triplet is. `transparent` and
// `currentColor` are neither: both take their value from the tokens around them.
const NAMED_COLOR =
  /(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gr[ae]y|silver|navy|teal|olive|maroon|lime|aqua|fuchsia)(?![\w-])/i;
const FUNCTIONAL_COLOR = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX_COLOR = /#[\da-f]{3,8}\b/i;
// The lookahead sits directly after the colon on purpose: `\s*` before it would backtrack to
// zero width and let every `font-size: var(…)` through, which is the whole of what it guards.
const LITERAL_FONT_SIZE = /font-size\s*:(?!\s*var\()/i;
const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g;

/** Prose in a comment may say "black"; a declaration may not. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("component stylesheets", () => {
  let modules: { path: string; declarations: string }[];

  beforeAll(async () => {
    modules = (await readFiles(["app", "lib"], STYLE_EXTENSIONS))
      .filter((file) => file.path.endsWith(".module.css"))
      .map((file) => ({
        path: file.path,
        declarations: stripComments(file.text),
      }));
  });

  it("are all read, so the rules below cannot pass by finding nothing", () => {
    expect(modules.length).toBeGreaterThan(4);
  });

  it("name no colour of their own", () => {
    const offenders = modules
      .filter(
        (file) =>
          HEX_COLOR.test(file.declarations) ||
          FUNCTIONAL_COLOR.test(file.declarations) ||
          NAMED_COLOR.test(file.declarations),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("name no font size of their own", () => {
    const offenders = modules
      .filter((file) => LITERAL_FONT_SIZE.test(file.declarations))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("read only custom properties the design system defines", () => {
    const defined = new Set(Object.keys(light));

    const unknown = modules.flatMap((file) =>
      [...file.declarations.matchAll(VAR_REFERENCE)]
        .map((match) => match[1]!)
        .filter((name) => !defined.has(name))
        .map((name) => `${file.path}: ${name}`),
    );

    expect([...new Set(unknown)]).toEqual([]);
  });
});
