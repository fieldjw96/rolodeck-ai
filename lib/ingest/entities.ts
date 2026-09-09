/**
 * Decoding the character entities the Sources' own escapers emit.
 *
 * Shared by both Source parsers because both need it and both would get it subtly wrong on
 * their own: a YC company page carries its Inertia payload HTML-escaped inside an attribute,
 * and an SEC Form D escapes `&`, `<` and `"` inside element text. The five XML predefined
 * entities are a subset of HTML's named ones, so one table serves both.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * Decodes named and numeric entities in a single pass. The pass matters: unescaping `&amp;`
 * first would turn a literal `&amp;quot;` in a company's own description into a quote
 * character and corrupt the JSON or markup around it.
 *
 * An entity this does not recognise, or a numeric one outside Unicode, is left as written
 * rather than thrown on — a parser whose job is to reject loudly must still reach the point
 * where it can say which field was wrong.
 */
export function decodeEntities(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      if (!entity.startsWith("#")) {
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
      }

      const hex = entity.startsWith("#x") || entity.startsWith("#X");
      const code = Number.parseInt(
        hex ? entity.slice(2) : entity.slice(1),
        hex ? 16 : 10,
      );

      return Number.isInteger(code) && code >= 0 && code <= MAX_CODE_POINT
        ? String.fromCodePoint(code)
        : match;
    },
  );
}
