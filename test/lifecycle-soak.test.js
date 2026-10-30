import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const cli = resolve("src/cli.js");
const cycles = Number(process.env.BENZO_SOAK_CYCLES ?? 8);
if (!Number.isInteger(cycles) || cycles < 2 || cycles > 1000)
  throw new Error("BENZO_SOAK_CYCLES must be an integer from 2 to 1000.");
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
async function waitFor(check) {
  const deadline = Date.now() + 15000;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (value) {
      error = value;
    }
    await delay(60);
  }
  throw error ?? new Error("Lifecycle fixture timed out");
}
function get(port, host = "localhost", path = "/") {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: { host, connection: "close" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(1000, () =>
      req.destroy(new Error("Lifecycle request timeout")),
    );
    req.end();
  });
}
async function refuses(port) {
  try {
    await get(port);
    return false;
  } catch (error) {
    return error.code === "ECONNREFUSED";
  }
}

test(
  "restart churn and gateway loss preserve peer ownership and reject stale OAuth state",
  {
    timeout: Math.max(60000, cycles * 10000),
    skip: process.platform === "win32",
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "benzo-churn-"));
    const home = join(root, "home"),
      first = join(root, "first"),
      second = join(root, "second");
    const env = { ...process.env, BENZO_HOME: home };
    const children = [];
    const foreign = createServer((_req, res) => res.end("unrelated listener"));
    const probe = createServer();
    await listen(probe);
    const port = probe.address().port;
    await close(probe);
    const call = (cwd, ...args) =>
      exec(process.execPath, [cli, ...args], { cwd, env, timeout: 10000 });
    function start(cwd) {
      const child = spawn(
        process.execPath,
        [cli, "--gateway-port", String(port)],
        { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.resume();
      child.stderr.resume();
      child.done = new Promise((resolve) => {
        child.once("error", (error) => resolve({ error }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      children.push(child);
      return child;
    }
    const ready = (cwd) =>
      waitFor(async () => {
        const descriptor = JSON.parse(
          (await call(cwd, "describe", "--json")).stdout,
        );
        return descriptor?.status === "ready" ? descriptor : undefined;
      });
    const authorise = async (descriptor) => {
      const state = randomUUID();
      assert.equal(
        (
          await get(
            port,
            new URL(descriptor.services[0].origin).host,
            `/signin?state=${state}`,
          )
        ).status,
        302,
      );
      return state;
    };
    try {
      await listen(foreign);
      const server = `const http=require('http');http.createServer((req,res)=>{const url=new URL(req.url,'http://app');if(url.pathname==='/signin'){const auth=new URL('https://provider.invalid/authorize');auth.searchParams.set('state',url.searchParams.get('state'));auth.searchParams.set('redirect_uri','http://localhost:'+new URL('http://'+req.headers.host).port+'/callback');return res.writeHead(302,{location:auth.href}).end();}res.end('alive');}).listen(Number(process.env.PORT),'127.0.0.1');`;
      for (const cwd of [first, second]) {
        await mkdir(cwd);
        await writeFile(
          join(cwd, "package.json"),
          JSON.stringify({ scripts: { dev: "node server.cjs" } }),
        );
        await writeFile(join(cwd, "server.cjs"), server);
      }
      let anchor = start(first),
        anchorState = await ready(first);
      let previousState, previousDescriptor, peer;
      const instances = new Set();
      for (let index = 0; index < cycles; index++) {
        peer = start(second);
        const current = await ready(second);
        assert.equal(instances.has(current.instanceId), false);
        instances.add(current.instanceId);
        if (previousDescriptor) {
          assert.equal(
            current.services[0].origin,
            previousDescriptor.services[0].origin,
          );
          assert.equal(
            current.services[0].upstream.port,
            previousDescriptor.services[0].upstream.port,
          );
          const stale = await get(
            port,
            `localhost:${port}`,
            `/callback?state=${previousState}&code=old`,
          );
          assert.equal(stale.status, 409);
          assert.equal(stale.headers.location, undefined);
        }
        const valid = await authorise(current);
        assert.equal(
          (
            await get(
              port,
              `localhost:${port}`,
              `/callback?state=${valid}&code=fresh`,
            )
          ).headers.location,
          `${current.services[0].origin}/callback?state=${valid}&code=fresh`,
        );
        previousState = await authorise(current);
        previousDescriptor = current;
        if (index % 2 === 0) {
          await call(second, "stop");
          assert.equal((await peer.done).code, 0);
        } else {
          peer.kill("SIGKILL");
          assert.equal((await peer.done).signal, "SIGKILL");
        }
        await waitFor(() => refuses(current.services[0].upstream.port));
        await waitFor(
          async () =>
            (await get(port, new URL(current.services[0].origin).host))
              .status === 404,
        );
        assert.equal(
          (await get(port, new URL(anchorState.services[0].origin).host)).body,
          "alive",
        );
        assert.equal(
          (await get(foreign.address().port)).body,
          "unrelated listener",
        );
      }
      peer = start(second);
      const beforeLoss = await ready(second);
      const lostState = await authorise(beforeLoss);
      const registry = JSON.parse(
        await readFile(
          join(home, "gateways", String(port), "gateway.json"),
          "utf8",
        ),
      );
      process.kill(registry.pid, "SIGKILL"); // Only this fixture's private gateway.
      assert.equal((await anchor.done).code, 1);
      assert.equal((await peer.done).code, 1);
      await waitFor(() => refuses(anchorState.services[0].upstream.port));
      await waitFor(() => refuses(beforeLoss.services[0].upstream.port));
      assert.equal(
        (await get(foreign.address().port)).body,
        "unrelated listener",
      );
      anchor = start(first);
      const restartedAnchor = await ready(first);
      peer = start(second);
      const afterLoss = await ready(second);
      assert.notEqual(restartedAnchor.instanceId, anchorState.instanceId);
      assert.notEqual(afterLoss.instanceId, beforeLoss.instanceId);
      assert.equal(afterLoss.services[0].origin, beforeLoss.services[0].origin);
      assert.equal(
        (
          await get(
            port,
            `localhost:${port}`,
            `/callback?state=${lostState}&code=old`,
          )
        ).status,
        409,
      );
      const fresh = await authorise(afterLoss);
      assert.equal(
        (
          await get(
            port,
            `localhost:${port}`,
            `/callback?state=${fresh}&code=new`,
          )
        ).status,
        307,
      );
      await call(second, "stop");
      assert.equal((await peer.done).code, 0);
      await call(first, "stop");
      assert.equal((await anchor.done).code, 0);
      await waitFor(() => refuses(afterLoss.services[0].upstream.port));
      await waitFor(() => refuses(restartedAnchor.services[0].upstream.port));
      await waitFor(() => refuses(port));
      t.diagnostic(
        `${cycles} peer restart cycles plus forced gateway restart completed; not an overnight soak.`,
      );
    } finally {
      for (const cwd of [first, second])
        await call(cwd, "stop").catch(() => {});
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        await child.done;
      }
      await close(foreign);
      await delay(1000);
      await rm(root, { recursive: true, force: true });
    }
  },
);
