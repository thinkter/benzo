import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireGateway, gatewayDirectory } from "./daemon.js";
import {
  canonicalPath,
  configuration,
  expand,
  launch,
  logLine,
  namedOrigins,
  projectIdentity,
  readPreferences,
  readJson,
  readState,
  removeState,
  reservePorts,
  safeEnvironment,
  serviceCommand,
  stateDirectory,
  stop,
  worktreeName,
  writeLastState,
  writePreferences,
  writeState,
} from "./core.js";
import { listen } from "./gateway.js";

export function supervisorRequest(state, action = "status", timeout = 2000) {
  return new Promise((accept, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: state.controlPort,
        path: `/${action}`,
        method: action === "stop" ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${state.token}`,
          connection: "close",
        },
        timeout,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200)
            return reject(new Error("Benzo supervisor authentication failed."));
          try {
            accept(JSON.parse(body));
          } catch {
            reject(new Error("Invalid supervisor response."));
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Benzo supervisor did not respond.")),
    );
    request.end();
  });
}
export async function liveState(cwd) {
  const state = readState(cwd);
  if (!state) return undefined;
  try {
    return { ...(await supervisorRequest(state)), token: state.token };
  } catch {
    return undefined;
  }
}
async function probe(port, service, signal) {
  if (service.ready?.type === "tcp")
    return new Promise((accept, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        accept();
      });
      socket.once("error", reject);
      socket.setTimeout(1000, () =>
        socket.destroy(new Error("Readiness timeout.")),
      );
      const abort = () => socket.destroy(new Error("Startup cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => signal.removeEventListener("abort", abort));
    });
  return new Promise((accept, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: service.ready?.path ?? "/",
        timeout: 1500,
        signal,
        headers: { connection: "close" },
      },
      (response) => {
        response.resume();
        const expected = service.ready?.status;
        if (
          expected
            ? response.statusCode === expected
            : response.statusCode < 500
        )
          accept();
        else reject(new Error(`HTTP ${response.statusCode}`));
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Readiness timeout.")),
    );
    request.end();
  });
}
export async function runDev(cwd, config, options = {}) {
  cwd = canonicalPath(cwd);
  if (await liveState(cwd))
    throw new Error(
      "This worktree is already running. Use benzo urls or benzo stop.",
    );
  const preferred = readPreferences(cwd);
  const cancellation = new AbortController();
  const children = [];
  const streams = [];
  let reservation;
  let lease;
  let state;
  let failure;
  let shutdownPromise;
  let resolveDone;
  const done = new Promise((accept) => {
    resolveDone = accept;
  });
  const token = randomUUID();
  const supervisor = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`)
      return response.writeHead(403).end();
    if (request.url === "/status" && request.method === "GET")
      return response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(publicState(state)));
    if (request.url === "/stop" && request.method === "POST") {
      response.writeHead(200).end("{}");
      setImmediate(() => void shutdown());
      return;
    }
    response.writeHead(404).end();
  });
  function shutdown() {
    return (shutdownPromise ??= (async () => {
      cancellation.abort();
      await Promise.all(children.map((child) => stop(child)));
      for (const stream of streams)
        await new Promise((accept) => stream.end(accept));
      if (lease && !lease.socket.destroyed) {
        const registry = readJson(
          join(gatewayDirectory(config.gateway.port), "gateway.json"),
        );
        lease.socket.write(
          `${JSON.stringify({ protocol: "benzo/1", token: registry?.token, action: "released" })}\n`,
        );
        lease.socket.end();
      }
      await reservation?.(true);
      await new Promise((accept) => {
        supervisor.close(() => accept());
        supervisor.closeAllConnections();
      });
      if (state && readState(cwd)?.token === token) {
        writeLastState(cwd, {
          ...publicState(state),
          status: failure ? "failed" : "stopped",
        });
        removeState(cwd);
      }
      resolveDone();
    })());
  }
  const onSignal = () => void shutdown();
  const failed = (error) => {
    if (cancellation.signal.aborted) return;
    failure ??= error;
    void shutdown();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const slots = Array.from(
      { length: config.worktree.slots },
      (_, index) => index,
    );
    if (preferred?.slot < slots.length) slots.unshift(preferred.slot);
    let allocation;
    for (const slot of new Set(slots)) {
      try {
        allocation = configuration(slot, config);
        reservation = await reservePorts([
          allocation.lock,
          ...Object.values(allocation.ports),
        ]);
        break;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
      }
    }
    if (!reservation)
      throw new Error(
        "All Benzo internal port slots are occupied. benzo doctor reports the configured range.",
      );
    if (cancellation.signal.aborted) return;
    lease = await acquireGateway(
      config,
      {
        worktree: cwd,
        project: projectIdentity(cwd),
        name:
          options.name ??
          config.name ??
          preferred?.name ??
          worktreeName(basename(cwd)),
        baseName: options.name ?? config.name ?? worktreeName(basename(cwd)),
        services: config.services.map((service) => ({
          name: service.name,
          port: allocation.ports[service.name],
        })),
        auth: config.auth,
        backend: { mode: config.backend.mode },
        config: options.config,
        discovery: options.discovery,
      },
      { signal: cancellation.signal },
    );
    lease.socket.once("close", () =>
      failed(
        new Error(
          "The shared gateway stopped. This worktree has been stopped too.",
        ),
      ),
    );
    const urls = namedOrigins(lease.name, config.services, config.gateway.port);
    await listen(supervisor, 0);
    if (cancellation.signal.aborted) return;
    state = {
      protocol: "benzo/1",
      token,
      controlPort: supervisor.address().port,
      status: "starting",
      name: lease.name,
      slot: allocation.slot,
      urls,
      ports: allocation.ports,
      logs: {},
      startedAt: new Date().toISOString(),
      gateway: config.gateway.port,
    };
    writeState(cwd, state);
    writePreferences(cwd, { slot: allocation.slot, name: lease.name });
    // Ownership stays leased while service listeners are handed to children.
    await reservation();
    for (const service of config.services) {
      if (cancellation.signal.aborted) break;
      const origin = urls[service.name];
      const port = allocation.ports[service.name];
      const context = {
        port: String(port),
        name: lease.name,
        gateway: String(config.gateway.port),
        origin,
        service: service.name,
        ...Object.fromEntries(
          Object.entries(urls).map(([key, value]) => [
            `services.${key}.origin`,
            value,
          ]),
        ),
      };
      const command = serviceCommand(service, context);
      const additions = {
        PORT: String(port),
        BENZO_NAME: lease.name,
        BENZO_ORIGIN: origin,
        ...Object.fromEntries(
          Object.entries(service.env ?? {}).map(([key, value]) => [
            key,
            expand(value, context),
          ]),
        ),
      };
      const stream = createWriteStream(
        join(stateDirectory(cwd), `${service.name}.log`),
        { flags: "a", mode: 0o600 },
      );
      streams.push(stream);
      state.logs[service.name] = stream.path;
      stream.on("error", () =>
        failed(new Error(`Cannot write ${service.name} logs.`)),
      );
      const child = launch(
        command.command,
        command.args,
        resolve(cwd, service.cwd ?? "."),
        safeEnvironment(process.env, additions, {
          exclude: service.excludeEnv,
        }),
      );
      children.push(child);
      if (child.pid) {
        const registry = readJson(
          join(gatewayDirectory(config.gateway.port), "gateway.json"),
        );
        lease.socket.write(
          `${JSON.stringify({ protocol: "benzo/1", token: registry?.token, action: "own", pid: child.pid })}\n`,
        );
      }
      for (const [pipe, output] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ])
        pipe.on("data", (chunk) => {
          logLine(chunk.toString(), undefined, stream);
          logLine(chunk.toString(), undefined, output);
        });
      child.once("error", (error) =>
        failed(
          new Error(
            `Could not launch ${service.name}: ${error.code ?? "spawn failed"}. Check that its dependencies and command are installed.`,
          ),
        ),
      );
      child.once("exit", (code, signal) =>
        failed(new Error(`${service.name} exited (${signal ?? code}).`)),
      );
      writeState(cwd, state);
    }
    await Promise.all(
      config.services.map(async (service) => {
        const deadline = Date.now() + (service.ready?.timeout ?? 120000);
        while (!cancellation.signal.aborted) {
          try {
            await probe(
              allocation.ports[service.name],
              service,
              cancellation.signal,
            );
            return;
          } catch {}
          if (Date.now() >= deadline) {
            failed(
              new Error(
                `${service.name} did not become ready on its assigned port. Check benzo logs. The server must honor PORT or a supported port argument.`,
              ),
            );
            return;
          }
          await delay(100);
        }
      }),
    );
    if (!cancellation.signal.aborted) {
      state.status = "ready";
      writeState(cwd, state);
      console.log(`\nBenzo · ${lease.name}`);
      for (const service of config.services)
        console.log(`  ${service.name}  ${urls[service.name]}`);
      console.log("Ready. Ctrl-C stops this worktree.\n");
    }
    await done;
    if (failure) throw failure;
  } finally {
    await shutdown();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
export function publicState(state) {
  if (!state) return {};
  const { token, ...safe } = state;
  return safe;
}
