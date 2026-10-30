import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { tlsFixture, secureRequest } from "./tls-fixture.js";

const exec = promisify(execFile);
const cli = resolve("src/cli.js");
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
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
  throw error ?? new Error("Timed out waiting for test condition.");
}
async function call(cwd, home, ...args) {
  return exec(process.execPath, [cli, ...args, "--cwd", cwd], {
    env: { ...process.env, BENZO_HOME: home },
    timeout: 10000,
  });
}
function start(cwd, home, port, ...args) {
  return startArgs(home, ["dev", "--cwd", cwd, "--gateway-port", String(port), ...args]);
}
function startArgs(home, args) {
  const child = spawn(
    process.execPath,
    [cli, ...args],
    {
      env: {
        ...process.env,
        BENZO_HOME: home,
        BETTER_AUTH_SECRET: "benzo-test-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.output = "";
  child.stdout.on("data", (chunk) => (child.output += chunk));
  child.stderr.on("data", (chunk) => (child.output += chunk));
  child.done = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code) => resolve({ code }));
  });
  return child;
}
async function state(cwd, home) {
  const { stdout } = await call(cwd, home, "status", "--json");
  const parsed = JSON.parse(stdout);
  return parsed.status === "ready" ? parsed : undefined;
}
function request(port, host, path = "/") {
  return new Promise((accept, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host, connection: "close" } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => accept({ status: response.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const serverCode = `const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const server = http.createServer((req,res) => { if(req.url === '/crash') { res.end('bye'); setTimeout(() => process.exit(7),20); return; } res.end(JSON.stringify({ marker: fs.readFileSync(path.join(__dirname, 'marker.txt'),'utf8'), host:req.headers.host, authConfigured:!!process.env.BETTER_AUTH_SECRET })); }); server.listen(Number(process.env.PORT),'127.0.0.1');`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "benzo-runtime-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { dev: "node server.cjs" } }),
  );
  await writeFile(join(cwd, "server.cjs"), serverCode);
  await writeFile(join(cwd, "marker.txt"), "one");
  return { root, cwd, home: join(root, "home"), port: await unusedPort() };
}
async function cleanup(f, children) {
  for (const cwd of f.worktrees ?? [f.cwd])
    await call(cwd, f.home, "stop").catch(() => {});
  await Promise.all(
    children.map(async (child) => {
      const exited = await Promise.race([
        child.done,
        delay(5000).then(() => false),
      ]);
      if (!exited) {
        child.kill("SIGTERM");
        await child.done;
      }
    }),
  );
  await delay(1000);
  await rm(f.root, { recursive: true, force: true });
}

test("bare options launch the selected script and explicit help never starts it", { timeout: 30000 }, async () => {
  const f = await fixture();
  const pkg = JSON.stringify({ scripts: { dev: "wireit", "dev:web": "node server.cjs" } });
  await writeFile(join(f.cwd, "package.json"), pkg);
  const child = startArgs(f.home, ["--cwd", f.cwd, "--gateway-port", String(f.port), "--auth-relay", "--script", "dev:web"]);
  try {
    const running = await waitFor(() => state(f.cwd, f.home));
    assert.equal((await request(f.port, new URL(running.urls.web).host)).status, 200);
    assert.equal(await readFile(join(f.cwd, "package.json"), "utf8"), pkg);
    await call(f.cwd, f.home, "stop");
    assert.equal((await child.done).code, 0);
    for (const args of [["--help"], ["--auth-relay", "--help"], ["--version"]]) {
      const result = await call(f.cwd, f.home, ...args);
      assert.match(result.stdout, args.includes("--version") ? /0\.1\.0/ : /Benzo —/);
      assert.equal(await state(f.cwd, f.home), undefined);
    }
    await assert.rejects(call(f.cwd, f.home, "--not-an-option"), /Unknown argument/);
  } finally {
    await cleanup(f, [child]);
  }
});

test("external manifests override orchestrator discovery and resolve service cwd from the checkout", { timeout: 30000 }, async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "package.json"), JSON.stringify({ scripts: { dev: "wireit" } }));
  await mkdir(join(f.cwd, "app"));
  await writeFile(join(f.cwd, "app", "server.cjs"), serverCode);
  await writeFile(join(f.cwd, "app", "marker.txt"), "external-manifest");
  const manifest = join(f.root, "external.json");
  await writeFile(manifest, JSON.stringify({ services: [{ name: "web", cwd: "app", command: process.execPath, args: ["server.cjs"] }] }));
  const before = await readdir(f.cwd);
  const child = startArgs(f.home, ["--cwd", f.cwd, "--gateway-port", String(f.port), "--config", manifest, "--script", "missing"]);
  try {
    const running = await waitFor(() => state(f.cwd, f.home));
    const response = await request(f.port, new URL(running.urls.web).host);
    assert.equal(JSON.parse(response.body).marker, "external-manifest");
    assert.deepEqual(await readdir(f.cwd), before);
  } finally {
    await cleanup(f, [child]);
  }
});

