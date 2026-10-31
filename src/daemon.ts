import { registration } from "./registration.js";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import type { WriteStream } from "node:fs";
import type {
  NormalizedManifest,
  GatewayRegistration,
  GatewayLaunch,
  ControlResponse,
} from "./types.js";
import type { Route, CallbackEntry } from "./gateway.js";
interface Peer {
  socket: Socket;
  name: string;
  project: string;
  hosts: string[];
  external: boolean;
  services: Map<string, string>;
  children: Set<number>;
  cwd: string;
}
import { createServer } from "node:net";
import { createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { randomUUID, X509Certificate } from "node:crypto";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  availableName,
  atomicJson,
  canonicalPath,
  connectShared,
  createGateway,
  hash,
  homeDirectory,
  launch,
  loadManifest,
  PROTOCOL,
  readJson,
  receiveMessage,
  stop,
} from "./core.js";
import { listen } from "./gateway.js";
import { gatewayTransport } from "./tls.js";

const daemonEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
export function gatewayDirectory(port: number) {
  return join(homeDirectory(), "gateways", String(port));
}
export async function acquireGateway(
  config: NormalizedManifest,
  request: GatewayRegistration,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ControlResponse> {
  const transport = gatewayTransport(config.gateway, request.worktree);
  const directory = gatewayDirectory(config.gateway.port);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "gateway.json");
  const lock = join(directory, "starting");
  let starter = false;
  let child: ChildProcess | undefined;
  let childFailure: Promise<Error> | undefined;
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Startup cancelled.");
      const registry = readJson(path);
      if (registry) {
        if (typeof registry["token"] !== "string")
          throw new Error("Invalid gateway registry.");
        if (registry["controlPort"] !== config.gateway.controlPort)
          throw new Error(
            "This gateway already uses a different control port. Use its controlPort or choose a different gateway port.",
          );
        try {
          const lease = await connectShared({
            port: config.gateway.controlPort,
            request: {
              ...request,
              transport: transport.identity,
              token: registry["token"],
            },
            ...(signal ? { signal } : {}),
            timeout: 2000,
          });
          if ((lease.transport ?? "http") !== transport.identity) {
            lease.socket.destroy();
            throw new Error(
              "Gateway transport or certificate differs. Choose a different gateway port or stop the existing gateway's launchers first.",
            );
          }
          return lease;
        } catch (error) {
          if (
            !["ECONNREFUSED", "ECONNRESET"].includes(
              error instanceof Error && "code" in error
                ? String(error.code)
                : "",
            )
          )
            throw error;
        }
      }
      if (!starter) {
        try {
          mkdirSync(lock);
          starter = true;
          // Config travels through a pipe, never argv, environment dumps or disk.
          child = launch(
            process.execPath,
            [daemonEntry, "_gateway"],
            process.cwd(),
            process.env,
            { stdio: ["pipe", "ignore", "pipe"] },
          );
          let diagnostic = "";
          child.stderr?.on("data", (chunk) => {
            diagnostic = `${diagnostic}${chunk}`.slice(-2048);
          });
          childFailure = new Promise<Error>((accept) => {
            child?.once("error", (error) => accept(error));
            child?.once("exit", () =>
              accept(
                new Error(
                  diagnostic.trim() ||
                    "Gateway failed to start. A gateway or control port may already be occupied.",
                ),
              ),
            );
          });
          child.stdin?.end(
            JSON.stringify({
              gateway: { ...config.gateway, tls: transport.tls },
              transport: transport.identity,
              ownerProject: request.project,
            }),
          );
          child.stdin?.on("error", () => {});
          child.unref();
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
          try {
            if (Date.now() - statSync(lock).mtimeMs > 20000)
              rmSync(lock, { recursive: true });
          } catch {}
        }
      }
      if (child) {
        const failure = await Promise.race([
          childFailure,
          delay(75).then(() => undefined),
        ]);
        if (failure) throw failure;
      } else await delay(75);
    }
    throw new Error(
      "Timed out starting gateway. Run benzo doctor; a local port may already be occupied.",
    );
  } finally {
    if (starter) rmSync(lock, { recursive: true, force: true });
    child?.stderr?.destroy();
  }
}

