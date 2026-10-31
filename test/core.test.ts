import type {
  Server as HttpServer,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
  IncomingMessage,
} from "node:http";
import type { Server } from "node:net";
import type { JsonValue } from "#production/types";
function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
// Invalid inputs intentionally cross the same untyped boundary as JS callers.
function normalizeInvalid(value: JsonValue | object): void {
  Reflect.apply(normalizeManifest, undefined, [value]);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.once("end", () => resolve(body));
    req.once("error", reject);
  });
}
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableName,
  configuration,
  createGateway,
  discoverManifest,
  loadManifest,
  loadManifestWithSource,
  namedOrigin,
  normalizeManifest,
  manifestDiagnostics,
  reservePorts,
  safeEnvironment,
  serviceCommand,
  worktreeName,
  connectShared,
  PROTOCOL,
} from "#production/core";

import { planProvenance } from "#production/plan";

export async function close(server: Server | HttpServer) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}
export async function request(
  port: number,
  path = "/",
  {
    host = "feature.localhost:3000",
    method = "GET",
    headers = {},
    body,
  }: {
    host?: string;
    method?: string;
    headers?: OutgoingHttpHeaders;
    body?: string;
  } = {},
) {
  return new Promise<{
    status: number | undefined;
    headers: IncomingHttpHeaders;
    body: string;
  }>((accept, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host, connection: "close", ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
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
    const firstService = manifest.services[0];
    assert.ok(firstService);
    assert.deepEqual(serviceCommand(firstService, { port: "10001" }), {
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
      assert.throws(() => normalizeInvalid({ services: [service] }));
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
test("manifest version and raw field types fail before launch with value-free diagnostics", () => {
  const service = { name: "web", command: "node" };
  const base = { services: [service] };
  assert.equal(normalizeManifest(base).schemaVersion, 1);
  for (const config of [
    null,
    [],
    "secret-value",
    { ...base, schemaVersion: 2 },
    ...["gateway", "worktree", "auth", "backend"].flatMap((key) =>
      [null, [], "secret-value"].map((value) => ({ ...base, [key]: value })),
    ),
    { ...base, services: [null] },
    { ...base, services: "secret-value" },
    ...[
      { args: null },
      { args: [42] },
      { cwd: 12 },
      { env: [] },
      { env: { TOKEN: 42 } },
      { excludeEnv: "TOKEN" },
      { excludeEnv: [12] },
      { ready: "secret-value" },
      { ready: { type: "tpc" } },
      { ready: { path: "secret-value" } },
      { ready: { path: "/health with space" } },
      { ready: { status: "200" } },
      { ready: { status: 600 } },
      { ready: { timeout: 0 } },
      { ready: { timeout: Infinity } },
    ].map((fields) => ({ services: [{ ...service, ...fields }] })),
    {
      ...base,
      backend: { mode: "shared", command: "node", args: "secret-value" },
    },
    {
      ...base,
      auth: { mode: "callback", upstream: "https://", pathPrefix: "/" },
    },
    { ...base, auth: { pathPrefix: 42 } },
    { ...base, auth: { callbackPath: "secret-value" } },
    { ...base, backend: { mode: null } },
    { ...base, auth: { mode: null } },
  ]) {
    assert.throws(
      () => normalizeInvalid(config),
      (error) =>
        error instanceof Error &&
        !(error instanceof TypeError) &&
        !error.message.includes("secret-value"),
    );
  }
  const config = normalizeManifest({
    ...base,
    schemaVersion: 1,
    gateway: { ...{ prot: "secret-value" }, port: 3000 },
    ...{ extension: { token: "secret-value" } },
    services: [
      { ...service, ready: { ...{ timeuot: "secret-value" }, type: "http" } },
    ],
  });
  const diagnostics = manifestDiagnostics(config);
  assert.deepEqual(diagnostics, [
    { code: "unknown-field", path: 'manifest["extension"]' },
    { code: "unknown-field", path: 'gateway["prot"]' },
    { code: "unknown-field", path: 'services[0].ready["timeuot"]' },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("secret-value"), false);
  const preserved: JsonValue = JSON.parse(JSON.stringify(config));
  assert.ok(
    preserved && typeof preserved === "object" && !Array.isArray(preserved),
  );
  assert.deepEqual(preserved["extension"], { token: "secret-value" });
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
      assert.ok(config.services[0]?.args?.includes("{port}"));
      assert.equal(
        await import("node:fs/promises").then((fs) =>
          fs.readFile(join(directory, "package.json"), "utf8"),
        ),
        pkg,
      );
    }
    for (const script of [
      "turbo run dev",
      "wireit",
      "pnpm -r --parallel dev",
      "pnpm --recursive dev",
      "concurrently vite node api.js",
    ]) {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ scripts: { dev: script } }),
      );
      assert.throws(() => discoverManifest(directory), /orchestrator/);
    }
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { dev: "portless run --tls vite" } }),
    );
    assert.throws(
      () => discoverManifest(directory),
      /Unsupported Portless wrapper/,
    );
    const nested = join(directory, "packages", "web");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.26.0" }),
    );
    await writeFile(
      join(nested, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } }),
    );
    assert.equal(
      discoverManifest(nested).services[0]?.command,
      "pnpm",
      "Workspace packages inherit the root package manager",
    );
    await writeFile(
      join(nested, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "ASTRO_DEV_BACKGROUND=1 pnpm exec astro dev --ignore-lock --port ${PORT:-5184}",
        },
      }),
    );
    const astro = discoverManifest(nested).services[0];
    assert.deepEqual(
      astro?.args,
      ["run", "dev", "--host", "127.0.0.1"],
      "An existing PORT binding must not receive a duplicate Astro --port flag",
    );
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
    safeEnvironment(source, {}, { exclude: ["API_TOKEN"] })["API_TOKEN"],
    undefined,
  );
  assert.equal(source.API_TOKEN, "test-only");
});
test("service listeners release while ownership lock stays leased", async () => {
  const lock = createNetServer().listen(0, "127.0.0.1");
  await once(lock, "listening");
  const port = portOf(lock);
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
    const body = await readBody(req);
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
  app.on("upgrade", (_req, socket, head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway({
    routes: new Map([["feature.localhost", portOf(app)]]),
    port: 0,
  });
  await gateway.listen();
  const port = portOf(gateway.server);
  try {
    const result = await request(port, "/api/auth/test?state=opaque", {
      method: "POST",
      headers: { origin: "http://feature.localhost:3000" },
      body: "test=body",
    });
    assert.equal(result.status, 302);
    assert.equal(result.headers["set-cookie"]?.length, 2);
    assert.equal(result.headers.location, "/same-origin");
    assert.deepEqual(JSON.parse(result.body), {
      host: "feature.localhost:3000",
      path: "/api/auth/test?state=opaque",
      body: "test=body",
      origin: "http://feature.localhost:3000",
    });
    const output = await new Promise<string>((accept, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () =>
        socket.write(
          "GET /socket HTTP/1.1\r\nHost: feature.localhost:3000\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhead-byte",
        ),
      );
      let data = "";
      socket.on("data", (chunk: Buffer) => {
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

test("gateway keeps absolute local redirects on the named worktree", async () => {
  let gatewayPort: number;
  const app = createServer((_req, res) =>
    res
      .writeHead(302, {
        location: `http://localhost:${gatewayPort}/after-sign-in?ok=1`,
      })
      .end(),
  );
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway({
    routes: new Map([["feature.localhost", portOf(app)]]),
    port: 0,
  });
  await gateway.listen();
  const port = portOf(gateway.server);
  gatewayPort = port;
  try {
    const result = await request(port, "/auth/callback", {
      headers: { host: `feature.localhost:${port}` },
    });
    assert.equal(result.status, 302);
    assert.equal(
      result.headers.location,
      `http://feature.localhost:${port}/after-sign-in?ok=1`,
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("gateway leaves external absolute redirects unchanged", async () => {
  const app = createServer((_req, res) =>
    res
      .writeHead(302, {
        location: "https://accounts.google.com/o/oauth2/v2/auth",
      })
      .end(),
  );
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway({
    routes: new Map([["feature.localhost", portOf(app)]]),
    port: 0,
  });
  await gateway.listen();
  const port = portOf(gateway.server);
  try {
    const result = await request(port, "/auth/sign-in", {
      headers: { host: `feature.localhost:${port}` },
    });
    assert.equal(
      result.headers.location,
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("local sign-in and sign-out redirects stay isolated per named worktree", async () => {
  let gatewayPort: number;
  const app = createServer((req, res) => {
    const destination = req.url?.startsWith("/sign-in")
      ? "/after-sign-in?callbackUrl=%2F"
      : "/after-sign-out";
    res
      .writeHead(303, {
        location: `http://localhost:${gatewayPort}${destination}`,
      })
      .end();
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway({
    routes: new Map([
      ["alpha.localhost", portOf(app)],
      ["beta.localhost", portOf(app)],
    ]),
    port: 0,
  });
  await gateway.listen();
  const port = portOf(gateway.server);
  gatewayPort = port;
  try {
    for (const name of ["alpha", "beta"]) {
      for (const path of ["/sign-in", "/sign-out"]) {
        const result = await request(port, path, {
          headers: { host: `${name}.localhost:${port}` },
        });
        assert.equal(
          new URL(result.headers.location ?? "").hostname,
          `${name}.localhost`,
        );
        assert.equal(new URL(result.headers.location ?? "").port, String(port));
      }
    }
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const lease = await connectShared({
      port: portOf(server),
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
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      connectShared({ port: portOf(foreign), request: {} }),
      /another application/,
    );
  } finally {
    await close(foreign);
  }
});
test("control registration cancels without leaking the peer socket", async () => {
  const server = createNetServer((socket) => socket.resume());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const lease = connectShared({
    port: portOf(server),
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const lease = await connectShared({
      port: portOf(server),
      request: {},
    });
    assert.equal(lease.name, "feature-世界");
    lease.socket.destroy();
  } finally {
    await close(server);
  }
});

test("literal Portless wrappers unwrap without running scripts or changing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benzo-portless-"));
  try {
    for (const script of [
      "portless run vite",
      "portless run -- vite --strictPort",
      "portless app next dev --turbopack",
      "portless run --name app next dev",
    ]) {
      const source = JSON.stringify({ scripts: { dev: script } });
      await writeFile(join(directory, "package.json"), source);
      const config = discoverManifest(directory);
      assert.equal(config.discovery, "portless-literal");
      assert.ok(["vite", "next"].includes(config.services[0]?.command ?? ""));
      assert.ok(config.services[0]?.args?.includes("{port}"));
      assert.equal(
        await import("node:fs/promises").then((fs) =>
          fs.readFile(join(directory, "package.json"), "utf8"),
        ),
        source,
      );
      assert.match(config.warnings?.[0] ?? "", /HTTP/);
    }
    for (const dev of [
      "portless run next dev\nnode setup.js",
      "portless run vite\r\nnode setup.js",
      "portless run vite\rnode setup.js",
      "portless run --tls vite",
      "portless run vite --port 5173",
      "portless run vite && echo changed",
      "portless run vite $ARGS",
      "portless run node custom.js",
      "portless run vite build",
      "portless proxy start",
      "portless app next build",
    ]) {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ scripts: { dev } }),
      );
      assert.throws(() => discoverManifest(directory), /Unsupported Portless/);
    }
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: { dev: "portless run vite", predev: "node setup.js" },
      }),
    );
    assert.throws(() => discoverManifest(directory), /Unsupported Portless/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("launch provenance distinguishes explicit defaults, discovery and derived control ports", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "benzo-provenance-"));
  const options = { env: {} };
  try {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { dev: "node server.cjs" },
        benzo: {
          gateway: { port: 3000 },
          services: [
            { name: "web", command: "node", ready: { timeout: 120000 } },
          ],
        },
      }),
    );
    let loaded = loadManifestWithSource(cwd);
    let provenance = planProvenance(loaded.input, loaded.source, options);
    assert.equal(provenance.gateway.port, "package");
    assert.equal(provenance.gateway.controlPort, "derived:gateway.port");
    assert.equal(provenance.services[0]?.ready["timeout"], "package");
    assert.equal(provenance.services[0]?.ready["type"], "default");
    loaded = loadManifestWithSource(cwd, undefined, {
      command: "python",
      args: ["-m", "http.server", "{port}"],
    });
    provenance = planProvenance(loaded.input, loaded.source, options);
    assert.equal(provenance.services[0]?.command, "command");
    assert.equal(provenance.gateway.port, "default");
    await writeFile(
      join(cwd, "external.json"),
      JSON.stringify({
        name: "configured",
        gateway: { port: 4321, controlPort: 4320 },
        services: [{ name: "api", command: "node" }],
      }),
    );
    loaded = loadManifestWithSource(cwd, "external.json");
    provenance = planProvenance(loaded.input, loaded.source, options);
    assert.equal(provenance.requestedName, "explicit-manifest");
    assert.equal(provenance.gateway.controlPort, "explicit-manifest");
    assert.equal(loaded.config.gateway.controlPort, 4320);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("environment provenance matches exclusion then runtime then configured override order without values", () => {
  const inherited = {
    KEEP: "inherited-secret",
    DROP: "excluded-secret",
    RESTORE: "old-secret",
    PORT: "9000",
    PATH: "/private/path",
  };
  const input = {
    services: [
      {
        name: "web",
        command: "secret-command",
        excludeEnv: ["DROP", "RESTORE", "PORT"],
        env: {
          RESTORE: "configured-secret",
          PORT: "1234",
          CUSTOM: "custom-secret",
        },
      },
    ],
  };
  const options = { env: { PORT: "5678", CLI: "cli-secret" } };
  const plan = planProvenance(
    input,
    { kind: "explicit-manifest" },
    options,
    inherited,
  );
  assert.deepEqual(plan.services[0]?.env, {
    BENZO_NAME: "runtime-allocation",
    BENZO_ORIGIN: "runtime-allocation",
    CLI: "--env",
    CUSTOM: "explicit-manifest",
    KEEP: "inherited-process",
    PATH: "inherited-process",
    PORT: "--env",
    RESTORE: "explicit-manifest",
  });
  assert.deepEqual(plan.services[0]?.excludedInheritedKeys, [
    "DROP",
    "PORT",
    "RESTORE",
  ]);
  assert.equal(JSON.stringify(plan).includes("secret"), false);
  assert.equal(JSON.stringify(plan).includes("/private/path"), false);
  assert.deepEqual(inherited, {
    KEEP: "inherited-secret",
    DROP: "excluded-secret",
    RESTORE: "old-secret",
    PORT: "9000",
    PATH: "/private/path",
  });
  const empty = planProvenance(
    { services: [{ name: "web", command: "node" }] },
    { kind: "command" },
    { env: {} },
    {},
  );
  assert.equal(empty.services[0]?.env["PORT"], "runtime-allocation");
});

test("readiness and auth enums reject coercible arrays", () => {
  for (const ready of [{ type: ["tcp"] }, { type: ["http"] }])
    assert.throws(() =>
      normalizeInvalid({ services: [{ name: "web", command: "node", ready }] }),
    );
  for (const auth of [{ mode: ["relay"] }, { mode: ["callback"] }])
    assert.throws(() =>
      normalizeInvalid({ services: [{ name: "web", command: "node" }], auth }),
    );
});

test("control response rejects malformed declared fields", async () => {
  for (const fields of [
    { name: [] },
    { name: "feature", transport: 42 },
    { name: "feature", transport: null },
    { name: "feature", error: 42 },
    { name: "feature", error: null },
  ]) {
    const server = createNetServer((socket) =>
      socket.once("data", () =>
        socket.end(
          JSON.stringify({ protocol: PROTOCOL, ready: true, ...fields }) + "\n",
        ),
      ),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await assert.rejects(
        connectShared({ port: portOf(server) }),
        /Invalid Benzo gateway response/,
      );
    } finally {
      await close(server);
    }
  }
});

test("private gateway launch validates serialized TLS without dropping options", async () => {
  const { gatewayLaunch } = await import("#production/wire");
  const launch = {
    gateway: { port: 3000, controlPort: 3001 },
    ownerProject: "/project",
  };
  assert.deepEqual(gatewayLaunch(JSON.stringify(launch)), launch);
  const tls = {
    cert: "certificate",
    key: "private-key",
    minVersion: "TLSv1.2",
  };
  assert.deepEqual(
    gatewayLaunch(
      JSON.stringify({ ...launch, gateway: { ...launch.gateway, tls } }),
    ).gateway.tls,
    tls,
  );
  for (const bad of [
    null,
    [],
    { ...launch, ownerProject: [] },
    { ...launch, transport: null },
    { ...launch, gateway: { port: 0, controlPort: 3001 } },
    {
      ...launch,
      gateway: { ...launch.gateway, tls: { ...tls, requestCert: true } },
    },
  ]) {
    assert.throws(() => gatewayLaunch(JSON.stringify(bad)));
  }
});

test("discovery validates package fields at root, ancestor and delegated package boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "benzo-package-decode-"));
  const nested = join(root, "app");
  await mkdir(nested);
  const write = (cwd: string, value: JsonValue) =>
    writeFile(join(cwd, "package.json"), JSON.stringify(value));
  try {
    for (const value of [
      null,
      [],
      42,
      { scripts: { dev: "vite" }, packageManager: 123 },
      { scripts: { dev: [] } },
      { scripts: [] },
      { benzo: [] },
    ]) {
      await write(root, value);
      assert.throws(
        () => discoverManifest(root),
        /Expected a JSON object|Invalid package.json field|Invalid Benzo config/,
      );
    }
    await write(root, { packageManager: 123 });
    await write(nested, { scripts: { dev: "vite" } });
    assert.throws(
      () => discoverManifest(nested),
      /Invalid package.json field packageManager/,
    );
    await write(root, { scripts: { dev: "pnpm --cwd app dev" } });
    await write(nested, { scripts: { dev: 123 } });
    assert.throws(
      () => discoverManifest(root),
      /Invalid package.json field scripts/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state JSON rejects non-object roots while preserving missing-file semantics", async () => {
  const { readJson } = await import("#production/state");
  const root = await mkdtemp(join(tmpdir(), "benzo-state-decode-"));
  const path = join(root, "state.json");
  try {
    assert.equal(readJson(path), undefined);
    for (const value of [null, [], 42, "text", true]) {
      await writeFile(path, JSON.stringify(value));
      assert.throws(() => readJson(path), /Invalid Benzo state/);
    }
    await writeFile(path, '{"nested":{"enabled":true}}');
    assert.deepEqual(readJson(path), { nested: { enabled: true } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