test("per-user manifest associations support bare launches, precedence and reversible checkout isolation", { timeout: 30000 }, async () => {
  const f = await fixture();
  const manifest = join(f.root, "personal.json");
  const originalPackage = await readFile(join(f.cwd, "package.json"), "utf8");
  const manifestBytes = JSON.stringify({ gateway: { port: f.port }, services: [{ name: "personal", command: process.execPath, args: ["server.cjs"] }] });
  await writeFile(manifest, manifestBytes);
  const other = join(f.root, "other");
  await mkdir(other);
  await writeFile(join(other, "package.json"), originalPackage);
  const alias = join(f.root, "alias");
  await symlink(f.cwd, alias, "junction");
  const children = [];
  try {
    await call(f.cwd, f.home, "link", "--config", "../personal.json");
    await assert.rejects(call(f.cwd, f.home, "link", "--config", manifest, "--env", "APP_URL=ignored"), /launch options are not saved/);
    await assert.rejects(call(f.cwd, f.home, "unlink", "--config", manifest), /unlink accepts only --cwd/);
    const projectManifest = join(f.cwd, "benzo.config.json");
    await writeFile(projectManifest, JSON.stringify({ services: [{ name: "project", command: process.execPath }] }));
    const plan = JSON.parse((await call(alias, f.home, "config", "--json")).stdout);
    assert.equal(plan.source.kind, "associated-manifest");
    assert.equal(plan.source.path, manifest);
    assert.equal(plan.services[0].name, "personal");
    assert.equal(JSON.parse((await call(f.cwd, join(f.root, "another-home"), "config", "--json")).stdout).source.kind, "project-manifest");
    assert.equal(JSON.parse((await call(other, f.home, "config", "--json")).stdout).source.kind, "package");
    const child = startArgs(f.home, ["--cwd", f.cwd]);
    children.push(child);
    const running = await waitFor(() => state(f.cwd, f.home));
    assert.equal((await request(f.port, new URL(running.urls.personal).host)).status, 200);
    const explicit = join(f.root, "override.json");
    await writeFile(explicit, JSON.stringify({ services: [{ name: "override", command: process.execPath }] }));
    const overridden = JSON.parse((await call(f.cwd, f.home, "config", "--json", "--config", explicit)).stdout);
    assert.equal(overridden.source.kind, "explicit-manifest");
    assert.equal(overridden.services[0].name, "override");
    await writeFile(explicit, "not json");
    await assert.rejects(call(f.cwd, f.home, "link", "--config", explicit), /Could not parse/);
    assert.equal(JSON.parse((await call(f.cwd, f.home, "config", "--json")).stdout).services[0].name, "personal");
    assert.equal(await readFile(manifest, "utf8"), manifestBytes);
    await rm(manifest);
    await assert.rejects(call(f.cwd, f.home, "config", "--json"), /Missing Benzo config.*benzo unlink/);
    // Removing an association changes future discovery, not active ownership.
    await call(alias, f.home, "unlink");
    await call(f.cwd, f.home, "unlink");
    assert.equal(JSON.parse((await call(f.cwd, f.home, "config", "--json")).stdout).source.kind, "project-manifest");
    await rm(projectManifest);
    assert.equal(JSON.parse((await call(f.cwd, f.home, "config", "--json")).stdout).source.kind, "package");
    assert.equal((await state(f.cwd, f.home)).name, running.name);
    assert.equal((await request(f.port, new URL(running.urls.personal).host)).status, 200);
    assert.equal(await readFile(join(f.cwd, "package.json"), "utf8"), originalPackage);
    assert.deepEqual((await readdir(f.cwd)).sort(), ["marker.txt", "package.json", "server.cjs"]);
    await writeFile(manifest, manifestBytes);
    await call(f.cwd, f.home, "link", "--config", manifest);
    const associationDirectory = join(f.home, "associations");
    const association = join(associationDirectory, (await readdir(associationDirectory))[0]);
    for (const invalid of ["not json", "null", JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ schemaVersion: 1, cwd: f.cwd, manifest: "relative.json" })]) {
      await writeFile(association, invalid);
      await assert.rejects(call(f.cwd, f.home, "config", "--json"), /manifest association.*benzo unlink/);
    }
    await call(f.cwd, f.home, "unlink");
    assert.equal(JSON.parse((await call(f.cwd, f.home, "config", "--json")).stdout).source.kind, "package");
  } finally {
    await cleanup(f, children);
  }
});

