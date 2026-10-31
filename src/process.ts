import type { ChildProcess, SpawnOptions } from "node:child_process";
import crossSpawn from "cross-spawn";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Applications keep their normal environment. Filtering is explicit and never
// changes the source object; environment values are never written to state.
export function safeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
  { exclude = [] }: { exclude?: string[] } = {},
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => !exclude.includes(key)),
    ),
    ...additions,
  };
}
export function launch(
  command: string,
  args: string[] = [],
  cwd: string = process.cwd(),
  env = process.env,
  options: SpawnOptions = {},
): ChildProcess {
  const paths = [];
  let directory = resolve(cwd);
  for (;;) {
    paths.push(join(directory, "node_modules", ".bin"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return crossSpawn(command === "node" ? process.execPath : command, args, {
    cwd,
    env: { ...env, [pathKey]: [...paths, env[pathKey] ?? ""].join(delimiter) },
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}
export async function stop(
  child: ChildProcess | number | undefined,
  { timeout = 1500 }: { timeout?: number } = {},
): Promise<void> {
  const pid = typeof child === "number" ? child : child?.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // There is no process-group termination API in Node on Windows. Use the OS
    // tree terminator via argv, with no shell or user command interpolation.
    await new Promise((resolveStop) => {
      const killer = crossSpawn(
        "taskkill.exe",
        ["/pid", String(pid), "/t", "/f"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", resolveStop);
      killer.once("exit", resolveStop);
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  // A leader may exit while grandchildren remain, so check the group, not PID.
  const deadline = Date.now() + timeout;
  do {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await delay(40);
  } while (Date.now() < deadline);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}
