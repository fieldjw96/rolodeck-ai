import type { z } from "zod";

/**
 * The environment is external input like any other, so it is parsed rather than trusted, and
 * a missing or malformed variable fails loudly naming itself instead of surfacing later as an
 * unexplained 401 or a refused connection.
 *
 * Only the variable's name and what is wrong with it are reported, never its value: several of
 * these carry a password, and the message ends up in a terminal or a CI log.
 */
export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
  subject: string,
): z.infer<Schema> {
  const result = schema.safeParse(raw);

  if (result.success) {
    return result.data;
  }

  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  throw new Error(`${subject} is not configured — ${detail}`);
}
