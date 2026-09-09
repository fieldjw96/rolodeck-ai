import { spawn, type ChildProcess } from "node:child_process";
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

/**
 * POSIX and Windows disagree about process trees, and this suite is the one place that
 * disagreement decides whether CI finishes. `next` spawns workers of its own, so the process
 * this file holds a handle to is the root of a tree, not the whole of it. On POSIX a child
 * spawned `detached` leads its own process group and `process.kill(-pid)` reaches every
 * member; Windows has no process groups to signal, but `kill()` there terminates outright
 * rather than asking politely, so the tree does not outlive its root in the first place.
 */
const IS_WINDOWS = process.platform === "win32";

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

/** Accumulates a child's stdout and stderr into one string, for a failure to quote. */
function collectOutput(child: ChildProcess): () => string {
  let output = "";

  const append = (chunk: Buffer) => {
    output += chunk.toString();
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  return () => output;
}

/**
 * Drops this process's ends of the child's stdio pipes.
 *
 * A piped stdout is an active handle in the event loop, and it stays active until every writer
 * closes it — including workers `next` spawned that inherited the same pipe. Leaving them
 * attached is enough on its own to stop a Playwright worker ever exiting after the tests
 * themselves have passed, which is a run that produces no result rather than a failing one.
 */
function releaseStdio(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Signals the child and, on POSIX, everything it spawned.
 *
 * Signalling only the process we hold leaves `next`'s own workers running, still holding the
 * port and the keep-alive socket to the Auth stub. `-pid` addresses the whole process group,
 * which exists only because `startApp` and `buildApp` spawn `detached`.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;

  if (pid === undefined) {
    return;
  }

  try {
    process.kill(IS_WINDOWS ? pid : -pid, signal);
  } catch {
    // ESRCH: the process is already gone, which is the outcome being asked for anyway.
  }
}

/**
 * Runs `next build` to completion. Nothing else this suite does is useful before a build
 * either succeeds or names why it failed.
 *
 * Asynchronous on purpose. `spawnSync` blocks the calling thread outright, and this call sits
 * inside a Playwright hook: for the whole of a cold CI build — minutes, not seconds — the
 * worker could not fire its own timers or answer the runner's IPC, so a build that went slow
 * was indistinguishable to Playwright from a worker that had died, and the run ended with no
 * result to report rather than a failure to read. Awaiting the child keeps the event loop
 * live, which is what lets the timeout below be reported as itself.
 */
export async function buildApp(
  env: NodeJS.ProcessEnv,
  timeoutMs = 8 * 60 * 1000,
): Promise<void> {
  const child = spawn(process.execPath, [NEXT_BIN, "build"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !IS_WINDOWS,
  });

  const describe = collectOutput(child);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalTree(child, "SIGKILL");
  }, timeoutMs);

  // `close` rather than `exit`: it fires once the pipes are drained, so the output quoted in a
  // failure is the whole of it and not whatever had arrived by the time the process went.
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    child.once("error", (error: Error) => {
      resolve({ code: null, signal: null, error });
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  clearTimeout(timer);
  releaseStdio(child);

  if (timedOut) {
    throw new Error(
      `next build did not finish within ${String(timeoutMs)}ms:\n${describe()}`,
    );
  }

  if (result.code !== 0) {
    throw new Error(
      `next build failed (exit ${String(result.code)}, signal ${String(
        result.signal,
      )}${result.error ? `, ${result.error.message}` : ""}):\n${describe()}`,
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
      // So that `stopApp` can reach the render workers `next` spawns, not just their parent.
      detached: !IS_WINDOWS,
    },
  );

  const describe = collectOutput(child);

  await waitForServer(
    `http://127.0.0.1:${String(port)}/login`,
    30_000,
    child,
    describe,
  );

  return child;
}

/**
 * Stops the server, everything it spawned, and this process's pipes to all of them.
 *
 * `kill()` only delivers the signal; it does not wait. On Linux `next start` handles SIGTERM
 * and drains before exiting, so the process — and every socket it holds open, including the
 * keep-alive connection its middleware made to the Auth stub — outlives the call. A teardown
 * that then closes the stub waits on a connection nobody is going to close, and the suite
 * hangs in `afterAll` rather than failing with anything a log could show. Windows terminates
 * outright on `kill()`, which is why this only ever bites in CI.
 *
 * SIGKILL after a grace period so a server that refuses to drain cannot hold the run either,
 * and `releaseStdio` last so a surviving grandchild cannot keep the run alive through a pipe.
 */
export async function stopApp(
  child: ChildProcess,
  graceMs = 5_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    releaseStdio(child);
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  signalTree(child, "SIGTERM");

  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });

  await Promise.race([exited, grace]);
  clearTimeout(timer);

  if (child.exitCode === null && child.signalCode === null) {
    signalTree(child, "SIGKILL");
    // Raced, not awaited outright: a child that never spawned has no pid to signal and will
    // never emit `exit`, and teardown is not the place to find that out by waiting forever.
    await Promise.race([exited, delay(graceMs)]);
  }

  releaseStdio(child);
}

/** A promise that resolves after `ms`, without leaving a timer holding the event loop open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
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
