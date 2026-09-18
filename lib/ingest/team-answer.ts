import { z } from "zod";

import { founderSchema, type Founder } from "../../db/profile-input";
import { issueField } from "../zod/issues";

/**
 * The boundary a model's reading of a team page crosses before any of it can become a Founder.
 * See docs/adr/0016.
 *
 * Every other parser in `lib/ingest` is deterministic and pinned by a committed capture. This
 * one's input is a model's answer, which no fixture can pin, so it is treated as what it is:
 * hostile external input like any scraped page. It must be strict JSON, it must match
 * `teamAnswerSchema` exactly, and then one deterministic check a fixture *can* pin decides what
 * survives: a person whose full name does not appear verbatim in the page text the model was
 * given is not a person that page stated, and is dropped. That check is what stands between
 * this path and a card full of plausible invented people.
 */

const MAX_NAME_LENGTH = 200;
const MAX_ROLE_LENGTH = 200;
const MAX_BIO_LENGTH = 2_000;

/** Well past any real founding team; a longer list is a page of staff, or a model gone wrong. */
const MAX_PEOPLE = 20;

const statedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, {
      message: "must not be blank",
    });

/**
 * What the model is asked to write, and all it may write. Strict at every level, so a model
 * that volunteers an email address, a photo or a LinkedIn URL is refused rather than having the
 * extra quietly dropped: the shape `founders` holds, from #169, does not grow here. An empty
 * list is the honest answer for a page that names nobody.
 */
export const teamAnswerSchema = z.strictObject({
  founders: z
    .array(
      z.strictObject({
        name: statedText(MAX_NAME_LENGTH),
        role: statedText(MAX_ROLE_LENGTH).optional(),
        bio: statedText(MAX_BIO_LENGTH).optional(),
      }),
    )
    .max(MAX_PEOPLE),
});

export type TeamAnswerRejection = {
  readonly field: string;
  readonly reason: string;
};

export type TeamAnswerResult =
  | {
      readonly success: true;
      /** Every person who survived the verbatim check, in the order the model gave them. */
      readonly founders: readonly Founder[];
      /** The names the model returned that the page never states. */
      readonly dropped: readonly string[];
    }
  | { readonly success: false; readonly rejection: TeamAnswerRejection };

/**
 * One run of whitespace, of any kind, as one space. Applied to both the name and the page, so
 * a name the page breaks across two lines, or spaces with `&nbsp;`, still counts as stated,
 * while a name whose letters differ at all does not.
 */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Whether `name` appears, whole and verbatim, in `pageText`. Case-sensitive: "verbatim" is the
 * test, and a page that writes a name in capitals via CSS still carries it in its own case.
 */
export function pageStates(pageText: string, name: string): boolean {
  const needle = collapse(name);
  const haystack = collapse(pageText);

  if (needle.length === 0) {
    return false;
  }

  // Whole, not merely contained: "Jo Lohs" inside "Jo Lohse" is a different person's name, so
  // an occurrence counts only where neither neighbour continues a word.
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    const before = haystack.slice(0, at).at(-1) ?? "";
    const after = haystack.at(at + needle.length) ?? "";

    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) {
      return true;
    }
  }

  return false;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

/**
 * Parses what the model wrote for one company against the page text it was shown.
 *
 * Text that is not JSON, or JSON that does not match `teamAnswerSchema`, is a rejection naming
 * what failed, and costs that one company. Otherwise every person whose name the page does not
 * state is dropped and named in `dropped`, and a name the model gave twice is kept once.
 */
export function parseTeamAnswer(
  answer: string,
  pageText: string,
): TeamAnswerResult {
  let json: unknown;
  try {
    json = JSON.parse(answer);
  } catch (error) {
    return {
      success: false,
      rejection: {
        field: "(answer)",
        reason: `is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const parsed = teamAnswerSchema.safeParse(json);

  if (!parsed.success) {
    // A failed safeParse always carries at least one issue.
    const issue = parsed.error.issues[0]!;
    return {
      success: false,
      rejection: { field: issueField(issue), reason: issue.message },
    };
  }

  const founders: Founder[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const person of parsed.data.founders) {
    const name = collapse(person.name);

    if (!pageStates(pageText, name)) {
      dropped.push(name);
      continue;
    }

    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    // Through the shape `founders` already holds, so nothing reaches the column that the
    // Source-written path could not have written.
    founders.push(
      founderSchema.parse({
        name,
        ...(person.role === undefined ? {} : { role: collapse(person.role) }),
        ...(person.bio === undefined ? {} : { bio: collapse(person.bio) }),
      }),
    );
  }

  return { success: true, founders, dropped };
}
