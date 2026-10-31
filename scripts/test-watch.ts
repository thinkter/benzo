import { watch, statSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stop } from "#production/process";
import type { ChildProcess } from "node:child_process";

export function watchTests(options: {
  cwd: string;
  command: string;
  args: string[];
  paths: string[];
  report?: (message: string) => void;
}): { close(): Promise<void> } {
  const report = options.report ?? console.log;
  const watchers: FSWatcher[] = [];
  let child: ChildProcess | undefined;
  let dirty = true;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;

  function run(): void {
    if (closed || child || !dirty) return;
    dirty = false;
    report("Rebuilding and testing current sources…");
    const active = launch(
      options.command,
      options.args,
      options.cwd,
      process.env,
      { stdio: "inherit" },
    );
    child = active;
    let finished = false;
    function finish(code: number | null): void {
      if (finished) return;
      finished = true;
      child = undefined;
      if (closed) return;
      if (dirty) {
        report("Sources changed during this run; its result is superseded.");
        schedule();
      } else {
        report(
          code === 0
            ? "Current sources passed. Watching for edits."
            : "Build or tests failed. Watching for a correction; stale output is not rerun.",
        );
      }
    }
    active.once("error", (error: Error) => {
      report(error.message);
      finish(1);
    });
    active.once("exit", (code) => finish(code));
  }
  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(run, 100);
  }
  function changed(): void {
    if (closed) return;
    dirty = true;
    report("Source edit detected; previous results are no longer current.");
    schedule();
  }
  function close(): Promise<void> {
    return (closing ??= (async () => {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      const active = child;
      const exited =
        active &&
        active.pid !== undefined &&
        active.exitCode === null &&
        active.signalCode === null
          ? new Promise<void>((resolveExit) =>
              active.once("exit", () => resolveExit()),
            )
          : Promise.resolve();
      await stop(active);
      await exited;
    })());
  }
  async function closeAndReport(): Promise<void> {
    try {
      await close();
    } catch (error) {
      process.exitCode = 1;
      report(
        error instanceof Error ? error.message : "Watcher cleanup failed.",
      );
    }
  }
  try {
    for (const path of options.paths) {
      const target = join(options.cwd, path);
      const directory = statSync(target).isDirectory();
      const watcher = directory
        ? watch(target, { recursive: true }, changed)
        : watch(dirname(target), (_event, filename) => {
            if (filename === null || filename.toString() === basename(target))
              changed();
          });
      watcher.on("error", (error: Error) => {
        report(`Watch failed: ${error.message}`);
        process.exitCode = 1;
        void closeAndReport();
      });
      watchers.push(watcher);
    }
    run();
  } catch (error) {
    void closeAndReport();
    throw error;
  }
  return { close };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const npm = process.env["npm_execpath"];
  if (!npm)
    throw new Error(
      "Start the watcher with npm run test:watch or pnpm test:watch.",
    );
  const watcher = watchTests({
    cwd: process.cwd(),
    command: process.execPath,
    args: [npm, "test"],
    paths: [
      "src",
      "test",
      "scripts",
      "compatibility",
      "package.json",
      "tsconfig.json",
      "tsconfig.tests.json",
      "tsconfig.consumer.json",
      "tsconfig.tools.json",
    ],
  });
  const shutdown = (code: number): void => {
    process.exitCode = code;
    void (async () => {
      try {
        await watcher.close();
      } catch (error) {
        process.exitCode = 1;
        console.error(
          error instanceof Error ? error.message : "Watcher cleanup failed.",
        );
      }
    })();
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
}
