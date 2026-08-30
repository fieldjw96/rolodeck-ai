import { defineConfig } from "drizzle-kit";

/**
 * `db:generate` needs no database; `db:migrate` needs DATABASE_URL, which CI points at a
 * scratch Postgres. The empty fallback keeps `drizzle-kit generate` usable without one.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  // `anon`, `authenticated` and friends are created by Supabase, not by our migrations.
  entities: { roles: { provider: "supabase" } },
});
