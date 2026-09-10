/**
 * Just enough CSS to check the design system from a test: pull the custom properties out of a
 * `:root` block, resolve the `var()` chains between them, and turn what comes out into sRGB so
 * a contrast ratio can be computed. Used by `app/design-system.test.ts`, which is how the dark
 * scheme is checked rather than asserted.
 */

export type Rgb = { r: number; g: number; b: number };

/** The custom properties of one block, by name, with their values exactly as written. */
export type Tokens = Record<string, string>;

/**
 * The text between the first `{` at or after `from` and the `}` that closes it. Brace counting
 * rather than a regex, because the dark scheme's `:root` is nested inside an `@media` block and
 * a lazy `[^}]*` would stop at the wrong brace.
 */
function blockAt(css: string, from: number): string {
  const open = css.indexOf("{", from);

  if (open === -1) {
    throw new Error(`no block found after offset ${String(from)}`);
  }

  let depth = 0;

  for (let index = open; index < css.length; index += 1) {
    const character = css[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return css.slice(open + 1, index);
      }
    }
  }

  throw new Error(`unclosed block starting at offset ${String(open)}`);
}

const DECLARATION = /(--[\w-]+)\s*:\s*([^;}]+)/g;

function declarations(block: string): Tokens {
  return Object.fromEntries(
    [...block.matchAll(DECLARATION)].map(([, name, value]) => [
      name!,
      value!.trim(),
    ]),
  );
}

/** The custom properties of the first `:root` block at or after `from`. */
export function rootTokens(css: string, from = 0): Tokens {
  const root = css.indexOf(":root", from);

  if (root === -1) {
    throw new Error(":root block not found");
  }

  return declarations(blockAt(css, root));
}

/** The custom properties of the `:root` inside the `prefers-color-scheme: dark` block. */
export function darkSchemeTokens(css: string): Tokens {
  const media = css.indexOf("@media (prefers-color-scheme: dark)");

  if (media === -1) {
    throw new Error("no prefers-color-scheme: dark block");
  }

  return rootTokens(css, media);
}

const VAR_REFERENCE = /var\(\s*(--[\w-]+)\s*\)/;

/**
 * A token's value with every `var()` reference substituted. `tokens` is looked at first and
 * `inherited` second, so the dark scheme resolves against its own overrides while still seeing
 * the scheme-independent values — the accent hue — declared once in the light block.
 */
export function resolve(
  value: string,
  tokens: Tokens,
  inherited: Tokens = {},
): string {
  let resolved = value;

  for (let pass = 0; pass < 10; pass += 1) {
    const match = VAR_REFERENCE.exec(resolved);

    if (match === null) {
      return resolved;
    }

    const name = match[1]!;
    const replacement = tokens[name] ?? inherited[name];

    if (replacement === undefined) {
      throw new Error(`${name} is referenced but never defined`);
    }

    resolved = resolved.replace(match[0], replacement);
  }

  throw new Error(`var() references in "${value}" nest more than 10 deep`);
}

const HSL = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/;
const HEX = /^#([\da-f]{6})$/i;

/**
 * A fully resolved colour as sRGB, or null when it carries an alpha channel — a translucent
 * shadow has no contrast ratio to check, so those are skipped rather than guessed at.
 */
export function toRgb(value: string): Rgb | null {
  const hsl = HSL.exec(value);

  if (hsl !== null) {
    return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  }

  const hex = HEX.exec(value);

  if (hex !== null) {
    const digits = hex[1]!;
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
    };
  }

  return null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = saturation * Math.min(lightness, 1 - lightness);

  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return (
      lightness - chroma * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    );
  };

  return {
    r: Math.round(channel(0) * 255),
    g: Math.round(channel(8) * 255),
    b: Math.round(channel(4) * 255),
  };
}

/** WCAG 2.1 relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  }) as [number, number, number];

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.1 contrast ratio, between 1 and 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
