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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

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
  const child = spawn(
    process.execPath,
    [cli, "dev", "--cwd", cwd, "--gateway-port", String(port), ...args],
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
