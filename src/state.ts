import type { JsonObject, JsonValue } from "./types.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
export const canonicalPath = (cwd: string): string => realpathSync(cwd);
export function homeDirectory() {
  return resolve(process.env.BENZO_HOME ?? join(homedir(), ".cache", "benzo"));
}
export function stateDirectory(cwd: string): string {
  const directory = join(
    homeDirectory(),
    "worktrees",
    hash(canonicalPath(cwd)),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function projectIdentity(cwd: string): string {
  let directory = canonicalPath(cwd);
  for (;;) {
    const git = join(directory, ".git");
    if (existsSync(git)) {
      let gitDirectory = git;
      try {
        const text = readFileSync(git, "utf8");
        if (text.startsWith("gitdir:"))
          gitDirectory = resolve(directory, text.slice(7).trim());
      } catch {}
      const common = join(gitDirectory, "commondir");
      return hash(
        existsSync(common)
          ? canonicalPath(
              resolve(gitDirectory, readFileSync(common, "utf8").trim()),
            )
          : canonicalPath(gitDirectory),
      );
    }
    const parent = dirname(directory);
    if (parent === directory) return hash(canonicalPath(cwd));
    directory = parent;
  }
}
export function readJson(path: string): JsonObject | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Invalid Benzo state at ${path}. Run benzo doctor.`);
  }
}
export function atomicJson(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
export function readState(cwd: string): JsonObject | undefined {
  return readJson(join(stateDirectory(cwd), "state.json"));
}
export function writeState(cwd: string, state: JsonValue): void {
  atomicJson(join(stateDirectory(cwd), "state.json"), state);
}
export function removeState(cwd: string): void {
  rmSync(join(stateDirectory(cwd), "state.json"), { force: true });
}
export function readPreferences(cwd: string): JsonObject | undefined {
  return readJson(join(stateDirectory(cwd), "preferences.json"));
}
export function writePreferences(cwd: string, preferences: JsonValue): void {
  atomicJson(join(stateDirectory(cwd), "preferences.json"), preferences);
}

export function readLastState(cwd: string): JsonObject | undefined {
  return readJson(join(stateDirectory(cwd), "last.json"));
}
export function writeLastState(cwd: string, state: JsonValue): void {
  atomicJson(join(stateDirectory(cwd), "last.json"), state);
}
