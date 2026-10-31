import type {
  ManifestInput,
  NormalizedManifest,
  PackageJson,
} from "./types.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonObject } from "./wire.js";
import { unwrapPortless } from "./portless.js";
import { associatedManifest } from "./association.js";
import { validateManifestShape } from "./manifest.js";
export { manifestDiagnostics } from "./manifest.js";

export const DEFAULT_MANIFEST: NormalizedManifest = {
  schemaVersion: 1,
  gateway: { port: 3000, controlPort: 2999, host: "127.0.0.1" },
  worktree: { slots: 100, firstPort: 10000, stride: 32 },
  backend: { mode: "external" },
  auth: { mode: "pass-through" },
  services: [],
};
const label = /^[a-z][a-z0-9-]{0,49}$/;
const port = (value: number | undefined): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value > 0 &&
  value <= 65535;
export function validateManifest(config: ManifestInput): void {
  validateManifestShape(config);
  if (
    !config ||
    typeof config !== "object" ||
    !Array.isArray(config.services) ||
    !config.services.length
  )
    throw new Error("At least one development service is required.");
  const names = new Set<string>();
  for (const service of config.services) {
    if (
      typeof service.name !== "string" ||
      !label.test(service.name) ||
      names.has(service.name)
    )
      throw new Error(`Invalid or duplicate service name: ${service.name}`);
    names.add(service.name);
    if (
      typeof service.command !== "string" ||
      !service.command ||
      (service.args &&
        (!Array.isArray(service.args) ||
          service.args.some((arg: string) => typeof arg !== "string")))
    )
      throw new Error(
        `Invalid command or args for ${service.name}. Commands are executable names; use args for arguments.`,
      );
    if (
      service.env &&
      (typeof service.env !== "object" ||
        Object.values(service.env).some((value) => typeof value !== "string"))
    )
      throw new Error(`Service ${service.name}: env values must be strings.`);
  }
  const gateway = { ...DEFAULT_MANIFEST.gateway, ...config.gateway };
  if (
    !port(gateway.port) ||
    !port(gateway.controlPort) ||
    gateway.port === gateway.controlPort
  )
    throw new Error(
      "Gateway and control ports must be distinct integers between 1 and 65535.",
    );
  if (gateway.host !== "127.0.0.1")
    throw new Error(
      "The CLI gateway binds IPv4 and IPv6 loopback automatically; gateway.host must be 127.0.0.1.",
    );
  const worktree = { ...DEFAULT_MANIFEST.worktree, ...config.worktree };
  if (
    !Number.isInteger(worktree.slots) ||
    worktree.slots < 1 ||
    !Number.isInteger(worktree.stride) ||
    worktree.stride < config.services.length + 1 ||
    !port(worktree.firstPort) ||
    worktree.firstPort + worktree.slots * worktree.stride > 65535
  )
    throw new Error(
      "Invalid worktree port range; stride must include one ownership lease and every service.",
    );
  if (
    !["shared", "external", "none"].includes(config.backend?.mode ?? "external")
  )
    throw new Error("backend.mode must be shared, external, or none.");
  if (config.backend?.mode === "shared" && !config.backend.command)
    throw new Error("Shared backend needs a command.");
  if (
    !["pass-through", "callback", "relay"].includes(
      config.auth?.mode ?? "pass-through",
    )
  )
    throw new Error("auth.mode must be pass-through, callback, or relay.");
  if (config.auth?.mode === "callback") {
    if (!/^https?:\/\//.test(config.auth.upstream ?? ""))
      throw new Error("Callback adapter requires an HTTP(S) upstream.");
    if (!(config.auth.pathPrefix ?? "/api/auth/").startsWith("/"))
      throw new Error("auth.pathPrefix must start with /.");
  }
}
export function normalizeManifest(config: ManifestInput): NormalizedManifest {
  validateManifestShape(config);
  const result = {
    ...DEFAULT_MANIFEST,
    ...config,
    schemaVersion: 1 as const,
    services: config.services ?? [],
    gateway: { ...DEFAULT_MANIFEST.gateway, ...config.gateway },
    worktree: { ...DEFAULT_MANIFEST.worktree, ...config.worktree },
    backend: { ...DEFAULT_MANIFEST.backend, ...config.backend },
    auth: { ...DEFAULT_MANIFEST.auth, ...config.auth },
  };
  if (config.gateway?.port && !config.gateway?.controlPort)
    result.gateway.controlPort = result.gateway.port - 1;
  validateManifest(result);
  return result;
}
export function framework(
  script: string | undefined,
): "next" | "vite" | "nuxt" | "astro" | "remix" | undefined {
  // Only add flags when the script ends in a known dev server. Do not guess how
  // turbo, concurrently, docker or an arbitrary wrapper forwards its arguments.
  if (typeof script !== "string" || /[;|`\n]/.test(script)) return undefined;
  script = script.split(/\s*&&\s*/).at(-1);
  if (!script) return undefined;
  if (script.includes("&")) return undefined;
  if (/(?:^|\s)next\s+dev(?:\s|$)/.test(script)) return "next";
  if (
    /(?:^|\s)vite(?:\s|$)/.test(script) &&
    !/vite\s+(?:build|preview|test)/.test(script)
  )
    return "vite";
  if (/(?:^|\s)(?:nuxt|nuxi)\s+dev(?:\s|$)/.test(script)) return "nuxt";
  if (/(?:^|\s)astro\s+dev(?:\s|$)/.test(script)) return "astro";
  if (/(?:^|\s)remix\s+vite:dev(?:\s|$)/.test(script)) return "remix";
  return undefined;
}
function readPackage(path: string): PackageJson {
  const value = jsonObject(readFileSync(path, "utf8"));
  const result: PackageJson = {};
  const fail = (field: string): never => {
    throw new Error(`Invalid package.json field ${field} at ${path}.`);
  };
  if (value["packageManager"] !== undefined) {
    if (typeof value["packageManager"] !== "string") fail("packageManager");
    else result.packageManager = value["packageManager"];
  }
  const scripts = value["scripts"];
  if (scripts !== undefined) {
    if (
      scripts === null ||
      typeof scripts !== "object" ||
      Array.isArray(scripts)
    )
      return fail("scripts");
    const entries: [string, string][] = [];
    for (const [key, entry] of Object.entries(scripts)) {
      if (typeof entry !== "string") return fail("scripts");
      entries.push([key, entry]);
    }
    result.scripts = Object.fromEntries(entries);
  }
  if (value["benzo"] !== undefined) {
    validateManifestShape(value["benzo"]);
    result.benzo = value["benzo"] as ManifestInput;
  }
  if (value["portless"] !== undefined) result.portless = value["portless"];
  return result;
}
function packageManager(root: string, pkg: PackageJson): string {
  if (pkg.packageManager) return pkg.packageManager.split("@")[0] ?? "npm";
  for (let directory = resolve(root); ;) {
    if (existsSync(join(directory, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(directory, "yarn.lock"))) return "yarn";
    if (
      existsSync(join(directory, "bun.lock")) ||
      existsSync(join(directory, "bun.lockb"))
    )
      return "bun";
    if (existsSync(join(directory, "package-lock.json"))) return "npm";
    const parent = dirname(directory);
    if (parent === directory) break;
    const path = join(parent, "package.json");
    if (existsSync(path)) {
      const ancestor = readPackage(path);
      if (ancestor.packageManager)
        return ancestor.packageManager.split("@")[0] ?? "npm";
    }
    directory = parent;
  }
  return "npm";
}
function nestedFramework(
  cwd: string,
  script: string | undefined,
  depth = 0,
): ReturnType<typeof framework> {
  const direct = framework(script);
  if (direct || depth > 5 || typeof script !== "string") return direct;
  // Follow the common workspace script delegation without editing or replacing
  // the original command (and without evaluating shell text).
  const terminal =
    script
      .split(/\s*&&\s*/)
      .at(-1)
      ?.trim() ?? "";
  const match =
    terminal.match(
      /^(?:yarn|pnpm)\s+--cwd\s+([\w./-]+)\s+(?:run\s+)?([\w:-]+)$/,
    ) ?? terminal.match(/^npm\s+--prefix\s+([\w./-]+)\s+run\s+([\w:-]+)$/);
  if (match) {
    const directory = resolve(cwd, match[1] ?? "");
    const path = join(directory, "package.json");
    if (existsSync(path))
      return nestedFramework(
        directory,
        readPackage(path).scripts?.[match[2] ?? ""],
        depth + 1,
      );
  }
  return undefined;
}
function discoverInput(
  cwd: string,
  {
    script,
    command,
    args = [],
  }: { script?: string; command?: string; args?: string[] } = {},
): ManifestInput {
  if (command)
    return {
      discovery: "command",
      services: [{ name: "web", command, args }],
    };
  const path = join(cwd, "package.json");
  if (!existsSync(path))
    throw new Error(
      "No package.json or Benzo config found. Run benzo dev -- <your-server> [args], or use --config <file>.",
    );
  const pkg = readPackage(path);
  if (pkg.benzo) return pkg.benzo;
  script ??= pkg.scripts?.["dev"] ? "dev" : "start";
  if (!script) throw new Error("No dev or start script found.");
  const scriptText = pkg.scripts?.[script] ?? "";
  if (
    scriptText !== "" &&
    (/\b(?:turbo|nx|concurrently|docker|wireit)\b/.test(scriptText) ||
      /(?:^|\s)pnpm\s+(?:[^\n]*\s)?(?:-r|--recursive|--parallel)(?:\s|$)/.test(
        scriptText,
      ))
  )
    throw new Error(
      `The ${script} script starts an orchestrator. Use an external Benzo config to describe its services; Benzo will not guess their ports or alter this application.`,
    );
  const unwrapped = unwrapPortless(pkg, script);
  if (unwrapped) {
    if (pkg.portless || existsSync(join(cwd, "portless.json")))
      throw new Error(
        "Portless configuration requires explicit integration; use --script or an external Benzo config.",
      );
    return {
      discovery: "portless-literal",
      ...(unwrapped.name ? { name: unwrapped.name } : {}),
      warnings: [
        "Running the underlying app on Benzo's HTTP origin. Portless TLS, origins and proxy settings are not imported.",
      ],
      services: [
        { name: "web", command: unwrapped.command, args: unwrapped.args },
      ],
    };
  }
  if (/(?:^|\s)portless(?:\s|$)/.test(pkg.scripts?.[script] ?? ""))
    throw new Error(
      "This script already invokes Portless. Select the original application script with --script, or supply its command after --. Automatic Portless migration is not implemented.",
    );
  const detected = nestedFramework(cwd, pkg.scripts?.[script]);
  const manager = packageManager(cwd, pkg);
  if (detected) {
    const flags =
      detected === "next"
        ? ["--hostname", "127.0.0.1", "--port", "{port}"]
        : ["--host", "127.0.0.1", "--port", "{port}"];
    // Astro's argument parser makes repeated --port values an array and falls
    // back to its default port. Preserve scripts already binding the port to
    // Benzo's PORT environment instead of appending a second flag.
    if (
      detected === "astro" &&
      /--port(?:\s+|=)["']?(?:\$\{PORT(?::-[^}]+)?\}|\$PORT|%PORT%)(?:["']?(?:\s|$))/.test(
        scriptText,
      )
    )
      flags.splice(-2);
    if (["vite", "remix"].includes(detected)) flags.push("--strictPort");
    return {
      discovery: detected,
      services: [
        {
          name: "web",
          command: manager,
          args: ["run", script, ...(manager === "npm" ? ["--"] : []), ...flags],
        },
      ],
    };
  }
  if (pkg.scripts?.[script]) {
    if (/\bbenzo\b/.test(scriptText))
      throw new Error(
        "This script already invokes Benzo. Use --script to select the original application dev script.",
      );
    return {
      discovery: "script",
      services: [{ name: "web", command: manager, args: ["run", script] }],
    };
  }
  throw new Error(
    `No ${script} script found. Use --script <name>, benzo dev -- <command> [args], or --config <file>.`,
  );
}
export function discoverManifest(
  cwd: string,
  options: { script?: string; command?: string; args?: string[] } = {},
): NormalizedManifest {
  return normalizeManifest(discoverInput(cwd, options));
}
export function loadManifest(
  cwd: string = process.cwd(),
  filename?: string,
  options: { script?: string; command?: string; args?: string[] } = {},
): NormalizedManifest {
  return loadManifestWithSource(cwd, filename, options).config;
}
export function loadManifestWithSource(
  cwd: string = process.cwd(),
  filename?: string,
  options: { script?: string; command?: string; args?: string[] } = {},
): {
  input: ManifestInput;
  config: NormalizedManifest;
  source: { kind: string; path?: string };
} {
  const associated =
    filename === undefined ? associatedManifest(cwd) : undefined;
  const selected = filename ?? associated;
  const path = resolve(cwd, selected ?? "benzo.config.json");
  if (!existsSync(path)) {
    if (selected !== undefined)
      throw new Error(
        `Missing Benzo config: ${path}${associated ? ". Update the association with benzo link --config <file>, or remove it with benzo unlink." : ""}`,
      );
    const input = discoverInput(cwd, options);
    return {
      input,
      config: normalizeManifest(input),
      source: options.command
        ? { kind: "command" }
        : { kind: "package", path: join(cwd, "package.json") },
    };
  }
  let config: ManifestInput;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Could not parse Benzo config: ${path}`);
  }
  return {
    input: config,
    config: normalizeManifest(config),
    source: {
      kind:
        filename !== undefined
          ? "explicit-manifest"
          : associated
            ? "associated-manifest"
            : "project-manifest",
      path,
    },
  };
}
