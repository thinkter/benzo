import test from "node:test";
import assert from "node:assert/strict";
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectWireit } from "../src/wireit.js";

const exec = promisify(execFile);
const taskId = (directory, script) => JSON.stringify([directory, script]);

test(
  "Wireit identities distinguish colon-bearing canonical paths from script names",
  { skip: process.platform === "win32" },
  async () =>
    fixture(async (root) => {
      await pkg(root, {
        wireit: { dev: { dependencies: ["./alias:dev", "./a:b:dev"] } },
      });
      await pkg(join(root, "a:b"), {
        wireit: {
          dev: {
            command: "node server.js",
            service: true,
            dependencies: ["prepare"],
          },
          prepare: { command: "node prepare.js" },
        },
      });
      await pkg(join(root, "a"), {
        wireit: {
          "b:dev": { command: "node build.js", dependencies: ["assets"] },
          assets: { command: "node assets.js" },
        },
      });
      await symlink(join(root, "a:b"), join(root, "alias"), "junction");
      const report = inspectWireit(root);
      assert.equal(report.status, "inspected");
      assert.equal(report.tasks.length, 5);
      assert.equal(new Set(report.tasks.map((task) => task.id)).size, 5);
      assert.deepEqual(
        report.tasks.find((task) => task.id === taskId(".", "dev"))
          .dependencies,
        [
          { task: taskId("a:b", "dev"), cascade: true },
          { task: taskId("a", "b:dev"), cascade: true },
        ],
      );
      const server = report.tasks.find(
        (task) => task.id === taskId("a:b", "dev"),
      );
      const build = report.tasks.find(
        (task) => task.id === taskId("a", "b:dev"),
      );
      assert.equal(server.kind, "long-running");
      assert.equal(build.kind, "task");
      assert.deepEqual(server.dependencies, [
        { task: taskId("a:b", "prepare"), cascade: true },
      ]);
      assert.deepEqual(build.dependencies, [
        { task: taskId("a", "assets"), cascade: true },
      ]);
    }),
);
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "benzo-wireit-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function pkg(root, value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify(value));
}

test("Wireit inspection preserves declared graph distinctions and cascade without exposing command or env values", async () =>
  fixture(async (root) => {
    await pkg(root, {
      scripts: { dev: "wireit", predev: "touch should-not-run" },
      wireit: {
        dev: {
          dependencies: [
            "build:shared",
            { script: "./web:dev", cascade: false },
            "watch",
          ],
        },
        "build:shared": {
          command: "TOKEN=command-secret node build.js",
          env: {
            TOKEN: "env-secret",
            OTHER: { external: true, default: "default-secret" },
          },
        },
        watch: {
          service: true,
          command: "node watch.js",
          dependencies: ["build:shared"],
        },
      },
    });
    await pkg(join(root, "web"), {
      scripts: { dev: "wireit" },
      wireit: {
        dev: {
          service: { readyWhen: { lineMatches: "readiness-secret" } },
          command: "vite",
          dependencies: ["../:build:shared"],
        },
      },
    });
    const before = await readFile(join(root, "package.json"), "utf8");
    const report = inspectWireit(root);
    assert.equal(report.status, "inspected");
    assert.equal(report.launch, "requires-explicit-listener-integration");
    assert.equal(report.tasks.length, 4);
    assert.deepEqual(
      report.tasks.find((task) => task.id === taskId(".", "dev")).dependencies,
      [
        { task: taskId(".", "build:shared"), cascade: true },
        { task: taskId("web", "dev"), cascade: false },
        { task: taskId(".", "watch"), cascade: true },
      ],
    );
    assert.equal(
      report.tasks.find((task) => task.id === taskId(".", "dev")).kind,
      "aggregate",
    );
    const service = report.tasks.find(
      (task) => task.id === taskId("web", "dev"),
    );
    assert.equal(service.kind, "long-running");
    assert.equal(service.readiness, "declared-log-pattern");
    assert.equal(service.listener, "unknown");
    assert.deepEqual(service.dependencies, [
      { task: taskId(".", "build:shared"), cascade: true },
    ]);
    assert.deepEqual(
      report.tasks.find((task) => task.id === taskId(".", "build:shared"))
        .envKeys,
      ["OTHER", "TOKEN"],
    );
    for (const secret of [
      "command-secret",
      "env-secret",
      "default-secret",
      "readiness-secret",
    ])
      assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), before);
    assert.deepEqual((await readdir(root)).sort(), ["package.json", "web"]);
  }));

