import type { PublicState, GatewayConfig } from "./types.js";
import { liveState } from "./runtime.js";
import { environmentDescriptor } from "./descriptor.js";

/** Read a live authenticated snapshot; returns null when no launcher answers.
 * This does not reserve an origin, start services, or confer lifecycle ownership.
 */
export async function getEnvironment({ cwd = process.cwd() } = {}) {
  const state = await liveState(cwd);
  return state ? environmentDescriptor(state) : null;
}

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { acquireGateway, gatewayDirectory } from "./daemon.js";
import { normalizeManifest } from "./config.js";
import { canonicalPath, hash, projectIdentity, readJson } from "./state.js";
import { namedOrigins, worktreeName } from "./core.js";
import { PROTOCOL, receiveMessage } from "./protocol.js";

/** Reserve origins only. The caller owns listener startup, health checks and stop. */
export async function reserveEnvironment({
  cwd = process.cwd(),
  name,
  services = ["web"],
  gateway,
  signal,
}: {
  cwd?: string;
  name?: string;
  services?: string[];
  gateway?: GatewayConfig;
  signal?: AbortSignal;
} = {}) {
  cwd = canonicalPath(cwd);
  const config = normalizeManifest({
    gateway,
    services: services.map((name) => ({ name, command: "external" })),
  });
  const lease = await acquireGateway(
    config,
    {
      worktree: cwd,
      project: projectIdentity(cwd),
      name: name ?? worktreeName(basename(cwd)),
      baseName: name ?? worktreeName(basename(cwd)),
      services: services.map((name) => ({ name, port: 0 })),
      external: true,
      backend: { mode: "external" },
      auth: config.auth,
    },
    signal ? { signal } : {},
  );
  const registry = readJson(
    join(gatewayDirectory(config.gateway.port), "gateway.json"),
  );
  if (!registry?.["token"]) {
    lease.socket.destroy();
    throw new Error("Gateway registration disappeared.");
  }
  const state: PublicState = {
    instanceId: randomUUID(),
    projectId: projectIdentity(cwd),
    worktreeId: hash(cwd),
    name: lease.name,
    status: "starting",
    startedAt: new Date().toISOString(),
    urls: namedOrigins(
      lease.name,
      config.services,
      config.gateway.port,
      config.gateway.tls ? "https" : "http",
    ),
    ports: Object.fromEntries(services.map((name) => [name, null])),
  };
  const readiness = new Map(services.map((name) => [name, false]));
  const pending = new Map<
    string,
    { timer: NodeJS.Timeout; resolve(): void; reject(error: Error): void }
  >();
  let closed = false;
  let resolveClosed: () => void = () => {};
  const whenClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    state.status = "stopped";
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("External listener lease closed."));
    }
    pending.clear();
    signal?.removeEventListener("abort", abort);
    resolveClosed();
  };
  const abort = () => lease.socket.destroy();
  lease.socket.once("close", finish);
  signal?.addEventListener("abort", abort, { once: true });
  if (lease.socket.destroyed) finish();
  else if (signal?.aborted) abort();
  receiveMessage(
    lease.socket,
    (message) => {
      if (message["error"] || message["protocol"] !== PROTOCOL) {
        lease.socket.destroy();
        return;
      }
      if (typeof message["id"] !== "string") return;
      const entry = pending.get(message["id"]);
      if (!entry || !message["updated"]) return;
      pending.delete(message["id"]);
      clearTimeout(entry.timer);
      entry.resolve();
    },
    { multiple: true },
  );
  let queue = Promise.resolve();
  const update = (
    action: "attach" | "readiness",
    service: string,
    port: number | undefined,
    ready: boolean,
  ): Promise<void> => {
    if (!readiness.has(service))
      return Promise.reject(new Error("Unknown service on this lease."));
    if (typeof ready !== "boolean")
      return Promise.reject(new Error("Readiness must be boolean."));
    if (
      action === "attach" &&
      (typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        port === config.gateway.port ||
        port === config.gateway.controlPort)
    )
      return Promise.reject(new Error("Invalid external listener port."));
    const operation = queue.then(async () => {
      if (closed || lease.socket.destroyed)
        throw new Error("External listener lease closed.");
      if (action === "readiness" && state.ports[service] === null)
        throw new Error("Attach a listener before marking readiness.");
      const id = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          lease.socket.destroy();
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        lease.socket.write(
          `${JSON.stringify({ protocol: PROTOCOL, token: registry["token"], action, id, service, port, ready })}\n`,
        );
      });
      if (action === "attach" && port !== undefined)
        state.ports[service] = port;
      readiness.set(service, ready);
      state.status = [...readiness.values()].every(Boolean)
        ? "ready"
        : "starting";
    });
    queue = operation.catch(() => {});
    return operation;
  };
  return {
    describe() {
      const descriptor = environmentDescriptor(state);
      descriptor.owner = {
        kind: "external-orchestrator",
        lifetime: "registration-connection",
      };
      for (const service of descriptor.services)
        service.readiness =
          !closed && readiness.get(service.name) ? "ready" : "not-ready";
      return descriptor;
    },
    attach(
      service: string,
      { port, ready = false }: { port: number; ready?: boolean },
    ) {
      return update("attach", service, port, ready);
    },
    setReady(service: string, ready = true) {
      return update("readiness", service, undefined, ready);
    },
    async release() {
      lease.socket.destroy();
      await whenClosed;
    },
    closed: whenClosed,
  };
}
