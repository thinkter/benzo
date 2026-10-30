import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const DEFAULT_MANIFEST = {
  gateway: { port: 3000, controlPort: 2999, host: "127.0.0.1" },
  worktree: { slots: 100, firstPort: 10000, stride: 32 },
  backend: { mode: "external" },
  auth: { mode: "pass-through" },
  services: [],
};
const label = /^[a-z][a-z0-9-]{0,49}$/;
const port = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
export function validateManifest(config) {
  if (
    !config ||
    typeof config !== "object" ||
    !Array.isArray(config.services) ||
    !config.services.length
  )
    throw new Error("At least one development service is required.");
  const names = new Set();
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
          service.args.some((arg) => typeof arg !== "string")))
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
export function normalizeManifest(config) {
  const result = {
    ...DEFAULT_MANIFEST,
    ...config,
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
export function framework(script) {
  // Only add flags when the script ends in a known dev server. Do not guess how
  // turbo, concurrently, docker or an arbitrary wrapper forwards its arguments.
  if (typeof script !== "string" || /[;|`\n]/.test(script)) return undefined;
  script = script.split(/\s*&&\s*/).at(-1);
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
function packageManager(root, pkg) {
  if (pkg.packageManager) return pkg.packageManager.split("@")[0];
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
    return "bun";
  return "npm";
}
function nestedFramework(cwd, script, depth = 0) {
  const direct = framework(script);
  if (direct || depth > 5 || typeof script !== "string") return direct;
  // Follow the common workspace script delegation without editing or replacing
  // the original command (and without evaluating shell text).
  const terminal = script
    .split(/\s*&&\s*/)
    .at(-1)
    .trim();
  const match =
    terminal.match(
      /^(?:yarn|pnpm)\s+--cwd\s+([\w./-]+)\s+(?:run\s+)?([\w:-]+)$/,
    ) ?? terminal.match(/^npm\s+--prefix\s+([\w./-]+)\s+run\s+([\w:-]+)$/);
  if (match) {
    const directory = resolve(cwd, match[1]);
    const path = join(directory, "package.json");
    if (existsSync(path))
      return nestedFramework(
        directory,
        JSON.parse(readFileSync(path, "utf8")).scripts?.[match[2]],
        depth + 1,
      );
  }
  return undefined;
}
export function discoverManifest(cwd, { script, command, args = [] } = {}) {
  if (command)
    return normalizeManifest({
      discovery: "command",
      services: [{ name: "web", command, args }],
    });
  const path = join(cwd, "package.json");
  if (!existsSync(path))
    throw new Error(
      "No package.json or Benzo config found. Run benzo dev -- <your-server> [args], or use --config <file>.",
    );
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.benzo) return normalizeManifest(pkg.benzo);
  script ??= pkg.scripts?.dev ? "dev" : "start";
  const detected = nestedFramework(cwd, pkg.scripts?.[script]);
  const manager = packageManager(cwd, pkg);
  if (detected) {
    const flags =
      detected === "next"
        ? ["--hostname", "127.0.0.1", "--port", "{port}"]
        : ["--host", "127.0.0.1", "--port", "{port}"];
    if (["vite", "remix"].includes(detected)) flags.push("--strictPort");
    return normalizeManifest({
      discovery: detected,
      services: [
        {
          name: "web",
          command: manager,
          args: ["run", script, ...(manager === "npm" ? ["--"] : []), ...flags],
        },
      ],
    });
  }
  if (pkg.scripts?.[script]) {
    if (/\bbenzo\b/.test(pkg.scripts[script]))
      throw new Error(
        "This script already invokes Benzo. Use --script to select the original application dev script.",
      );
    if (/\b(?:turbo|nx|concurrently|docker|wireit)\b/.test(pkg.scripts[script]))
      throw new Error(
        `The ${script} script starts an orchestrator. Use an external Benzo config to describe its services; Benzo will not guess their ports or alter this application.`,
      );
    return normalizeManifest({
      discovery: "script",
      services: [{ name: "web", command: manager, args: ["run", script] }],
    });
  }
  throw new Error(
    `No ${script} script found. Use --script <name>, benzo dev -- <command> [args], or --config <file>.`,
  );
}
export function loadManifest(cwd = process.cwd(), filename, options = {}) {
  const path = resolve(cwd, filename ?? "benzo.config.json");
  if (!existsSync(path)) {
    if (filename) throw new Error(`Missing Benzo config: ${path}`);
    return discoverManifest(cwd, options);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Could not parse Benzo config: ${path}`);
  }
  return normalizeManifest(config);
}
