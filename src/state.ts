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

export const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
export const canonicalPath = (cwd) => realpathSync(cwd);
export function homeDirectory() {
  return resolve(process.env.BENZO_HOME ?? join(homedir(), ".cache", "benzo"));
}
export function stateDirectory(cwd) {
  const directory = join(
    homeDirectory(),
    "worktrees",
    hash(canonicalPath(cwd)),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function projectIdentity(cwd) {
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
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Invalid Benzo state at ${path}. Run benzo doctor.`);
  }
}
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
export function readState(cwd) {
  return readJson(join(stateDirectory(cwd), "state.json"));
}
export function writeState(cwd, state) {
  atomicJson(join(stateDirectory(cwd), "state.json"), state);
}
export function removeState(cwd) {
  rmSync(join(stateDirectory(cwd), "state.json"), { force: true });
}
export function readPreferences(cwd) {
  return readJson(join(stateDirectory(cwd), "preferences.json"));
}
export function writePreferences(cwd, preferences) {
  atomicJson(join(stateDirectory(cwd), "preferences.json"), preferences);
}

export function readLastState(cwd) {
  return readJson(join(stateDirectory(cwd), "last.json"));
}
export function writeLastState(cwd, state) {
  atomicJson(join(stateDirectory(cwd), "last.json"), state);
}