test("Wireit inspection reports cycles, missing tasks and opaque shell scripts instead of flattening them", async () =>
  fixture(async (root) => {
    await pkg(root, {
      scripts: { opaque: "echo private; touch should-not-run" },
      wireit: {
        dev: {
          dependencies: [
            "a",
            "missing",
            "opaque",
            { script: "a", cascade: "no" },
          ],
        },
        a: { dependencies: ["dev"] },
      },
    });
    const report = inspectWireit(root);
    assert.equal(report.status, "incomplete");
    assert.deepEqual(
      new Set(report.issues.map((issue) => issue.code)),
      new Set([
        "dependency-cycle",
        "missing-task",
        "opaque-script",
        "invalid-dependency",
      ]),
    );
    assert.equal(
      report.tasks.find((task) => task.id === taskId(".", "opaque")).kind,
      "opaque-script",
    );
    assert.equal(JSON.stringify(report).includes("private"), false);
    assert.deepEqual(await readdir(root), ["package.json"]);
  }));

test("Wireit inspection does not read dependencies outside its root or symlinked package files", async () =>
  fixture(async (base) => {
    const root = join(base, "project");
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(
      join(outside, "package.json"),
      "not json and must not be read",
    );
    await pkg(root, {
      wireit: {
        dev: {
          dependencies: ["../outside:dev", "./escape:dev", "./linked:dev"],
        },
      },
    });
    await symlink(outside, join(root, "escape"), "junction");
    await mkdir(join(root, "linked"));
    await symlink(
      join(outside, "package.json"),
      join(root, "linked", "package.json"),
    );
    const report = inspectWireit(root);
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      [
        "dependency-outside-inspection-root",
        "dependency-outside-inspection-root",
        "unsupported-package-file",
      ],
    );
    assert.equal(report.tasks.length, 1);
  }));

test("Wireit inspection bounds graph traversal and rejects malformed task metadata", async () =>
  fixture(async (root) => {
    const wireit = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `t${i}`,
        { command: "node task.js", dependencies: i < 299 ? [`t${i + 1}`] : [] },
      ]),
    );
    await pkg(root, { wireit });
    const limited = inspectWireit(root, "t0");
    assert.equal(limited.tasks.length, 256);
    assert.ok(limited.issues.some((issue) => issue.code === "task-limit"));
    await pkg(root, {
      wireit: {
        dev: { command: 12, service: "yes", env: [], dependencies: {} },
      },
    });
    assert.deepEqual(
      inspectWireit(root).issues.map((issue) => issue.code),
      [
        "invalid-command",
        "invalid-service",
        "invalid-environment",
        "invalid-dependencies",
      ],
    );
    await pkg(root, {
      wireit: { dev: { dependencies: Array(2050).fill("leaf") }, leaf: {} },
    });
    assert.ok(
      inspectWireit(root).issues.some(
        (issue) => issue.code === "dependency-limit",
      ),
    );
  }));

test("CLI Wireit inspection bypasses discovery, never executes scripts, and reports incomplete inspection with exit 1", async () =>
  fixture(async (root) => {
    await pkg(root, {
      scripts: { dev: "wireit" },
      wireit: {
        dev: { dependencies: ["worker"] },
        worker: { command: "touch should-not-run", service: true },
      },
    });
    const cli = resolve("src/cli.js");
    const args = [cli, "inspect", "--from", "wireit", "--cwd", root, "--json"];
    const result = await exec(process.execPath, args);
    assert.equal(JSON.parse(result.stdout).status, "inspected");
    assert.deepEqual(await readdir(root), ["package.json"]);
    await assert.rejects(
      exec(process.execPath, [...args, "--script", "missing"]),
      (error) =>
        error.code === 1 &&
        JSON.parse(error.stdout).issues[0].code === "missing-task",
    );
    await assert.rejects(
      exec(process.execPath, [...args, "--env", "TOKEN=value"]),
      /inspect accepts only/,
    );
    await assert.rejects(
      exec(process.execPath, [cli, "dev", "--from", "wireit", "--cwd", root]),
      /--from is supported by benzo inspect --from wireit/,
    );
  }));