test("exec binds live descriptor fields, preserves argv and exit codes, and never owns the environment", { timeout: 30000 }, async () => {
  const f = await fixture();
  const run = (...args) => exec(process.execPath, [cli, "exec", "--cwd", f.cwd, ...args], {
    env: { ...process.env, BENZO_HOME: f.home, CLIENT_INHERITED: "preserved" }, timeout: 10000,
  });
  const children = [];
  try {
    await assert.rejects(run("--", process.execPath, "-e", "process.exit(0)"), /No ready Benzo environment/);
    await assert.rejects(run(), /Use benzo exec/);
    const child = start(f.cwd, f.home, f.port);
    children.push(child);
    const running = await waitFor(() => state(f.cwd, f.home));
    const descriptor = JSON.parse((await call(f.cwd, f.home, "describe", "--json")).stdout);
    // No config/discovery occurs for exec, even with a broken manifest on disk.
    await writeFile(join(f.cwd, "benzo.config.json"), "not json");
    const literal = "$(touch should-not-exist) {services.web.origin}";
    const result = await run("--env", "BASE_URL={services.web.origin}/test", "--env", "SERVER={services.web.host}:{services.web.port}",
      "--env", "RUN_ID={instanceId}", "--env", "WORKTREE={name}", "--env", "CLIENT_INHERITED=overridden", "--env", "EMPTY=",
      "--", process.execPath, "-e", "console.log(JSON.stringify({base:process.env.BASE_URL,server:process.env.SERVER,id:process.env.RUN_ID,name:process.env.WORKTREE,inherited:process.env.CLIENT_INHERITED,empty:process.env.EMPTY,args:process.argv.slice(1)}))", literal);
    assert.deepEqual(JSON.parse(result.stdout), {
      base: `${running.urls.web}/test`, server: `127.0.0.1:${running.ports.web}`, id: descriptor.instanceId,
      name: running.name, inherited: "overridden", empty: "", args: [literal],
    });
    assert.equal((await run("--", process.execPath, "-e", "process.stdout.write(process.env.CLIENT_INHERITED)")).stdout, "preserved");
    for (const field of ["services.missing.origin", "services.web.orgin", "token"]) {
      await assert.rejects(run("--env", `SECRET={${field}}`, "--", process.execPath, "-e", "require('fs').writeFileSync('should-not-exist','bad')"), /Unknown descriptor placeholder/);
    }
    assert.equal((await readdir(f.cwd)).includes("should-not-exist"), false);
    await assert.rejects(run("--config", "ignored.json", "--", "node"), /exec accepts only/);
    await assert.rejects(run("--", "benzo-no-such-command-test"), /Could not start exec command \(ENOENT\)/);
    await assert.rejects(run("--", process.execPath, "-e", "process.exit(23)"), (error) => error.code === 23);
    const after = JSON.parse((await call(f.cwd, f.home, "describe", "--json")).stdout);
    assert.equal(after.instanceId, descriptor.instanceId);
    assert.equal(JSON.stringify(after).includes("overridden"), false);
    assert.equal((await request(f.port, new URL(running.urls.web).host)).status, 200);
  } finally { await cleanup(f, children); }
});

test("cancelling exec cleans up its child group while the dev server survives", { timeout: 30000, skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  const dev = start(f.cwd, f.home, f.port);
  const children = [dev];
  try {
    const running = await waitFor(() => state(f.cwd, f.home));
    const pidFile = join(f.root, "client-pid");
    const portFile = join(f.root, "client-port");
    const nested = "const server=require('http').createServer((q,s)=>s.end('client'));server.listen(0,'127.0.0.1',()=>require('fs').writeFileSync(process.argv[1],String(server.address().port)))";
    const client = startArgs(f.home, ["exec", "--cwd", f.cwd, "--", process.execPath, "-e",
      `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(nested)},process.argv[2]],{stdio:'ignore'}); require('fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)`, pidFile, portFile]);
    children.push(client);
    const pid = await waitFor(async () => Number(await readFile(pidFile, "utf8")));
    const clientPort = await waitFor(async () => Number(await readFile(portFile, "utf8")));
    assert.equal((await request(clientPort, "localhost")).body, "client");
    client.kill("SIGINT");
    assert.equal((await client.done).code, 130);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(request(clientPort, "localhost"));
    assert.equal((await request(f.port, new URL(running.urls.web).host)).status, 200);
    assert.equal((await state(f.cwd, f.home)).name, running.name);
  } finally { await cleanup(f, children); }
});

test("HTTPS launchers share only matching transport and certificates and keep keys out of descriptors", { timeout: 30000 }, async () => {
  const f = await fixture();
  const second = join(f.root, "peer");
  await mkdir(second);
  await writeFile(join(second, "package.json"), JSON.stringify({ scripts: { dev: "node server.cjs" } }));
  await writeFile(join(second, "server.cjs"), serverCode);
  await writeFile(join(second, "marker.txt"), "two");
  f.worktrees = [f.cwd, second];
  const tls = await tlsFixture(f.root);
  const other = await tlsFixture(f.root, "other");
  const manifest = join(f.root, "tls.json");
  const different = join(f.root, "different.json");
  const config = { gateway: { tls: { certFile: tls.certFile, keyFile: tls.keyFile } }, services: [{ name: "web", command: process.execPath, args: ["server.cjs"] }] };
  await writeFile(manifest, JSON.stringify(config));
  await writeFile(different, JSON.stringify({ ...config, gateway: { tls: { certFile: other.certFile, keyFile: other.keyFile } } }));
  const first = start(f.cwd, f.home, f.port, "--config", manifest, "--name", "feature");
  const children = [first];
  try {
    const running = await waitFor(() => state(f.cwd, f.home));
    assert.equal(running.urls.web, `https://feature.localhost:${f.port}`);
    assert.equal((await secureRequest(f.port, tls.cert)).status, 200);
    const descriptor = (await call(f.cwd, f.home, "describe", "--json")).stdout;
    assert.equal(JSON.parse(descriptor).services[0].origin, running.urls.web);
    const plan = (await call(f.cwd, f.home, "config", "--config", manifest, "--json")).stdout;
    assert.equal(JSON.parse(plan).gateway.protocol, "https");
    for (const text of [descriptor, plan]) {
      assert.equal(text.includes(tls.keyFile), false);
      assert.equal(text.includes("PRIVATE KEY"), false);
      assert.equal(text.includes(tls.key.split("\n")[1]), false);
    }
    for (const args of [[], ["--config", different], ["--config", manifest, "--name", "uncovered"]]) {
      const failed = start(second, f.home, f.port, ...args);
      children.push(failed);
      assert.equal((await failed.done).code, 1);
      assert.match(failed.output, /transport or certificate differs|does not cover/);
      assert.equal((await secureRequest(f.port, tls.cert)).status, 200);
    }
    const peer = start(second, f.home, f.port, "--config", manifest, "--name", "second");
    children.push(peer);
    const peerState = await waitFor(() => state(second, f.home));
    assert.equal(peerState.urls.web, `https://second.localhost:${f.port}`);
    assert.equal(JSON.parse((await secureRequest(f.port, tls.cert, "/", "second.localhost")).body).marker, "two");
    await call(second, f.home, "stop");
    assert.equal((await peer.done).code, 0);
    assert.equal((await secureRequest(f.port, tls.cert)).status, 200);
  } finally { await cleanup(f, children); }
});

