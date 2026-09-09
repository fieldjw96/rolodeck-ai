import { decodeEntities } from "./entities";

/**
 * Just enough XML to read an SEC Form D, and no more.
 *
 * An EDGAR `primary_doc.xml` is a small, namespace-free document of nested elements holding
 * either text or other elements, so what this produces is the plain nested record that shape
 * maps onto — ready for a Zod schema to say which of its fields are actually required, which
 * is where the real boundary lives. Per CLAUDE.md the input is hostile, so every structural
 * problem throws here rather than being papered over: an unclosed element, a mismatched
 * closing tag, or text loose outside the root all stop the document instead of yielding a
 * half-read one.
 *
 * An element with children becomes a record; an element with none becomes its decoded, trimmed
 * text. Repeated siblings become an array, so a document that starts carrying two of something
 * arrives as an array where a schema expected a string and fails there, by name.
 */

export type XmlValue = string | XmlRecord | readonly XmlValue[];

export type XmlRecord = { readonly [tag: string]: XmlValue };

export type XmlDocument = {
  /** The root element's name, checked by callers that care which document they were handed. */
  readonly root: string;
  readonly content: XmlValue;
};

type Frame = {
  readonly name: string;
  readonly children: Map<string, XmlValue[]>;
  readonly text: string[];
};

/** The end of a start tag, skipping any `>` inside a quoted attribute value. */
function endOfTag(source: string, from: number): number {
  let quote: string | undefined;

  for (let index = from; index < source.length; index += 1) {
    const character = source[index]!;

    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }

  return -1;
}

function frameValue(frame: Frame): XmlValue {
  if (frame.children.size === 0) {
    return decodeEntities(frame.text.join("")).trim();
  }

  const record: Record<string, XmlValue> = {};

  for (const [name, values] of frame.children) {
    record[name] = values.length === 1 ? values[0]! : values;
  }

  return record;
}

export function parseXml(source: string): XmlDocument {
  const stack: Frame[] = [];
  let document: XmlDocument | undefined;
  let index = 0;

  const open = (name: string): void => {
    if (stack.length === 0 && document !== undefined) {
      throw new Error(`a second root element <${name}>`);
    }
    stack.push({ name, children: new Map(), text: [] });
  };

  const close = (frame: Frame): void => {
    const parent = stack[stack.length - 1];

    if (parent === undefined) {
      document = { root: frame.name, content: frameValue(frame) };
      return;
    }

    const siblings = parent.children.get(frame.name);
    const value = frameValue(frame);

    if (siblings === undefined) {
      parent.children.set(frame.name, [value]);
    } else {
      siblings.push(value);
    }
  };

  while (index < source.length) {
    const start = source.indexOf("<", index);

    if (start === -1) {
      break;
    }

    if (start > index) {
      const text = source.slice(index, start);
      const frame = stack[stack.length - 1];

      if (frame !== undefined) {
        frame.text.push(text);
      } else if (text.trim() !== "") {
        throw new Error("text outside the root element");
      }
    }

    // A prolog, comment or doctype: skipped whole. CDATA is content, and is kept.
    if (source.startsWith("<![CDATA[", start)) {
      const end = source.indexOf("]]>", start);
      if (end === -1) throw new Error("an unterminated CDATA section");
      stack[stack.length - 1]?.text.push(source.slice(start + 9, end));
      index = end + 3;
      continue;
    }

    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start);
      if (end === -1) throw new Error("an unterminated comment");
      index = end + 3;
      continue;
    }

    if (source.startsWith("<?", start) || source.startsWith("<!", start)) {
      const end = endOfTag(source, start);
      if (end === -1) throw new Error("an unterminated prolog or doctype");
      index = end + 1;
      continue;
    }

    const end = endOfTag(source, start);

    if (end === -1) {
      throw new Error("an unterminated tag");
    }

    if (source.startsWith("</", start)) {
      const name = source.slice(start + 2, end).trim();
      const frame = stack.pop();

      if (frame === undefined || frame.name !== name) {
        throw new Error(`an unexpected closing tag </${name}>`);
      }

      close(frame);
      index = end + 1;
      continue;
    }

    const selfClosing = source[end - 1] === "/";
    const inner = source.slice(start + 1, selfClosing ? end - 1 : end);
    const name = /^[^\s/>]+/.exec(inner)?.[0];

    if (name === undefined) {
      throw new Error("a tag with no name");
    }

    open(name);

    if (selfClosing) {
      close(stack.pop()!);
    }

    index = end + 1;
  }

  if (stack.length > 0) {
    throw new Error(`an unclosed element <${stack[stack.length - 1]!.name}>`);
  }

  if (document === undefined) {
    throw new Error("no root element");
  }

  return document;
}