export async function runGateway(config: GatewayLaunch) {
  const cert = config.gateway.tls?.cert;
  if (cert !== undefined && typeof cert !== "string" && !Buffer.isBuffer(cert))
    throw new Error("Invalid TLS certificate.");
  const certificate = cert ? new X509Certificate(cert) : undefined;
  const directory = gatewayDirectory(config.gateway.port);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registryPath = join(directory, "gateway.json");
  const token = randomUUID();
  const routes = new Map<string, Route>();
  const peers = new Map<string, Peer>();
  const pendingSockets = new Set<Socket>();
  const backends = new Map<
    string,
    { child: ChildProcess; stream: WriteStream; identity: string }
  >();
  const callbackStore = new Map<string, CallbackEntry>();
  const gateways = [
    createGateway({
      routes,
      port: config.gateway.port,
      callbackStore,
      tls: config.gateway.tls,
    }),
  ];
  let idle: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((accept) => {
    resolveDone = accept;
  });
  const control = createServer((socket) => {
    pendingSockets.add(socket);
    socket.on("error", () => {});
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("close", () => pendingSockets.delete(socket));
    const reject = (message: string): void =>
      void socket.end(
        `${JSON.stringify({ protocol: PROTOCOL, error: message })}\n`,
      );
    receiveMessage(
      socket,
      async (request) => {
        try {
          if (request["protocol"] !== PROTOCOL || request["token"] !== token)
            return reject("Incompatible or unauthorized gateway registration.");
          if (
            request["action"] === "attach" ||
            request["action"] === "readiness"
          ) {
            const peer = [...peers.values()].find(
              (value) => value.socket === socket,
            );
            if (typeof request["service"] !== "string")
              return reject("Invalid service.");
            if (!peer?.external)
              return reject("No external listener lease on this connection.");
            const routeHost = peer.services.get(request["service"]);
            if (!routeHost) return reject("Unknown service on this lease.");
            const previous = routes.get(routeHost);
            if (typeof request["ready"] !== "boolean")
              return reject("Readiness must be boolean.");
            if (!previous) return reject("Listener route disappeared.");
            const port =
              request["action"] === "attach" ? request["port"] : previous.port;
            if (
              typeof port !== "number" ||
              !Number.isInteger(port) ||
              port < 1 ||
              port > 65535 ||
              port === config.gateway.port ||
              port === config.gateway.controlPort
            )
              return reject("Invalid external listener port.");
            // Readiness belongs to the same owner. Only attaching an upstream
            // creates a new identity and invalidates its old OAuth state.
            if (request["action"] === "readiness")
              previous.ready = request["ready"];
            else
              routes.set(routeHost, {
                ...previous,
                port,
                ready: request["ready"],
              });
            socket.write(
              `${JSON.stringify({ protocol: PROTOCOL, updated: true, id: request["id"] })}\n`,
            );
            return;
          }
          if (request["action"] === "own" || request["action"] === "released") {
            const peer = [...peers.values()].find(
              (value) => value.socket === socket,
            );
            if (!peer || peer.external)
              return reject("No process ownership lease.");
            if (request["action"] === "released") {
              peer.children.clear();
              return;
            }
            if (
              typeof request["pid"] !== "number" ||
              !Number.isInteger(request["pid"]) ||
              request["pid"] < 1
            )
              return reject("Invalid child process.");
            peer.children.add(request["pid"]);
            return;
          }
          if (request["action"] === "ping")
            return void socket.end(
              `${JSON.stringify({ protocol: PROTOCOL, ready: true })}\n`,
            );
          if ((request["transport"] ?? "http") !== (config.transport ?? "http"))
            return reject(
              "Gateway transport or certificate differs. Choose a different gateway port or stop the existing gateway's launchers first.",
            );
          const registered = registration(request);
          const cwd = canonicalPath(registered.worktree);
          if (peers.has(cwd))
            return reject(
              "This worktree already has a running Benzo launcher. Use benzo urls or benzo stop.",
            );
          if (
            !Array.isArray(registered.services) ||
            !registered.services.length ||
            registered.services.length > 100
          )
            return reject("Invalid service registration.");
          if (
            new Set(registered.services.map((service) => service.name)).size !==
            registered.services.length
          )
            return reject("Duplicate service registration.");
          for (const service of registered.services)
            if (
              !/^[a-z][a-z0-9-]{0,49}$/.test(service.name) ||
              !Number.isInteger(service.port) ||
              service.port < (registered.external === true ? 0 : 1) ||
              service.port > 65535
            )
              return reject("Invalid service registration.");
          const name = availableName(
            registered.name,
            new Set([...peers.values()].map((peer) => peer.name)),
            registered.baseName ?? basename(cwd),
          );
          if (
            certificate &&
            registered.services.some(
              (service, index) =>
                !certificate.checkHost(
                  `${index ? `${service.name}.` : ""}${name}.localhost`,
                ),
            )
          )
            return reject(
              "The TLS certificate does not cover every allocated service hostname. Supply a matching certificate or choose a covered worktree name.",
            );
          const peer: Peer = {
            socket,
            name,
            project: registered.project,
            hosts: [],
            external: registered.external === true,
            services: new Map(),
            children: new Set(),
            cwd,
          };
          peers.set(cwd, peer);
          clearTimeout(idle);
          socket.setTimeout(0);
          socket.once("close", () => {
            if (peers.get(cwd) !== peer) return;
            peers.delete(cwd);
            peer.hosts.forEach((host) => routes.delete(host));
            for (const pid of peer.children) void stop(pid);
            if (!peers.size) idle = setTimeout(() => void shutdown(), 750);
          });
          for (const [index, service] of registered.services.entries()) {
            const host = `${index ? `${service.name}.` : ""}${name}.localhost`;
            if (routes.has(host))
              throw new Error("Conflicting service hostname.");
            routes.set(host, {
              port: service.port,
              ...(peer.external ? { ready: false } : {}),
              auth: {
                ...registered.auth,
                mode: registered.auth?.mode ?? "pass-through",
              },
            });
            peer.hosts.push(host);
            peer.services.set(service.name, host);
          }
          if (registered.backend?.mode === "shared") {
            if (registered.project !== config.ownerProject)
              throw new Error(
                "This gateway was started from another project. Use a separate --gateway-port for this shared backend so it inherits the correct environment.",
              );
            const manifest = loadManifest(
              cwd,
              registered.config,
              registered.discovery,
            );
            const identity = hash(JSON.stringify(manifest.backend));
            const existing = backends.get(registered.project);
            if (existing && existing.identity !== identity)
              throw new Error(
                "Shared backend configuration differs across worktrees.",
              );
            if (!existing) {
              const backend = manifest.backend;
              if (!backend.command)
                throw new Error("Shared backend requires a command.");
              const child = launch(
                backend.command,
                backend.args ?? [],
                join(cwd, backend.cwd ?? "."),
                { ...process.env, ...backend.env },
              );
              const stream = createWriteStream(
                join(directory, `backend-${registered.project}.log`),
                { flags: "a", mode: 0o600 },
              );
              for (const pipe of [child.stdout, child.stderr])
                pipe?.on("data", (chunk) =>
                  stream.write(chunk.toString().replace(/\x1b\[[0-9;]*m/g, "")),
                );
              const failBackend = () => {
                stream.end();
                backends.delete(registered.project);
                if (!stopping)
                  for (const active of peers.values())
                    if (active.project === registered.project)
                      active.socket.destroy();
              };
              stream.on("error", failBackend);
              child?.once("error", failBackend);
              child?.once("exit", failBackend);
              backends.set(registered.project, { child, stream, identity });
            }
          }
          if (!socket.destroyed)
            socket.write(
              `${JSON.stringify({ protocol: PROTOCOL, ready: true, name, gatewayPort: config.gateway.port, transport: config.transport ?? "http" })}\n`,
            );
        } catch (error) {
          reject(
            error instanceof Error
              ? error.message
              : "Invalid gateway registration.",
          );
        }
      },
      { multiple: true },
    );
  });
  function shutdown() {
    return (stopping ??= (async () => {
      clearTimeout(idle);
      for (const socket of pendingSockets) socket.destroy();
      control.close();
      await Promise.all(gateways.map((gateway) => gateway.close()));
      await Promise.all(
        [...backends.values()].map(async (backend) => {
          await stop(backend.child);
          backend.stream.end();
        }),
      );
      if (readJson(registryPath)?.["token"] === token)
        rmSync(registryPath, { force: true });
      resolveDone();
    })());
  }
  const onSignal = () => void shutdown();
  try {
    try {
      await gateways[0]?.listen();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EADDRINUSE"
      )
        throw new Error(
          `Gateway port ${config.gateway.port} is already in use. Benzo will not stop its owner. Choose --gateway-port <port>, or stop the existing server yourself. Fixed OAuth callbacks still require their original port.`,
        );
      throw error;
    }
    const ipv6 = createGateway({
      routes,
      port: config.gateway.port,
      host: "::1",
      callbackStore,
      tls: config.gateway.tls,
    });
    try {
      await ipv6.listen();
      gateways.push(ipv6);
    } catch (error) {
      if (
        !["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(
          error instanceof Error && "code" in error ? String(error.code) : "",
        )
      )
        throw error;
    }
    await listen(control, config.gateway.controlPort);
    atomicJson(registryPath, {
      protocol: PROTOCOL,
      token,
      controlPort: config.gateway.controlPort,
      pid: process.pid,
    });
    idle = setTimeout(() => void shutdown(), 10000);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await done;
  } finally {
    await shutdown();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
