#!/usr/bin/env node
import type { CliOptions } from "./types.js";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, basename } from "node:path";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import {
  loadManifest,
  loadManifestWithSource,
  manifestDiagnostics,
  normalizeManifest,
  readLastState,
  worktreeName,
} from "./core.js";
import { getEnvironment } from "./sdk.js";
import { associateManifest, removeAssociation } from "./association.js";
import { runClient } from "./client.js";
import { planProvenance } from "./plan.js";
import { inspectPortless } from "./portless-plan.js";
import { runGateway } from "./daemon.js";
import {
  liveState,
  publicState,
  runDev,
  supervisorRequest,
} from "./runtime.js";

function parse(argv: string[]): CliOptions {
  const result: CliOptions = {
    command: argv[0] ?? "dev",
    discovery: {},
    env: {},
    cwd: process.cwd(),
  };
  let index = 1;
  if (argv[0]?.startsWith("-")) {
    result.command = "dev";
    index = 0;
  }
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--") {
      const command = argv[++index];
      if (command) result.discovery.command = command;
      result.discovery.args = argv.slice(index + 1);
      if (!command) throw new Error("Expected a command after --.");
      break;
    }
    if (result.command === "migrate" && index === 1 && arg === "portless") {
      result.migration = "portless";
    } else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--env") {
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
        "--from",
      ].includes(arg)
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}.`);
      const key = arg.slice(2) as keyof CliOptions;
      if (
        ["cwd", "config", "name", "script", "service", "from"].includes(
          arg.slice(2),
        )
      )
        result[key] = value;
      else if (arg === "--gateway-port") result[key] = Number(value);
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
const help = `Benzo — development servers across worktrees\n\n  benzo dev                         discover and run the existing dev script\n  benzo dev -- python -m http.server {port}\n  benzo dev --config /path/config.json\n  benzo status | urls | logs | stop | doctor\n  benzo link --config <file>        remember an external manifest for this checkout\n  benzo unlink                      restore ordinary discovery\n  benzo exec --env BASE_URL={services.web.origin} -- <command>\n  benzo dev --from portless         inspect a Portless script without launching\n  benzo migrate portless --dry-run   report a reversible HTTP trial plan\n  benzo describe --json             read the live environment descriptor\n  benzo config --json               show effective config (keys only)\n  benzo explain                     explain discovery and launch decisions\n\nOptions: --cwd <path> --name <name> --script <script>\n         --gateway-port <port> --env KEY=value --auth-relay --json\n\nNo application edits. No hosts-file changes. Auth responses pass through unchanged;\nlocal callback affinity and loopback redirects stay on the named worktree.\n--auth-relay remains available as an explicit relay mode. Run doctor for limits.`;
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
  if (
    options.command === "migrate" ||
    (options.command === "dev" && options.from === "portless")
  ) {
    const migration = options.command === "migrate";
    const allowed = new Set([
      "command",
      "cwd",
      "env",
      "discovery",
      "script",
      "json",
      ...(migration ? ["migration", "dryRun"] : ["from"]),
    ]);
    if (migration && (options.migration !== "portless" || !options.dryRun))
      throw new Error(
        "Only benzo migrate portless --dry-run is supported; automatic migration is not implemented.",
      );
    if (
      Object.keys(options).some((key) => !allowed.has(key)) ||
      Object.keys(options.env).length ||
      options.discovery.command
    )
      throw new Error(
        "Portless inspection accepts only --cwd, --script and --json; it never launches or changes files.",
      );
    const report = inspectPortless(options.cwd, options.script);
    console.log(JSON.stringify(report, null, options.json ? 0 : 2));
    if (report.status === "unsupported") process.exitCode = 1;
    return;
  }
  if (options.dryRun)
    throw new Error(
      "--dry-run is supported only by benzo migrate portless --dry-run.",
    );
  if (options.command === "inspect")
    throw new Error(
      "The graph inspection command was removed from Benzo. Use an orchestrator's own CLI, then provide an explicit Benzo manifest or SDK lease.",
    );
  if (options.from)
    throw new Error("--from supports only read-only Portless inspection.");
  if (options.command === "exec") {
    const allowed = new Set(["command", "cwd", "env", "discovery"]);
    if (
      Object.keys(options).some((key) => !allowed.has(key)) ||
      options.discovery.script
    )
      throw new Error(
        "exec accepts only --cwd, --env and a command after --. It uses the running environment.",
      );
    if (!options.discovery.command)
      throw new Error("Use benzo exec [--env KEY=value] -- <command> [args].");
    process.exitCode = await runClient({
      cwd: options.cwd,
      command: options.discovery.command,
      args: options.discovery.args ?? [],
      env: options.env,
    });
    return;
  }
  if (["link", "unlink"].includes(options.command)) {
    const allowed = new Set([
      "command",
      "cwd",
      "env",
      "discovery",
      ...(options.command === "link" ? ["config"] : []),
    ]);
    if (
      Object.keys(options).some((key) => !allowed.has(key)) ||
      Object.keys(options.env).length ||
      Object.keys(options.discovery).length
    )
      throw new Error(
        `${options.command} accepts only --cwd${options.command === "link" ? " and --config" : ""}; launch options are not saved.`,
      );
  }
  if (options.command === "link") {
    if (!options.config)
      throw new Error(
        "Use benzo link --config <file> to associate a manifest with this checkout.",
      );
    loadManifest(options.cwd, options.config);
    const manifest = associateManifest(options.cwd, options.config);
    console.log(`Linked this checkout to ${manifest}. Run benzo to start it.`);
    return;
  }
  if (options.command === "unlink") {
    removeAssociation(options.cwd);
    console.log(
      "Removed this checkout's manifest association. Project files and running services are unchanged.",
    );
    return;
  }
  if (options.command === "describe") {
    const descriptor = await getEnvironment({ cwd: options.cwd });
    console.log(JSON.stringify(descriptor, null, options.json ? 0 : 2));
    return;
  }
  if (["status", "urls", "logs", "stop"].includes(options.command)) {
    const state = await liveState(options.cwd);
    if (options.command === "logs") {
      const logs = state?.logs ?? readLastState(options.cwd)?.["logs"];
      if (logs === null || typeof logs !== "object" || Array.isArray(logs)) {
        console.log("No running Benzo worktree.");
        return;
      }
      for (const [service, path] of Object.entries(logs))
        if (
          typeof path === "string" &&
          (!options.service || options.service === service) &&
          existsSync(path)
        )
          process.stdout.write(readFileSync(path, "utf8"));
      return;
    }
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
  let { config, source, input } = loadManifestWithSource(
    options.cwd,
    options.config,
    options.discovery,
  );
  if (options["gateway-port"] !== undefined)
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
  const descriptor = {
    schemaVersion: 1,
    kind: "launch-plan",
    provenance: planProvenance(input, source, options),
    allocatedName: null,
    allocationRules:
      "CLI name, then configured name, then saved name, then checkout basename; active collisions may change the allocated name. Private ports are reserved at launch.",
    liveValuesCommand: "benzo describe --json",
    allocation: "unresolved-until-launch",
    requestedName:
      options.name ?? config.name ?? worktreeName(basename(options.cwd)),
    cwd: options.cwd,
    source,
    diagnostics: manifestDiagnostics(config),
    discovery: config.discovery ?? "manifest",
    warnings: config.warnings ?? [],
    gateway: {
      host: config.gateway.host,
      port: config.gateway.port,
      controlPort: config.gateway.controlPort,
      protocol: config.gateway.tls ? "https" : "http",
      tlsConfigured: Boolean(config.gateway.tls),
    },
    worktree: {
      slots: config.worktree.slots,
      firstPort: config.worktree.firstPort,
      stride: config.worktree.stride,
    },
    backend: {
      mode: config.backend.mode,
      envKeys: Object.keys(config.backend.env ?? {}).sort(),
    },
    auth: { mode: config.auth.mode },
    services: config.services.map((service, index) => ({
      origin: null,
      upstreamPort: null,
      originTemplate: `${config.gateway.tls ? "https" : "http"}://${index ? `${service.name}.` : ""}{allocatedName}.localhost:${config.gateway.port}`,
      name: service.name,
      cwd: service.cwd ?? ".",
      command: "[redacted]",
      args: (service.args ?? []).map(() => "[redacted]"),
      ready: {
        type: service.ready?.type ?? "http",
        path: service.ready?.type === "tcp" ? undefined : "[redacted]",
        status: service.ready?.status ?? null,
        timeout: service.ready?.timeout ?? 120000,
      },
      envKeys: Object.keys(service.env ?? {}).sort(),
      excludeEnv: service.excludeEnv ?? [],
    })),
  };
  if (["config", "explain"].includes(options.command)) {
    if (options.command === "config" || options.json)
      return console.log(
        JSON.stringify(descriptor, null, options.json ? 0 : 2),
      );
    console.log(
      [
        `Project: ${descriptor.cwd}`,
        `Discovery: ${descriptor.discovery}`,
        `Source: ${descriptor.source.kind}${descriptor.source.path ? ` (${descriptor.source.path})` : ""}`,
        ...descriptor.diagnostics.map(
          (entry) => `Unknown config field: ${entry.path}`,
        ),
        `Gateway: ${descriptor.gateway.protocol}://${descriptor.gateway.host}:${descriptor.gateway.port}`,
        `Requested name: ${descriptor.requestedName} (${descriptor.provenance.requestedName}); allocated name unresolved until launch`,
        `Gateway port source: ${descriptor.provenance.gateway.port}`,
        `Auth: ${descriptor.auth.mode} (${descriptor.provenance.authMode})`,
        ...Object.entries(descriptor.provenance.gateway).map(
          ([key, source]) => `Gateway ${key}: ${source}`,
        ),
        ...Object.entries(descriptor.provenance.worktree).map(
          ([key, source]) => `Worktree ${key}: ${source}`,
        ),
        `Backend mode: ${descriptor.backend.mode} (${descriptor.provenance.backendMode})`,
        ...descriptor.provenance.services.flatMap((service) => [
          `Service ${service.name} sources: command=${service.command}, args=${service.args}, cwd=${service.cwd}, excludeEnv=${service.excludeEnv}`,
          `Service ${service.name} readiness sources: ${Object.entries(
            service.ready,
          )
            .map(([key, source]) => `${key}=${source}`)
            .join(", ")}`,
          `Service ${service.name} environment sources: ${Object.entries(
            service.env,
          )
            .map(([key, source]) => `${key}=${source}`)
            .join(", ")}`,
          `Service ${service.name} excluded inherited keys: ${service.excludedInheritedKeys.join(", ") || "none"}`,
          `Service ${service.name} executable search: ${service.executableSearchPath}`,
        ]),
        ...descriptor.services.map(
          (service) =>
            `Origin ${service.name}: ${service.originTemplate} (unresolved)`,
        ),
        ...descriptor.services.map((service) =>
          `Service ${service.name}: ${service.command} ${service.args.join(" ")}`.trim(),
        ),
        "Environment values are inherited or configured at launch; only key names are shown by this command. Commands, arguments and readiness paths are redacted because they may contain credentials. Origins and ports are allocated at launch; use benzo describe --json for live values.",
      ].join("\n"),
    );
    return;
  }
  if (options.command === "doctor") {
    const diagnostics = {
      discovery: config.discovery ?? "manifest",
      services: config.services.map((service) => service.name),
      gateway: descriptor.gateway,
      auth: config.auth.mode,
      dns: [] as {
        hostname: string;
        addresses: import("node:dns").LookupAddress[];
      }[],
      warnings: [] as string[],
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
    if (config.gateway.tls)
      diagnostics.warnings.push(
        "HTTPS uses your supplied certificate. Benzo installs no CA; each browser, Node, Go or container client must trust its issuer and resolve the named host. HTTP-only callbacks on this port are unsupported.",
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
  for (const warning of config.warnings ?? [])
    console.error(`benzo: ${warning}`);
  for (const entry of descriptor.diagnostics)
    console.error(`benzo: unknown config field ${entry.path}`);
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