test("config and explain expose effective discovery without environment values", async () => {
  const f = await fixture();
  await writeFile(
    join(f.cwd, "benzo.config.json"),
    JSON.stringify({
      backend: {
        mode: "shared",
        command: "node",
        env: { BACKEND_SECRET: "backend-do-not-print" },
      },
      auth: {
        mode: "callback",
        upstream: "https://user:auth-do-not-print@example.invalid/?token=private",
      },
      services: [
        {
          name: "web",
          command: "node",
          args: ["server.cjs"],
          env: { SECRET_VALUE: "do-not-print", APP_URL: "{origin}" },
        },
      ],
    }),
  );
  try {
    const { stdout } = await call(f.cwd, f.home, "config", "--json", "--env", "APP_URL=override");
    const descriptor = JSON.parse(stdout);
    assert.equal(descriptor.schemaVersion, 1);
    assert.deepEqual(descriptor.services[0].envKeys, ["APP_URL", "SECRET_VALUE"]);
    assert.equal(JSON.stringify(descriptor).includes("do-not-print"), false);
    assert.deepEqual(descriptor.backend, {
      mode: "shared", envKeys: ["BACKEND_SECRET"],
    });
    assert.deepEqual(descriptor.auth, { mode: "callback" });
    assert.equal(descriptor.services[0].args[0], "[redacted]");
    const sensitive = JSON.parse(await readFile(join(f.cwd, "benzo.config.json"), "utf8"));
    sensitive.gateway = { token: "gateway-secret", extension: { password: "nested-secret" } };
    sensitive.worktree = { credential: "worktree-secret" };
    sensitive.services[0].command = "command-secret";
    sensitive.services[0].args = ["TOKEN=argument-secret", "https://user:password@example.invalid"];
    sensitive.services[0].ready = {path: "/health?token=readiness-secret"};
    await writeFile(join(f.cwd, "benzo.config.json"), JSON.stringify(sensitive));
    for (const command of ["config", "explain"]) {
      const output = (await call(f.cwd, f.home, command, "--name", "requested-name")).stdout;
      for (const secret of ["command-secret", "argument-secret", "readiness-secret", "password", "backend-do-not-print", "auth-do-not-print", "gateway-secret", "worktree-secret", "nested-secret"])
        assert.equal(output.includes(secret), false, command + " leaked " + secret);
    }
    for (const command of ["config", "explain"]) {
      const output = (await call(f.cwd, f.home, command, "--json")).stdout;
      assert.equal(output.includes("gateway-secret"), false);
      assert.equal(output.includes("worktree-secret"), false);
      assert.equal(output.includes("nested-secret"), false);
    }
    const plan = JSON.parse((await call(f.cwd, f.home, "config", "--json", "--name", "requested-name")).stdout);
    assert.equal(plan.requestedName, "requested-name");
    assert.equal(plan.allocation, "unresolved-until-launch");
    assert.equal(plan.allocatedName, null);
    assert.equal(plan.services[0].origin, null);
    assert.equal(plan.services[0].upstreamPort, null);
    assert.equal(plan.services[0].originTemplate, "http://{allocatedName}.localhost:3000");
    assert.equal(plan.provenance.requestedName, "--name");
    assert.equal(plan.provenance.gateway.port, "default");
    assert.equal(plan.provenance.authMode, "project-manifest");
    assert.equal(plan.provenance.services[0].ready.path, "project-manifest");
    assert.equal(plan.provenance.services[0].ready.timeout, "default");
    assert.equal(descriptor.provenance.services[0].env.APP_URL, "--env");
    assert.equal(descriptor.provenance.services[0].env.SECRET_VALUE, "project-manifest");
    const overrides = JSON.parse((await call(f.cwd, f.home, "config", "--json", "--gateway-port", "4321", "--auth-relay")).stdout);
    assert.equal(overrides.provenance.gateway.port, "--gateway-port");
    assert.equal(overrides.provenance.gateway.controlPort, "derived:--gateway-port");
    assert.equal(overrides.gateway.controlPort, 4320);
    assert.equal(overrides.provenance.authMode, "--auth-relay");
    assert.equal(overrides.services[0].originTemplate, "http://{allocatedName}.localhost:4321");

    assert.ok(plan.diagnostics.some(entry => entry.path === 'gateway["token"]'));
    const explained = await call(f.cwd, f.home, "explain");
    assert.match(explained.stdout, /Discovery: manifest/);
    assert.match(explained.stdout, /Unknown config field: gateway/);
    assert.match(explained.stdout, /Environment values are inherited/);
    assert.equal(explained.stdout.includes("do-not-print"), false);
  } finally {
    await cleanup(f, []);
  }
});

