import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const inside = (root, path) => {
  const pathFromRoot = relative(root, path);
  return (
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`)
  );
};

// This is metadata inspection, not a replacement scheduler. Commands, regexes,
// environment values and arbitrary package fields never enter the report.
export function inspectWireit(cwd, script = "dev") {
  const root = realpathSync(cwd);
  const packages = new Map();
  const nodes = new Map();
  const visiting = new Set();
  const issues = [];
  let edges = 0;
  const issue = (task, code) => issues.push({ task, code });
  function readPackage(directory, task) {
    if (packages.has(directory)) return packages.get(directory);
    if (packages.size >= 128) {
      issue(task, "package-limit");
      return;
    }
    packages.set(directory, undefined);
    let pkg;
    try {
      const path = join(directory, "package.json");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) {
        issue(task, "unsupported-package-file");
        return;
      }
      pkg = JSON.parse(readFileSync(path, "utf8"));
      if (!record(pkg)) {
        issue(task, "invalid-package");
        return;
      }
    } catch {
      issue(task, "unreadable-package");
      return;
    }
    packages.set(directory, pkg);
    return pkg;
  }
  function visit(directory, name) {
    // Both components can contain colons; delimiters alone are not identities.
    const id = JSON.stringify([
      relative(root, directory).split(sep).join("/") || ".",
      name,
    ]);
    if (visiting.has(id)) {
      issue(id, "dependency-cycle");
      return id;
    }
    if (nodes.has(id)) return id;
    if (nodes.size >= 256) {
      issue(id, "task-limit");
      return id;
    }
    const pkg = readPackage(directory, id);
    if (!pkg) return id;
    const metadata =
      record(pkg.wireit) && Object.hasOwn(pkg.wireit, name)
        ? pkg.wireit[name]
        : undefined;
    const command =
      record(pkg.scripts) && Object.hasOwn(pkg.scripts, name)
        ? pkg.scripts[name]
        : undefined;
    if (metadata === undefined) {
      if (typeof command !== "string") {
        issue(id, "missing-task");
        return id;
      }
      nodes.set(id, {
        id,
        package: relative(root, directory).split(sep).join("/") || ".",
        script: name,
        kind: "opaque-script",
        command: "[redacted]",
        dependencies: [],
      });
      issue(id, "opaque-script");
      return id;
    }
    if (!record(metadata)) {
      issue(id, "invalid-task");
      return id;
    }
    const longRunning = metadata.service === true || record(metadata.service);
    const node = {
      id,
      package: relative(root, directory).split(sep).join("/") || ".",
      script: name,
      kind: longRunning
        ? "long-running"
        : metadata.command === undefined
          ? "aggregate"
          : "task",
      command: metadata.command === undefined ? null : "[redacted]",
      readiness:
        record(metadata.service) &&
        record(metadata.service.readyWhen) &&
        typeof metadata.service.readyWhen.lineMatches === "string"
          ? "declared-log-pattern"
          : longRunning
            ? "process-start"
            : null,
      envKeys: record(metadata.env) ? Object.keys(metadata.env).sort() : [],
      dependencies: [],
      ...(longRunning ? { listener: "unknown" } : {}),
    };
    nodes.set(id, node);
    visiting.add(id);
    if (
      command !== undefined &&
      (typeof command !== "string" || command.trim() !== "wireit")
    )
      issue(id, "script-binding-not-wireit");
    if (metadata.command !== undefined && typeof metadata.command !== "string")
      issue(id, "invalid-command");
    if (
      metadata.service !== undefined &&
      typeof metadata.service !== "boolean" &&
      !record(metadata.service)
    )
      issue(id, "invalid-service");
    if (metadata.env !== undefined && !record(metadata.env))
      issue(id, "invalid-environment");
    if (
      metadata.dependencies !== undefined &&
      !Array.isArray(metadata.dependencies)
    )
      issue(id, "invalid-dependencies");
    for (const dependency of Array.isArray(metadata.dependencies)
      ? metadata.dependencies
      : []) {
      if (++edges > 2048) {
        issue(id, "dependency-limit");
        break;
      }
      const target =
        typeof dependency === "string"
          ? dependency
          : record(dependency)
            ? dependency.script
            : undefined;
      const cascade =
        record(dependency) && Object.hasOwn(dependency, "cascade")
          ? dependency.cascade
          : true;
      if (
        typeof target !== "string" ||
        !target ||
        typeof cascade !== "boolean"
      ) {
        issue(id, "invalid-dependency");
        continue;
      }
      let destination = directory;
      let taskName = target;
      if (target.startsWith("./") || target.startsWith("../")) {
        const colon = target.indexOf(":");
        if (colon < 0 || !target.slice(colon + 1)) {
          issue(id, "invalid-dependency");
          continue;
        }
        try {
          destination = realpathSync(
            resolve(directory, target.slice(0, colon)),
          );
        } catch {
          issue(id, "missing-dependency-package");
          continue;
        }
        if (!inside(root, destination)) {
          issue(id, "dependency-outside-inspection-root");
          continue;
        }
        taskName = target.slice(colon + 1);
      } else if (target.includes("/") || target.includes("\\")) {
        issue(id, "unsupported-dependency-syntax");
        continue;
      }
      node.dependencies.push({ task: visit(destination, taskName), cascade });
    }
    visiting.delete(id);
    return id;
  }
  const entry = visit(root, script);
  return {
    schemaVersion: 1,
    kind: "wireit-inspection",
    root,
    entry,
    status: issues.length ? "incomplete" : "inspected",
    launch: "requires-explicit-listener-integration",
    tasks: [...nodes.values()],
    issues,
  };
}
