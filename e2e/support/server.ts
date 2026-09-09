import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const NEXT_BIN = path.join(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);

/** An unused localhost port, so a stray `next dev` on 3000 cannot collide with this run. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }

      server.close(() => resolve(address.port));
    });
  });
}

/**
 * Runs `next build` to completion. Synchronous on purpose: nothing else this suite does is
 * useful before a build either succeeds or names why it failed.
 */
export function buildApp(env: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `next build failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/** Starts `next start` on `port` and resolves once it is accepting connections. */
export async function startApp(
  env: NodeJS.ProcessEnv,
  port: number,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "-p", String(port)],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  await waitForServer(
    `http://127.0.0.1:${String(port)}/login`,
    30_000,
    () => output,
  );

  return child;
}

/** Polls `url` until something answers. A 3xx to `/login` counts: it means the server is up. */
async function waitForServer(
  url: string,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(
    `next start did not become ready at ${url} within ${String(timeoutMs)}ms:\n${describeFailure()}`,
  );
}
