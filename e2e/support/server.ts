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
 *
 * `maxBuffer` is raised well past `spawnSync`'s 1MB default. On the default, a chatty build —
 * and a cold CI build is far chattier than a warm local one — is killed part-way and comes
 * back as `status: null` with its output truncated, which reads as "the build failed" while
 * naming nothing. `result.error` is reported for the same reason: it is the only place that
 * kind of failure says what actually happened.
 */
export function buildApp(env: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      `next build failed (exit ${String(result.status)}${
        result.error ? `, ${result.error.message}` : ""
      }):\n${result.stdout}\n${result.stderr}`,
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
    child,
    () => output,
  );

  return child;
}

/**
 * Stops the server and waits for the process to actually be gone.
 *
 * `kill()` only delivers the signal; it does not wait. On Linux `next start` handles SIGTERM
 * and drains before exiting, so the process — and every socket it holds open, including the
 * keep-alive connection its middleware made to the Auth stub — outlives the call. A teardown
 * that then closes the stub waits on a connection nobody is going to close, and the suite
 * hangs in `afterAll` rather than failing with anything a log could show. Windows terminates
 * outright on `kill()`, which is why this only ever bites in CI.
 *
 * SIGKILL after a grace period so a server that refuses to drain cannot hold the run either.
 */
export async function stopApp(
  child: ChildProcess,
  graceMs = 5_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  child.kill("SIGTERM");

  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });

  await Promise.race([exited, grace]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }

  clearTimeout(timer);
}

/** Polls `url` until something answers. A 3xx to `/login` counts: it means the server is up. */
async function waitForServer(
  url: string,
  timeoutMs: number,
  child: ChildProcess,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // A server that has already exited is never going to answer. Saying so straight away is
    // the difference between a log that names the reason and one that only says "30s".
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `next start exited before it was ready (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}):\n${describeFailure()}`,
      );
    }

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
