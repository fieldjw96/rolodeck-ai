import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

/**
 * The key Turbopack's RSC client-reference manifest uses for `/deck`'s route entry. It comes
 * from the app directory's own path (`app/(app)/deck/page.tsx`), not from anything
 * machine-specific, so it is stable across a Windows checkout and the Linux CI runner alike.
 */
const DECK_ENTRY_KEY = "[project]/app/(app)/deck/page";

type BuildManifest = {
  polyfillFiles: string[];
  rootMainFiles: string[];
};

type RscManifest = {
  entryJSFiles?: Record<string, string[]>;
};

/**
 * `page_client-reference-manifest.js` is not JSON: it is a script that assigns one manifest
 * object onto `globalThis.__RSC_MANIFEST`. The object literal itself is plain JSON, so pulling
 * it out with a regex and parsing that is enough — no need to execute the file to read it.
 */
function readRscManifest(nextDir: string): RscManifest {
  const file = path.join(
    nextDir,
    "server/app/(app)/deck/page_client-reference-manifest.js",
  );
  const text = readFileSync(file, "utf8");
  const match =
    /globalThis\.__RSC_MANIFEST\["\/\(app\)\/deck\/page"\] = (\{[\s\S]*\});/.exec(
      text,
    );
  const json = match?.[1];

  if (json === undefined) {
    throw new Error(`could not find the /deck RSC client manifest in ${file}`);
  }

  return JSON.parse(json) as RscManifest;
}

/**
 * Every client-side JS file a browser fetches to render `/deck`: the polyfill and framework
 * runtime every page loads (`build-manifest.json`'s `polyfillFiles` and `rootMainFiles`), plus
 * the chunks Turbopack attributes to `/deck`'s own route entry. Reading this from the build
 * output rather than guessing file names is what makes the check survive a chunk hash
 * changing on the next build.
 */
export function deckClientJsFiles(nextDir: string): string[] {
  const buildManifest = JSON.parse(
    readFileSync(path.join(nextDir, "build-manifest.json"), "utf8"),
  ) as BuildManifest;

  const entryFiles = readRscManifest(nextDir).entryJSFiles?.[DECK_ENTRY_KEY];

  if (entryFiles === undefined) {
    throw new Error(
      `the RSC manifest has no entryJSFiles for ${DECK_ENTRY_KEY}`,
    );
  }

  return [
    ...new Set([
      ...buildManifest.polyfillFiles,
      ...buildManifest.rootMainFiles,
      ...entryFiles,
    ]),
  ];
}

/** The total size, gzipped, of every JS file `/deck` ships to a browser. */
export function deckClientBundleGzipBytes(nextDir: string): number {
  return deckClientJsFiles(nextDir).reduce((total, file) => {
    const buffer = readFileSync(path.join(nextDir, file));
    return total + gzipSync(buffer, { level: 9 }).length;
  }, 0);
}
