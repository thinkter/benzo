import { createServer } from "node:net";
import { createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

const daemonEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
export function gatewayDirectory(port) {
  return join(homeDirectory(), "gateways", String(port));
}
export async function acquireGateway(config, request, { signal } = {}) {
  const directory = gatewayDirectory(config.gateway.port);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "gateway.json");
  const lock = join(directory, "starting");
  let starter = false;
  let child;
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Startup cancelled.");
      const registry = readJson(path);
      if (registry) {
        if (registry.controlPort !== config.gateway.controlPort)
          throw new Error(
            "This gateway already uses a different control port. Use its controlPort or choose a different gateway port.",
          );
        try {
          return await connectShared({
            port: registry.controlPort,
            request: { ...request, token: registry.token },
            signal,
            timeout: 2000,
          });
        } catch (error) {
          if (!["ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error;
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
          child.stderr.on("data", (chunk) => {
            diagnostic = `${diagnostic}${chunk}`.slice(-2048);
          });
          child.failure = new Promise((accept) => {
            child.once("error", (error) => accept(error));
            child.once("exit", () =>
              accept(
                new Error(
                  diagnostic.trim() ||
                    "Gateway failed to start. A gateway or control port may already be occupied.",
                ),
              ),
            );
          });
          child.stdin.end(
            JSON.stringify({
              gateway: config.gateway,
              ownerProject: request.project,
            }),
          );
          child.stdin.on("error", () => {});
          child.unref();
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          try {
            if (Date.now() - statSync(lock).mtimeMs > 20000)
              rmSync(lock, { recursive: true });
          } catch {}
        }
      }
      if (child) {
        const failure = await Promise.race([
          child.failure,
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

export async function runGateway(config) {
  const directory = gatewayDirectory(config.gateway.port);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registryPath = join(directory, "gateway.json");
  const token = randomUUID();
  const routes = new Map();
  const peers = new Map();
  const pendingSockets = new Set();
  const backends = new Map();
  const callbackStore = new Map();
  const gateways = [
    createGateway({ routes, port: config.gateway.port, callbackStore }),
  ];
  let idle;
  let stopping;
  let resolveDone;
  const done = new Promise((accept) => {
    resolveDone = accept;
  });
  const control = createServer((socket) => {
    pendingSockets.add(socket);
    socket.on("error", () => {});
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("close", () => pendingSockets.delete(socket));
    const reject = (message) =>
      socket.end(`${JSON.stringify({ protocol: PROTOCOL, error: message })}\n`);
    receiveMessage(
      socket,
      async (request) => {
        try {
          if (request.protocol !== PROTOCOL || request.token !== token)
            return reject("Incompatible or unauthorized gateway registration.");
          if (request.action === "own" || request.action === "released") {
            const peer = [...peers.values()].find(
              (value) => value.socket === socket,
            );
            if (!peer) return reject("No active lease.");
            if (request.action === "released") {
              peer.children.clear();
              return;
            }
            if (!Number.isInteger(request.pid) || request.pid < 1)
              return reject("Invalid child process.");
            peer.children.add(request.pid);
            return;
          }
          if (request.action === "ping")
            return socket.end(
              `${JSON.stringify({ protocol: PROTOCOL, ready: true })}\n`,
            );
          const cwd = canonicalPath(request.worktree);
          if (peers.has(cwd))
            return reject(
              "This worktree already has a running Benzo launcher. Use benzo urls or benzo stop.",
            );
          if (
            !Array.isArray(request.services) ||
            !request.services.length ||
            request.services.length > 100
          )
            return reject("Invalid service registration.");
          for (const service of request.services)
            if (
              !/^[a-z][a-z0-9-]{0,49}$/.test(service.name) ||
              !Number.isInteger(service.port) ||
              service.port < 1 ||
              service.port > 65535
            )
              return reject("Invalid service registration.");
          const name = availableName(
            request.name,
            new Set([...peers.values()].map((peer) => peer.name)),
            request.baseName ?? basename(cwd),
          );
          const peer = {
            socket,
            name,
            project: request.project,
            hosts: [],
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
          for (const [index, service] of request.services.entries()) {
            const host = `${index ? `${service.name}.` : ""}${name}.localhost`;
            if (routes.has(host))
              throw new Error("Conflicting service hostname.");
            routes.set(host, {
              port: service.port,
              auth: request.auth ?? { mode: "pass-through" },
            });
            peer.hosts.push(host);
          }
          if (request.backend?.mode === "shared") {
            if (request.project !== config.ownerProject)
              throw new Error(
                "This gateway was started from another project. Use a separate --gateway-port for this shared backend so it inherits the correct environment.",
              );
            const manifest = loadManifest(
              cwd,
              request.config,
              request.discovery,
            );
            const identity = hash(JSON.stringify(manifest.backend));
            const existing = backends.get(request.project);
            if (existing && existing.identity !== identity)
              throw new Error(
                "Shared backend configuration differs across worktrees.",
              );
            if (!existing) {
              const backend = manifest.backend;
              const child = launch(
                backend.command,
                backend.args ?? [],
                join(cwd, backend.cwd ?? "."),
                { ...process.env, ...backend.env },
              );
              const stream = createWriteStream(
                join(directory, `backend-${request.project}.log`),
                { flags: "a", mode: 0o600 },
              );
              for (const pipe of [child.stdout, child.stderr])
                pipe.on("data", (chunk) =>
                  stream.write(chunk.toString().replace(/\x1b\[[0-9;]*m/g, "")),
                );
              const failBackend = () => {
                stream.end();
                backends.delete(request.project);
                if (!stopping)
                  for (const active of peers.values())
                    if (active.project === request.project)
                      active.socket.destroy();
              };
              stream.on("error", failBackend);
              child.once("error", failBackend);
              child.once("exit", failBackend);
              backends.set(request.project, { child, stream, identity });
            }
          }
          if (!socket.destroyed)
            socket.write(
              `${JSON.stringify({ protocol: PROTOCOL, ready: true, name, gatewayPort: config.gateway.port })}\n`,
            );
        } catch (error) {
          reject(error.message);
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
      if (readJson(registryPath)?.token === token)
        rmSync(registryPath, { force: true });
      resolveDone();
    })());
  }
  const onSignal = () => void shutdown();
  try {
    try {
      await gateways[0].listen();
    } catch (error) {
      if (error.code === "EADDRINUSE")
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
    });
    try {
      await ipv6.listen();
      gateways.push(ipv6);
    } catch (error) {
      if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) throw error;
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
