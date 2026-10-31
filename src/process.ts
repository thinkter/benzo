import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
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
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return;
    throw error;
  }
  // A leader may exit while grandchildren remain, so check the group, not PID.
  const deadline = Date.now() + timeout;
  do {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      throw error;
    }
    await delay(40);
  } while (Date.now() < deadline);
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return;
    throw error;
  }
  // Signal delivery is asynchronous. The launcher can already be gone while
  // grandchildren are still exiting. Zombies own no listeners and cannot run;
  // waiting for their parent/init to reap them would make cleanup unbounded.
  const killedDeadline = Date.now() + 5000;
  while (await groupHasRunningProcesses(pid)) {
    if (Date.now() >= killedDeadline)
      throw new Error(`Process group ${pid} did not terminate after SIGKILL.`);
    await delay(20);
  }
}

async function groupHasRunningProcesses(group: number): Promise<boolean> {
  try {
    process.kill(-group, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
  // Without process inspection, keep waiting for ESRCH; never infer success
  // from missing tooling or permission to inspect another process.
  if (process.platform !== "linux") return true;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return true;
  }
  let observedGroup = false;
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ESRCH")
      )
        continue;
      return true;
    }
    // comm is parenthesized and may itself contain spaces or parentheses.
    const end = stat.lastIndexOf(")");
    if (end < 0) return true;
    const [state, , pgid] = stat
      .slice(end + 1)
      .trim()
      .split(/\s+/);
    if (state === undefined || pgid === undefined || !/^\d+$/.test(pgid))
      return true;
    if (Number(pgid) === group) {
      observedGroup = true;
      if (state !== "Z" && state !== "X") return true;
    }
  }
  return !observedGroup;
}
