import { z } from "zod";

/**
 * Supabase's URL and its publishable key. Both are browser-safe by design: the publishable
 * key identifies the project and nothing more, and every query it makes is still subject to
 * RLS. These are the only Supabase values allowed to reach a client bundle.
 */
const browserSafeSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

/**
 * The secret key, which bypasses RLS completely. Per CLAUDE.md it belongs to the ingest and
 * provisioning paths that run on the server laptop, and never to anything a browser reaches.
 * Deliberately not `NEXT_PUBLIC_`, so Next cannot inline it into a bundle even by mistake.
 */
const secretSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
});

/**
 * The Postgres connection string the app's own queries go through. It carries a password, so
 * like the secret key it is deliberately not `NEXT_PUBLIC_`. Unlike the secret key it grants
 * no RLS bypass on its own: every query made with it runs inside `asUser()`, which drops to
 * the `authenticated` role for the length of a transaction. See `db/connection.ts`.
 */
const databaseSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type SupabaseBrowserSafeEnv = z.infer<typeof browserSafeSchema>;

/**
 * The environment is external input like any other, so it is parsed rather than trusted, and
 * a missing or malformed variable fails loudly naming itself instead of surfacing later as an
 * unexplained 401 from Supabase.
 */
function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(raw);

  if (result.success) {
    return result.data;
  }

  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  throw new Error(`Supabase environment is not configured — ${detail}`);
}

/**
 * Read on every call rather than once at module scope: `next build` imports these modules
 * with no Supabase credentials present, and a top-level parse would turn a missing variable
 * into a failed build rather than a failed request.
 */
export function readBrowserSafeEnv(): SupabaseBrowserSafeEnv {
  // Spelled out as literal member accesses because that is the only form Next replaces with
  // the value at build time; `process.env[name]` would be `undefined` in a client bundle.
  return parseEnv(browserSafeSchema, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

export function readSecretKey(): string {
  return parseEnv(secretSchema, {
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  }).SUPABASE_SECRET_KEY;
}

export function readDatabaseUrl(): string {
  return parseEnv(databaseSchema, {
    DATABASE_URL: process.env.DATABASE_URL,
  }).DATABASE_URL;
}