test(
  "launch overrides expand origins, win over manifest settings, and stay out of status",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    await writeFile(
      join(f.cwd, "server.cjs"),
      "require('node:http').createServer((req,res)=>res.end(JSON.stringify({origin:process.env.APP_URL,value:process.env.CUSTOM_VALUE}))).listen(Number(process.env.PORT),'127.0.0.1')",
    );
    await writeFile(
      join(f.cwd, "benzo.config.json"),
      JSON.stringify({
        services: [
          {
            name: "web",
            command: "node",
            args: ["server.cjs"],
            env: { CUSTOM_VALUE: "manifest" },
          },
        ],
      }),
    );
    const child = start(
      f.cwd,
      f.home,
      f.port,
      "--env",
      "APP_URL={origin}",
      "--env",
      "CUSTOM_VALUE=launch=only",
    );
    try {
      const running = await waitFor(() => state(f.cwd, f.home));
      const response = await request(f.port, new URL(running.urls.web).host);
      assert.deepEqual(JSON.parse(response.body), {
        origin: running.urls.web,
        value: "launch=only",
      });
      assert.ok(!JSON.stringify(running).includes("launch=only"));
      await assert.rejects(
        call(f.cwd, f.home, "doctor", "--env", "MISSING_EQUALS"),
        /KEY=value/,
      );
    } finally {
      await cleanup(f, [child]);
    }
  },
);

test(
  "zero-config startup preserves application environment, waits for readiness, writes no project files, stops cleanly",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const before = await readdir(f.cwd);
    const child = start(f.cwd, f.home, f.port);
    try {
      const running = await waitFor(() => state(f.cwd, f.home));
      assert.ok(child.output.includes("Ready."));
      assert.equal(JSON.stringify(running).includes("benzo-test-only"), false);
      assert.equal("token" in running, false);
      const response = await request(f.port, new URL(running.urls.web).host);
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).authConfigured, true);
      assert.deepEqual(await readdir(f.cwd), before);
      await call(f.cwd, f.home, "stop");
      assert.equal((await child.done).code, 0);
      assert.equal(
        JSON.parse((await call(f.cwd, f.home, "status", "--json")).stdout)
          .status,
        undefined,
      );
      await assert.rejects(request(running.ports.web, "localhost"));
    } finally {
      await cleanup(f, [child]);
    }
  },
);

test(
  "parallel real Git worktrees suffix collisions, retain names, and survive peer stop",
  { timeout: 45000 },
  async () => {
    const f = await fixture();
    const original = f.cwd;
    await exec("git", ["init", "-q", original]);
    await exec("git", ["-C", original, "add", "."]);
    await exec("git", [
      "-C",
      original,
      "-c",
      "user.name=Benzo Test",
      "-c",
      "user.email=benzo@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const first = join(f.root, "a", "feature");
    const second = join(f.root, "b", "feature");
    await exec("git", ["-C", original, "worktree", "add", "-qb", "one", first]);
    await exec("git", [
      "-C",
      original,
      "worktree",
      "add",
      "-qb",
      "two",
      second,
    ]);
    f.worktrees = [first, second];
    await writeFile(join(second, "marker.txt"), "two");
    const one = start(first, f.home, f.port);
    const children = [one];
    try {
      const firstState = await waitFor(() => state(first, f.home));
      const two = start(second, f.home, f.port);
      children.push(two);
      const secondState = await waitFor(() => state(second, f.home));
      assert.equal(firstState.name, "feature");
      assert.equal(secondState.name, "feature-2");
      assert.notEqual(firstState.ports.web, secondState.ports.web);
      assert.equal(
        JSON.parse(
          (await request(f.port, new URL(firstState.urls.web).host)).body,
        ).marker,
        "one",
      );
      assert.equal(
        JSON.parse(
          (await request(f.port, new URL(secondState.urls.web).host)).body,
        ).marker,
        "two",
      );
      const duplicate = start(first, f.home, f.port);
      children.push(duplicate);
      assert.equal((await duplicate.done).code, 1);
      assert.match(duplicate.output, /already running/);
      await call(first, f.home, "stop");
      await one.done;
      assert.equal(
        (await request(f.port, new URL(secondState.urls.web).host)).status,
        200,
      );
      const restart = start(first, f.home, f.port);
      children.push(restart);
      const restarted = await waitFor(() => state(first, f.home));
      assert.equal(restarted.name, "feature");
      await writeFile(join(first, "marker.txt"), "edited");
      assert.equal(
        JSON.parse(
          (await request(f.port, new URL(restarted.urls.web).host)).body,
        ).marker,
        "edited",
      );
      assert.equal(
        JSON.parse(
          (await request(f.port, new URL(secondState.urls.web).host)).body,
        ).marker,
        "two",
      );
    } finally {
      await cleanup(f, children);
    }
  },
);

test(
  "service crash returns failure and cleans the owned listener",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const child = start(f.cwd, f.home, f.port);
    try {
      const running = await waitFor(() => state(f.cwd, f.home));
      await request(f.port, new URL(running.urls.web).host, "/crash");
      assert.equal((await child.done).code, 1);
      await assert.rejects(request(running.ports.web, "localhost"));
      assert.match(child.output, /exited \(7\)/);
    } finally {
      await cleanup(f, [child]);
    }
  },
);

test(
  "spawn errors and readiness timeouts do not report Ready or leak registrations",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const child = start(
      f.cwd,
      f.home,
      f.port,
      "--",
      "benzo-nonexistent-command",
    );
    try {
      assert.equal((await child.done).code, 1);
      assert.match(child.output, /Could not launch/);
      assert.doesNotMatch(child.output, /Ready\./);
    } finally {
      await cleanup(f, [child]);
    }
  },
);

