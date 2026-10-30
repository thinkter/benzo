#!/usr/bin/env node
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, basename } from "node:path";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import {
  loadManifest,
  normalizeManifest,
  readLastState,
  worktreeName,
} from "./core.js";
import { runGateway } from "./daemon.js";
import {
  liveState,
  publicState,
  runDev,
  supervisorRequest,
} from "./runtime.js";

function parse(argv) {
  const result = { command: argv[0] ?? "dev", discovery: {}, env: {} };
  let index = 1;
  if (argv[0]?.startsWith("-")) {
    result.command = "help";
    index = 0;
  }
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      result.discovery.command = argv[++index];
      result.discovery.args = argv.slice(index + 1);
      if (!result.discovery.command)
        throw new Error("Expected a command after --.");
      break;
    }
    if (arg === "--env") {
      const value = argv[++index] ?? "";
      const separator = value.indexOf("=");
      const key = value.slice(0, separator);
      if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error(
          "--env requires KEY=value. Use an existing application environment setting.",
        );
      result.env[key] = value.slice(separator + 1);
    } else if (
      [
        "--cwd",
        "--config",
        "--name",
        "--gateway-port",
        "--script",
        "--service",
      ].includes(arg)
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}.`);
      result[arg.slice(2)] = value;
    } else if (arg === "--json") result.json = true;
    else if (arg === "--auth-relay") result.authRelay = true;
    else if (["--help", "-h"].includes(arg)) result.command = "help";
    else if (["--version", "-v"].includes(arg)) result.command = "version";
    else throw new Error(`Unknown argument: ${arg}. Use benzo --help.`);
  }
  result.cwd = resolve(result.cwd ?? process.cwd());
  if (result.script) result.discovery.script = result.script;
  return result;
}
const help = `Benzo — development servers across worktrees\n\n  benzo dev                         discover and run the existing dev script\n  benzo dev -- python -m http.server {port}\n  benzo dev --config /path/config.json\n  benzo status | urls | logs | stop | doctor\n\nOptions: --cwd <path> --name <name> --script <script>\n         --gateway-port <port> --env KEY=value --auth-relay --json\n\nNo application edits. No hosts-file changes. Auth passes through by default.\n--auth-relay can return an observed OAuth callback to its initiating worktree;\nit keeps the existing localhost callback URL. Run doctor for compatibility limits.`;
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.command === "_gateway") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    await runGateway(JSON.parse(input));
    return;
  }
  if (options.command === "help") return console.log(help);
  if (options.command === "version") return console.log("0.1.0");
  if (["status", "urls", "logs", "stop"].includes(options.command)) {
    const state =
      (await liveState(options.cwd)) ??
      (options.command === "logs" ? readLastState(options.cwd) : undefined);
    if (options.command === "status")
      return console.log(
        options.json
          ? JSON.stringify(publicState(state) ?? {})
          : state
            ? JSON.stringify(publicState(state), null, 2)
            : "No running Benzo worktree.",
      );
    if (!state) {
      if (options.command === "stop")
        return console.log("No running Benzo worktree.");
      throw new Error("No running Benzo worktree. Start benzo dev first.");
    }
    if (options.command === "stop") {
      await supervisorRequest(state, "stop");
      return console.log("Stopping this worktree.");
    }
    if (options.command === "urls")
      return console.log(
        options.json
          ? JSON.stringify(state.urls)
          : Object.entries(state.urls)
              .map(([name, url]) => `${name}: ${url}`)
              .join("\n"),
      );
    for (const [service, path] of Object.entries(state.logs))
      if ((!options.service || options.service === service) && existsSync(path))
        process.stdout.write(readFileSync(path, "utf8"));
    return;
  }
  let config = loadManifest(options.cwd, options.config, options.discovery);
  if (options["gateway-port"])
    config = normalizeManifest({
      ...config,
      gateway: {
        ...config.gateway,
        port: Number(options["gateway-port"]),
        controlPort: Number(options["gateway-port"]) - 1,
      },
    });
  if (options.authRelay) config.auth = { mode: "relay" };
  if (Object.keys(options.env).length)
    config = normalizeManifest({
      ...config,
      services: config.services.map((service) => ({
        ...service,
        env: { ...service.env, ...options.env },
      })),
    });
  if (options.command === "doctor") {
    const diagnostics = {
      discovery: config.discovery ?? "manifest",
      services: config.services.map((service) => service.name),
      gateway: config.gateway,
      auth: config.auth.mode,
      dns: [],
      warnings: [],
    };
    for (const hostname of [
      `${worktreeName(basename(options.cwd))}.localhost`,
      `api.${worktreeName(basename(options.cwd))}.localhost`,
    ]) {
      try {
        diagnostics.dns.push({
          hostname,
          addresses: await lookup(hostname, { all: true }),
        });
      } catch {
        diagnostics.dns.push({ hostname, addresses: [] });
        diagnostics.warnings.push(
          `OS DNS cannot resolve ${hostname}. Browsers may resolve .localhost independently. Internal tools can use the assigned loopback port (benzo status); changing to a numeric origin can affect auth.`,
        );
      }
    }
    diagnostics.warnings.push(
      "A hard-coded application origin/trusted-origin list or provider policy may prevent unchanged auth from working on a named origin. Benzo does not disable CSRF checks or reconfigure OAuth providers.",
    );
    if (config.discovery === "script")
      diagnostics.warnings.push(
        "Unknown dev server: its existing script must honor PORT. Use an external Benzo config if it needs a port argument.",
      );
    console.log(
      options.json
        ? JSON.stringify(diagnostics)
        : JSON.stringify(diagnostics, null, 2),
    );
    return;
  }
  if (options.command !== "dev")
    throw new Error(`Unknown command: ${options.command}. Use benzo --help.`);
  await runDev(options.cwd, config, {
    name: options.name,
    config: options.config,
    discovery: options.discovery,
  });
}
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`benzo: ${error.message}`);
    process.exitCode = 1;
  });
