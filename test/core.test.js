import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableName,
  configuration,
  createGateway,
  discoverManifest,
  loadManifest,
  namedOrigin,
  normalizeManifest,
  reservePorts,
  safeEnvironment,
  serviceCommand,
  worktreeName,
  connectShared,
  PROTOCOL,
} from "../src/core.js";

export async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}
export async function request(
  port,
  path = "/",
  { host = "feature.localhost:3000", method = "GET", headers = {}, body } = {},
) {
  return new Promise((accept, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host, connection: "close", ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          accept({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("stable names and active collision suffixes", () => {
  assert.equal(worktreeName("My Feature! "), "my-feature");
  assert.equal(worktreeName("---"), "worktree");
  assert.equal(
    availableName("feature", new Set(["feature", "feature-2"])),
    "feature-3",
  );
  assert.equal(
    availableName("feature-2", new Set(["feature", "feature-2"]), "feature"),
    "feature-3",
  );
  assert.equal(namedOrigin("feature-2"), "http://feature-2.localhost:3000");
});
test("load manifest, expand commands and validate non-overlapping leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benzo-manifest-"));
  try {
    await writeFile(
      join(directory, "benzo.config.json"),
      JSON.stringify({
        services: [
          { name: "web", command: "node", args: ["server.js", "{port}"] },
        ],
      }),
    );
    const manifest = loadManifest(directory);
    assert.equal(manifest.auth.mode, "pass-through");
    assert.deepEqual(serviceCommand(manifest.services[0], { port: "10001" }), {
      command: "node",
      args: ["server.js", "10001"],
    });
    assert.deepEqual(configuration(2, manifest), {
      slot: 2,
      lock: 10064,
      ports: { web: 10065 },
    });
    for (const service of [
      { name: "../escape", command: "node" },
      { name: "web", command: "node", args: "wrong" },
    ])
      assert.throws(() => normalizeManifest({ services: [service] }));
    assert.throws(() =>
      normalizeManifest({
        worktree: { stride: 1 },
        services: manifest.services,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("zero-config discovery preserves scripts and applies documented framework flags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benzo-discovery-"));
  try {
    for (const [script, framework] of [
      ["vite", "vite"],
      ["next dev --turbopack", "next"],
      ["nuxt dev", "nuxt"],
      ["astro dev", "astro"],
      ["pnpm exec remix vite:dev --port ${PORT:-5182}", "remix"],
    ]) {
      const pkg = JSON.stringify({ scripts: { dev: script } });
      await writeFile(join(directory, "package.json"), pkg);
      const config = discoverManifest(directory);
      assert.equal(config.discovery, framework);
      assert.ok(config.services[0].args.includes("{port}"));
      assert.equal(
        await import("node:fs/promises").then((fs) =>
          fs.readFile(join(directory, "package.json"), "utf8"),
        ),
        pkg,
      );
    }
    for (const script of ["turbo run dev", "wireit"]) {
      await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { dev: script } }));
      assert.throws(() => discoverManifest(directory), /orchestrator/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("application environments retain auth secrets and NODE_ENV; filtering is opt-in", () => {
  const source = {
    PATH: "tools",
    API_TOKEN: "test-only",
    BETTER_AUTH_SECRET: "test-only",
    GOOGLE_CLIENT_SECRET: "test-only",
    NODE_ENV: "development",
  };
  assert.deepEqual(safeEnvironment(source), source);
  assert.equal(
    safeEnvironment(source, {}, { exclude: ["API_TOKEN"] }).API_TOKEN,
    undefined,
  );
  assert.equal(source.API_TOKEN, "test-only");
});
test("service listeners release while ownership lock stays leased", async () => {
  const lock = createNetServer().listen(0, "127.0.0.1");
  await once(lock, "listening");
  const port = lock.address().port;
  await assert.rejects(reservePorts([port]), { code: "EADDRINUSE" });
  await close(lock);
  const release = await reservePorts([port, 0]);
  await release();
  await assert.rejects(reservePorts([port]), { code: "EADDRINUSE" });
  await release(true);
  const next = await reservePorts([port]);
  await next(true);
});
test("gateway preserves host, POST bytes, cookies, redirects, and websocket head bytes", async () => {
  const app = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res
      .writeHead(302, {
        location: "/same-origin",
        "set-cookie": ["session=a; HttpOnly; Path=/", "state=b; Path=/"],
      })
      .end(
        JSON.stringify({
          host: req.headers.host,
          path: req.url,
          body,
          origin: req.headers.origin,
        }),
      );
  });
  app.on("upgrade", (req, socket, head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway({
    routes: new Map([["feature.localhost", app.address().port]]),
    port: 0,
  });
  await gateway.listen();
  const port = gateway.server.address().port;
  try {
    const result = await request(port, "/api/auth/test?state=opaque", {
      method: "POST",
      headers: { origin: "http://feature.localhost:3000" },
      body: "test=body",
    });
    assert.equal(result.status, 302);
    assert.equal(result.headers["set-cookie"].length, 2);
    assert.equal(result.headers.location, "/same-origin");
    assert.deepEqual(JSON.parse(result.body), {
      host: "feature.localhost:3000",
      path: "/api/auth/test?state=opaque",
      body: "test=body",
      origin: "http://feature.localhost:3000",
    });
    const output = await new Promise((accept, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () =>
        socket.write(
          "GET /socket HTTP/1.1\r\nHost: feature.localhost:3000\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhead-byte",
        ),
      );
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("head-byte")) {
          socket.destroy();
          accept(data);
        }
      });
      socket.on("error", reject);
    });
    assert.match(output, /101 Switching Protocols/);
    assert.equal(
      (await request(port, "/", { host: "attacker.invalid" })).status,
      404,
    );
    assert.equal((await request(port, "//attacker.invalid")).status, 400);
  } finally {
    await gateway.close();
    await close(app);
  }
});
test("control registration handles fragmentation and rejects foreign services and early EOF", async () => {
  const server = createNetServer((socket) => {
    socket.once("data", () => {
      socket.write('{"protocol":"benzo/1",');
      setTimeout(() => socket.end('"ready":true,"name":"feature"}\n'), 20);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const lease = await connectShared({
      port: server.address().port,
      request: {},
    });
    assert.equal(lease.name, "feature");
    lease.socket.destroy();
  } finally {
    await close(server);
  }
  const foreign = createNetServer((socket) =>
    socket.once("data", () => socket.end('{"ready":true}\n')),
  );
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      connectShared({ port: foreign.address().port, request: {} }),
      /another application/,
    );
  } finally {
    await close(foreign);
  }
});
test("control registration cancels without leaking the peer socket", async () => {
  const server = createNetServer((socket) => socket.resume());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const lease = connectShared({
    port: server.address().port,
    request: {},
    signal: controller.signal,
  });
  const rejection = assert.rejects(lease, /Startup cancelled/);
  controller.abort();
  await rejection;
  await close(server);
});

test("persisted long collision names retain their suffix on restart", () => {
  const base = "a".repeat(50);
  assert.equal(availableName(`${base}-2`, new Set(), base), `${base}-2`);
  assert.equal(availableName(base, new Set([base]), base), `${base}-2`);
});

test("control framing preserves Unicode split across TCP chunks", async () => {
  const server = createNetServer((socket) => {
    socket.once("data", () => {
      const payload = Buffer.from(
        JSON.stringify({
          protocol: PROTOCOL,
          ready: true,
          name: "feature-世界",
        }) + "\n",
      );
      const split = payload.indexOf(Buffer.from("世")) + 1;
      socket.write(payload.subarray(0, split));
      setTimeout(() => socket.end(payload.subarray(split)), 20);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const lease = await connectShared({
      port: server.address().port,
      request: {},
    });
    assert.equal(lease.name, "feature-世界");
    lease.socket.destroy();
  } finally {
    await close(server);
  }
});
