import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { runGateway, gatewayDirectory } from "#production/daemon";
import { connectShared, PROTOCOL } from "#production/protocol";
import { jsonObject } from "#production/wire";
import { writeState } from "#production/state";
import { runClient } from "#production/client";
import { stop } from "#production/process";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(20);
  }
  throw new Error("Fixture did not become ready.");
}
function restoreHome(home: string | undefined): void {
  if (home === undefined) delete process.env["BENZO_HOME"];
  else process.env["BENZO_HOME"] = home;
}

test(
  "lease cleanup failure is reported without disrupting another worktree",
  {
    skip: process.platform === "win32",
    timeout: 15000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "benzo-cleanup-peer-"));
    const oldHome = process.env["BENZO_HOME"];
    process.env["BENZO_HOME"] = join(root, "home");
    const app = createServer((_req, res) => res.end("peer alive"));
    const sockets: Socket[] = [];
    const messages: string[] = [];
    const deniedPid = 123456789;
    const originalKill = process.kill.bind(process);
    const kill = t.mock.method(
      process,
      "kill",
      (pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === -deniedPid)
          throw Object.assign(new Error("fixture EPERM"), { code: "EPERM" });
        return originalKill(pid, signal);
      },
    );
    const log = t.mock.method(console, "error", (...args: object[]) => {
      messages.push(args.map(String).join(" "));
    });
    let done: Promise<void> | undefined;
    try {
      const upstream = await listen(app);
      const port = await unusedPort(),
        controlPort = await unusedPort();
      done = runGateway({
        gateway: { port, controlPort },
        ownerProject: "fixture",
      });
      // Observe startup failures immediately while waiting for the registry.
      let startupFailure: Error | undefined;
      void done.catch((error: Error) => {
        startupFailure = error;
      });
      const token = await until(async () => {
        if (startupFailure) throw startupFailure;
        try {
          const registry = jsonObject(
            await readFile(
              join(gatewayDirectory(port), "gateway.json"),
              "utf8",
            ),
          );
          const value = registry["token"];
          assert.equal(typeof value, "string");
          return typeof value === "string" ? value : undefined;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return undefined;
          throw error;
        }
      });
      for (const name of ["first", "second"]) {
        const worktree = join(root, name);
        await mkdir(worktree);
        const lease = await connectShared({
          port: controlPort,
          request: {
            token,
            worktree,
            project: "fixture",
            name,
            services: [{ name: "web", port: upstream }],
          },
        });
        sockets.push(lease.socket);
      }
      const first = sockets[0];
      assert.ok(first);
      first.end(
        JSON.stringify({
          protocol: PROTOCOL,
          token,
          action: "own",
          pid: deniedPid,
        }) + "\n",
      );
      await until(async () =>
        messages.some((message) => message.includes("fixture EPERM"))
          ? true
          : undefined,
      );
      const response = await new Promise<string>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            headers: { host: "second.localhost", connection: "close" },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on("end", () => resolve(body));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(response, "peer alive");
      const ping = await connectShared({
        port: controlPort,
        request: {
          token,
          worktree: join(root, "first"),
          project: "fixture",
          name: "first",
          services: [{ name: "web", port: upstream }],
        },
      });
      ping.socket.destroy();
      assert.equal(ping.ready, true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await done;
      kill.mock.restore();
      log.mock.restore();
      await close(app);
      restoreHome(oldHome);
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    "exec propagates cleanup failure after " +
      signal +
      " and removes signal handlers",
    {
      skip: process.platform === "win32",
      timeout: 15000,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "benzo-cleanup-client-"));
      const oldHome = process.env["BENZO_HOME"];
      process.env["BENZO_HOME"] = join(root, "home");
      let controlPort = 0;
      const server = createServer((_req, res) =>
        res.end(
          JSON.stringify({
            protocol: PROTOCOL,
            slot: 0,
            ports: { web: 10001 },
            urls: { web: "http://feature.localhost:3000" },
            logs: {},
            controlPort,
            gateway: 3000,
            instanceId: "instance",
            projectId: "project",
            worktreeId: "worktree",
            name: "feature",
            status: "ready",
            startedAt: new Date().toISOString(),
          }),
        ),
      );
      const originalKill = process.kill.bind(process);
      const failure = Object.assign(new Error("fixture cleanup denied"), {
        code: "EPERM",
      });
      const kill = t.mock.method(
        process,
        "kill",
        (pid: number, sig?: number | NodeJS.Signals) => {
          if (pid < 0) throw failure;
          return originalKill(pid, sig);
        },
      );
      const before = process.listenerCount(signal);
      let pid: number | undefined;
      try {
        controlPort = await listen(server);
        writeState(root, { controlPort, token: "fixture" });
        const running = runClient({
          cwd: root,
          command: process.execPath,
          args: [
            "-e",
            'require("node:fs").writeFileSync("child-pid", String(process.pid)); setInterval(() => {}, 1000);',
          ],
        });
        // Attach rejection handling before emitting a signal.
        const rejected = assert.rejects(
          running,
          (error: Error) => error === failure,
        );
        pid = await until(async () => {
          try {
            return Number(await readFile(join(root, "child-pid"), "utf8"));
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return undefined;
            throw error;
          }
        });
        process.emit(signal);
        await rejected;
        assert.equal(process.listenerCount(signal), before);
      } finally {
        kill.mock.restore();
        if (pid !== undefined) {
          await stop(pid, { timeout: 0 });
        }
        await close(server);
        restoreHome(oldHome);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    "production CLI exits on " +
      signal +
      " cleanup failure before its child is cleaned up",
    {
      skip: process.platform === "win32",
      timeout: 15000,
    },
    async () => {
      const { spawn } = await import("node:child_process");
      const { writeFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const { pathToFileURL } = await import("node:url");
      const root = await mkdtemp(join(tmpdir(), "benzo-cli-cleanup-"));
      const oldHome = process.env["BENZO_HOME"];
      const home = join(root, "home");
      process.env["BENZO_HOME"] = home;
      let controlPort = 0;
      const server = createServer((_req, res) =>
        res.end(
          JSON.stringify({
            protocol: PROTOCOL,
            slot: 0,
            ports: { web: 10001 },
            urls: { web: "http://feature.localhost:3000" },
            logs: {},
            controlPort,
            gateway: 3000,
            instanceId: "instance",
            projectId: "project",
            worktreeId: "worktree",
            name: "feature",
            status: "ready",
            startedAt: new Date().toISOString(),
          }),
        ),
      );
      let childPid: number | undefined;
      let cli: ReturnType<typeof spawn> | undefined;
      let exited: Promise<number | null> | undefined;
      try {
        controlPort = await listen(server);
        writeState(root, { controlPort, token: "fixture" });
        const preload = join(root, "deny-kill.mjs");
        await writeFile(
          preload,
          'const kill = process.kill.bind(process); process.kill = (pid, signal) => { if (pid < 0) throw Object.assign(new Error("fixture EPERM"), {code: "EPERM"}); return kill(pid, signal); };',
        );
        cli = spawn(
          process.execPath,
          [
            "--import",
            pathToFileURL(preload).href,
            resolve("dist/cli.js"),
            "exec",
            "--cwd",
            root,
            "--",
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync("child-pid", String(process.pid)); setInterval(() => {}, 1000);',
          ],
          {
            env: { ...process.env, BENZO_HOME: home },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderr = "";
        cli.stdout?.resume();
        cli.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        exited = new Promise<number | null>((accept, reject) => {
          cli?.once("error", reject);
          cli?.once("exit", (code) => accept(code));
        });
        childPid = await until(async () => {
          try {
            return Number(await readFile(join(root, "child-pid"), "utf8"));
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return undefined;
            throw error;
          }
        });
        cli.kill(signal);
        let timer: NodeJS.Timeout | undefined;
        try {
          const code = await Promise.race([
            exited,
            new Promise<never>((_accept, reject) => {
              timer = setTimeout(
                () => reject(new Error("CLI hung after cleanup failure")),
                3000,
              );
            }),
          ]);
          assert.equal(code, 1);
          assert.match(stderr, /fixture EPERM/);
          // Assert before finally: CLI must exit while the unkillable fixture lives.
          assert.equal(process.kill(childPid, 0), true);
        } finally {
          clearTimeout(timer);
        }
      } finally {
        if (childPid !== undefined) await stop(childPid, { timeout: 0 });
        if (cli && cli.exitCode === null && cli.signalCode === null)
          cli.kill("SIGKILL");
        await exited;
        cli?.stdout?.destroy();
        cli?.stderr?.destroy();
        await close(server);
        restoreHome(oldHome);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