test(
  "abrupt launcher termination reaps detached services through gateway lease ownership",
  { timeout: 30000, skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    const child = start(f.cwd, f.home, f.port);
    try {
      const running = await waitFor(() => state(f.cwd, f.home));
      await delay(100);
      child.kill("SIGKILL");
      await child.done;
      await waitFor(async () => {
        try {
          await request(running.ports.web, "localhost");
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(
        JSON.parse((await call(f.cwd, f.home, "status", "--json")).stdout)
          .status,
        undefined,
      );
    } finally {
      await cleanup(f, [child]);
    }
  },
);

test(
  "readiness timeout and cancellation release reserved ports without a false Ready",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const configPath = join(f.root, "timeout.json");
    await writeFile(
      configPath,
      JSON.stringify({
        services: [
          {
            name: "web",
            command: "node",
            args: ["-e", "setInterval(()=>{},1000)"],
            ready: { timeout: 350 },
          },
        ],
      }),
    );
    const child = start(f.cwd, f.home, f.port, "--config", configPath);
    try {
      assert.equal((await child.done).code, 1);
      assert.match(child.output, /did not become ready/);
      assert.doesNotMatch(child.output, /Ready\./);
    } finally {
      await cleanup(f, [child]);
    }
  },
);

test(
  "shared backend starts once and survives the first worktree stopping",
  { timeout: 45000 },
  async () => {
    const f = await fixture();
    const second = join(f.root, "second");
    await mkdir(second);
    for (const file of ["package.json", "server.cjs", "marker.txt"])
      await writeFile(join(second, file), await readFile(join(f.cwd, file)));
    // Share a Git common directory to identify the backend as one project.
    await exec("git", ["init", "-q", f.cwd]);
    await exec("git", ["-C", f.cwd, "add", "."]);
    await exec("git", [
      "-C",
      f.cwd,
      "-c",
      "user.name=Benzo Test",
      "-c",
      "user.email=benzo@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    await rm(second, { recursive: true });
    await exec("git", [
      "-C",
      f.cwd,
      "worktree",
      "add",
      "-qb",
      "second",
      second,
    ]);
    f.worktrees = [f.cwd, second];
    const marker = join(f.root, "backend-starts");
    const configPath = join(f.root, "shared.json");
    await writeFile(
      configPath,
      JSON.stringify({
        backend: {
          mode: "shared",
          command: "node",
          args: [
            "-e",
            `require('node:fs').appendFileSync(${JSON.stringify(marker)},'start\\n'); setInterval(()=>{},1000)`,
          ],
        },
        services: [{ name: "web", command: "node", args: ["server.cjs"] }],
      }),
    );
    const one = start(f.cwd, f.home, f.port, "--config", configPath);
    const children = [one];
    try {
      await waitFor(() => state(f.cwd, f.home));
      const two = start(second, f.home, f.port, "--config", configPath);
      children.push(two);
      const running = await waitFor(() => state(second, f.home));
      assert.equal(
        (await readFile(marker, "utf8")).split("start").length - 1,
        1,
      );
      await call(f.cwd, f.home, "stop");
      await one.done;
      assert.equal(
        (await request(f.port, new URL(running.urls.web).host)).status,
        200,
      );
    } finally {
      await cleanup(f, children);
    }
  },
);

test(
  "simultaneous first starts elect one gateway and never collide internal ownership",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const second = join(f.root, "second");
    await mkdir(second);
    for (const file of ["package.json", "server.cjs", "marker.txt"])
      await writeFile(join(second, file), await readFile(join(f.cwd, file)));
    f.worktrees = [f.cwd, second];
    const one = start(f.cwd, f.home, f.port, "--name", "feature");
    const two = start(second, f.home, f.port, "--name", "feature");
    try {
      const [a, b] = await Promise.all([
        waitFor(() => state(f.cwd, f.home)),
        waitFor(() => state(second, f.home)),
      ]);
      assert.deepEqual(
        new Set([a.name, b.name]),
        new Set(["feature", "feature-2"]),
      );
      assert.notEqual(a.ports.web, b.ports.web);
    } finally {
      await cleanup(f, [one, two]);
    }
  },
);

test(
  "npm-style bin symlink actually executes the CLI entrypoint",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      const link = join(f.root, "benzo");
      await import("node:fs/promises").then((fs) => fs.symlink(cli, link));
      const { stdout } = await exec(process.execPath, [link, "--version"]);
      assert.equal(stdout.trim(), "0.1.0");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test("environment descriptor is live, capability-free and distinguishes launcher restarts", {timeout: 30000}, async () => {
  const f = await fixture();
  const children = [];
  try {
    assert.equal(JSON.parse((await call(f.cwd, f.home, 'describe', '--json')).stdout), null);
    const first = start(f.cwd, f.home, f.port);
    children.push(first);
    await waitFor(() => state(f.cwd, f.home));
    const a = JSON.parse((await call(f.cwd, f.home, 'describe', '--json')).stdout);
    assert.equal(a.schemaVersion, 1);
    assert.equal(a.kind, 'benzo-environment');
    assert.equal(a.services[0].readiness, 'ready');
    assert.equal(a.services[0].upstream.host, '127.0.0.1');
    assert.equal((await request(f.port, new URL(a.services[0].origin).host)).status, 200);
    assert.equal('token' in a, false);
    assert.equal('controlPort' in a, false);
    // A package consumer gets the same descriptor through the supported SDK.
    const {stdout} = await exec(process.execPath, ['--input-type=module', '-e',
      `import {getEnvironment} from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)}; console.log(JSON.stringify(await getEnvironment({cwd:process.argv[1]})));`, f.cwd],
      {env: {...process.env, BENZO_HOME: f.home}});
    assert.deepEqual(JSON.parse(stdout), a);
    await call(f.cwd, f.home, 'stop');
    await first.done;
    assert.equal(JSON.parse((await call(f.cwd, f.home, 'describe', '--json')).stdout), null);
    await delay(1000);
    children.push(start(f.cwd, f.home, f.port));
    await waitFor(() => state(f.cwd, f.home));
    const b = JSON.parse((await call(f.cwd, f.home, 'describe', '--json')).stdout);
    assert.equal(b.worktreeId, a.worktreeId);
    assert.equal(b.projectId, a.projectId);
    assert.equal(b.services[0].id, a.services[0].id);
    assert.notEqual(b.instanceId, a.instanceId);
  } finally { await cleanup(f, children); }
});

test("external leases reserve origins, gate readiness and never stop listeners", {timeout: 30000}, async () => {
  const {reserveEnvironment} = await import('../src/sdk.js');
  const f = await fixture();
  const secondCwd = join(f.root, 'second');
  await mkdir(secondCwd);
  const previousHome = process.env.BENZO_HOME;
  process.env.BENZO_HOME = f.home;
  const servers = [];
  const leases = [];
  try {
    const a = await reserveEnvironment({cwd: f.cwd, name: 'shared', gateway: {port: f.port}, services: ['web', 'api']});
    leases.push(a);
    const b = await reserveEnvironment({cwd: secondCwd, name: 'shared', gateway: {port: f.port}});
    leases.push(b);
    const hostA = new URL(a.describe().services[0].origin).host;
    const hostB = new URL(b.describe().services[0].origin).host;
    assert.notEqual(hostA, hostB);
    assert.equal((await request(f.port, hostA)).status, 503);
    await assert.rejects(a.setReady('web'), /Attach/);
    await assert.rejects(a.attach('foreign', {port: 12345}), /Unknown service/);
    await assert.rejects(a.attach('web', {port: f.port}), /Invalid/);
    for (const label of ['alpha', 'beta']) {
      const server = createServer((_req, res) => res.end(label));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
    }
    await a.attach('web', {port: servers[0].address().port});
    assert.equal((await request(f.port, hostA)).status, 503);
    await a.setReady('web');
    assert.equal((await request(f.port, hostA)).body, 'alpha');
    assert.equal(a.describe().status, 'starting'); // API remains unattached.
    await b.attach('web', {port: servers[1].address().port, ready: true});
    assert.equal(b.describe().status, 'ready');
    await a.attach('web', {port: servers[1].address().port, ready: true});
    assert.equal((await request(f.port, hostA)).body, 'beta');
    await a.setReady('web', false);
    assert.equal((await request(f.port, hostA)).status, 503);
    await a.release();
    await a.release();
    await waitFor(async () => (await request(f.port, hostA)).status === 404);
    assert.equal((await request(f.port, hostB)).body, 'beta');
    assert.equal((await request(servers[0].address().port, 'localhost')).body, 'alpha');
    await assert.rejects(a.attach('web', {port: servers[0].address().port}), /closed/);
    assert.equal(a.describe().status, 'stopped');
    await b.release();
    const controller = new AbortController();
    const c = await reserveEnvironment({cwd: f.cwd, name: 'cancelled', gateway: {port: f.port}, signal: controller.signal});
    leases.push(c);
    await c.attach('web', {port: servers[0].address().port, ready: true});
    controller.abort();
    await c.closed;
    assert.equal(c.describe().status, 'stopped');
    assert.equal((await request(servers[1].address().port, 'localhost')).body, 'beta');
  } finally {
    await Promise.all(leases.map(lease => lease.release()));
    await Promise.all(servers.map(server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})));
    if (previousHome === undefined) delete process.env.BENZO_HOME;
    else process.env.BENZO_HOME = previousHome;
    await delay(1000);
    await rm(f.root, {recursive: true, force: true});
  }
});

test("external readiness updates preserve OAuth affinity but reattachment invalidates it", {timeout: 30000}, async () => {
  const {reserveEnvironment} = await import('../src/sdk.js');
  const f = await fixture();
  const previousHome = process.env.BENZO_HOME;
  process.env.BENZO_HOME = f.home;
  let lease;
  let oauthState = 'repeat-readiness';
  const app = createServer((_req, res) => {
    const authorization = new URL('https://provider.invalid/authorize');
    authorization.searchParams.set('state', oauthState);
    authorization.searchParams.set('redirect_uri', `http://localhost:${f.port}/callback`);
    res.writeHead(302, {location: authorization.href}).end();
  });
  try {
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    lease = await reserveEnvironment({cwd: f.cwd, gateway: {port: f.port}});
    await lease.attach('web', {port: app.address().port, ready: true});
    const host = new URL(lease.describe().services[0].origin).host;
    await request(f.port, host, '/api/auth/signin');
    await lease.setReady('web', true);
    assert.equal((await request(f.port, `localhost:${f.port}`, `/callback?state=${oauthState}`)).status, 307);
    oauthState = 'readiness-cycle';
    await request(f.port, host, '/api/auth/signin');
    await lease.setReady('web', false);
    assert.equal((await request(f.port, host)).status, 503);
    await lease.setReady('web', true);
    assert.equal((await request(f.port, `localhost:${f.port}`, `/callback?state=${oauthState}`)).status, 307);
    oauthState = 'replaced-listener';
    await request(f.port, host, '/api/auth/signin');
    // Even reuse of the numeric port is a new attachment identity.
    await lease.attach('web', {port: app.address().port, ready: true});
    assert.equal((await request(f.port, `localhost:${f.port}`, `/callback?state=${oauthState}`)).status, 409);
  } finally {
    await lease?.release();
    await new Promise(resolve => {app.close(resolve); app.closeAllConnections();});
    if (previousHome === undefined) delete process.env.BENZO_HOME;
    else process.env.BENZO_HOME = previousHome;
    await delay(1000);
    await rm(f.root, {recursive: true, force: true});
  }
});

test("config and explain report inherited environment sources without exposing values", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "benzo.config.json"), JSON.stringify({services: [{
      name: "web", command: "node", args: ["server.cjs"],
      excludeEnv: ["PLAN_DROP", "PLAN_RESTORE"],
      env: {PLAN_RESTORE: "configured-private-value"},
    }]}));
    const env = {...process.env, BENZO_HOME: f.home, PLAN_KEEP: "inherited-private-value", PLAN_DROP: "excluded-private-value", PLAN_RESTORE: "old-private-value"};
    for (const command of ["config", "explain"]) {
      const args = [cli, command, "--cwd", f.cwd, "--env", "PLAN_RESTORE=cli-private-value"];
      const {stdout} = await exec(process.execPath, args, {env, timeout: 10000});
      for (const value of ["inherited-private-value", "excluded-private-value", "old-private-value", "configured-private-value", "cli-private-value"])
        assert.equal(stdout.includes(value), false);
      if (command === "config") {
        const service = JSON.parse(stdout).provenance.services[0];
        assert.equal(service.env.PLAN_KEEP, "inherited-process");
        assert.equal(service.env.PLAN_RESTORE, "--env");
        assert.equal(service.env.PLAN_DROP, undefined);
        assert.deepEqual(service.excludedInheritedKeys, ["PLAN_DROP", "PLAN_RESTORE"]);
      } else {
        assert.match(stdout, /PLAN_KEEP=inherited-process/);
        assert.match(stdout, /PLAN_RESTORE=--env/);
        assert.match(stdout, /excluded inherited keys: PLAN_DROP, PLAN_RESTORE/);
      }
    }
  } finally { await cleanup(f, []); }
});

test("removed graph inspection and misplaced import flags fail before discovery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "benzo-scope-"));
  try {
    const help = (await call(cwd, join(cwd, "home"), "--help")).stdout;
    assert.equal(help.includes("inspect --from wireit"), false);
    for (const args of [["inspect", "--from", "wireit"], ["dev", "--from", "wireit"], ["status", "--from", "portless"]]) {
      await assert.rejects(call(cwd, join(cwd, "home"), ...args), error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /graph inspection command was removed|--from supports only/);
        return true;
      });
    }
    assert.deepEqual(await readdir(cwd), []);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});
