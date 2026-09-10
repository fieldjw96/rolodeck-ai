import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Vitest runs with the project root as the working directory. `import.meta.url` would be more
// direct, but it is an http URL under the jsdom environment these checks also run in.
const REPO_ROOT = process.cwd();

export type SourceFile = {
  /** Repo-relative and slash-separated, so assertions read the same on Windows and Linux. */
  path: string;
  text: string;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

/** Every stylesheet is a CSS Module bar `app/globals.css`, which holds the design tokens. */
export const STYLE_EXTENSIONS = [".css"];

async function filesUnder(
  root: string,
  extensions: string[],
): Promise<string[]> {
  const wanted = new Set(extensions);

  const entries = await readdir(path.join(REPO_ROOT, root), {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && wanted.has(path.extname(entry.name)))
    .map((entry) =>
      path
        .relative(REPO_ROOT, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    );
}

/**
 * Every TypeScript source under the given roots, plus any individually named files. Reading
 * the tree rather than a hand-kept list is the point: a rule about "no client component
 * imports the server client" is only worth having if a file added tomorrow is covered too.
 */
export async function readSourceFiles(
  roots: string[],
  extraFiles: string[] = [],
): Promise<SourceFile[]> {
  return readFiles(roots, SOURCE_EXTENSIONS, extraFiles);
}

/**
 * The same tree walk for any extension. The design-system checks in `app/design-system.test.ts`
 * ask it for `.css`, on the same reasoning: a rule about "no stylesheet names its own colour"
 * only holds if a stylesheet added tomorrow is read too.
 */
export async function readFiles(
  roots: string[],
  extensions: string[],
  extraFiles: string[] = [],
): Promise<SourceFile[]> {
  const paths = [
    ...(
      await Promise.all(roots.map((root) => filesUnder(root, extensions)))
    ).flat(),
    ...extraFiles,
  ];

  return Promise.all(
    paths.map(async (file) => ({
      path: file,
      text: await readFile(path.join(REPO_ROOT, file), "utf8"),
    })),
  );
}

/**
 * True when a file opts into the client bundle. React only honours the directive as the first
 * statement in the module, so a `"use client"` string further down does not count — and
 * neither should it here, or the check would be trivially fooled by a comment.
 */
export function declaresUseClient(text: string): boolean {
  const withoutLeadingComments = text
    .replace(/^﻿/, "")
    .replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");

  return /^(["'])use client\1\s*;?/.test(withoutLeadingComments);
}

// Covers `from "x"`, a bare `import "x"`, `import("x")` and `require("x")`. A bare import is
// the form `server-only` is used in, so missing it would quietly gut the marker check.
const IMPORT_PATTERN = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

/** The module specifiers a file imports, in source order. */
export function importSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_PATTERN)].map((match) => match[1]!);
}

/**
 * A relative import as a repo-relative path with no extension, so it can be compared against
 * module paths like `lib/supabase/admin`. Bare package specifiers resolve to null.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const resolved = path.posix
    .normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    .replace(/\.(?:ts|tsx|mts)$/, "");

  return resolved;
}
