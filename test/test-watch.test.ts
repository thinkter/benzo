import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { watchTests } from "../scripts/test-watch.js";

test(
  "watcher rebuilds source edits and never runs stale tests after a compiler error",
  { timeout: 30000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "benzo-watch-"));
    const reports: string[] = [];
    let watcher: ReturnType<typeof watchTests> | undefined;
    async function until(predicate: () => boolean): Promise<void> {
      const deadline = Date.now() + 15000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(reports.join("\n"));
        await delay(20);
      }
    }
    try {
      await writeFile(
        join(cwd, "test.ts"),
        'console.log("compiled test executed");',
      );
      const compiler = resolve("node_modules/typescript/bin/tsc");
      await writeFile(
        join(cwd, "run.cjs"),
        `
const {spawnSync} = require("node:child_process");
const {appendFileSync} = require("node:fs");
const build = spawnSync(process.execPath, [${JSON.stringify(compiler)}, "--strict", "--noEmitOnError", "--outDir", "build", "test.ts"], {stdio: "inherit"});
if (build.status !== 0) process.exit(1);
appendFileSync("runs", "run\\n");
const result = spawnSync(process.execPath, ["build/test.js"], {stdio: "inherit"});
process.exit(result.status ?? 1);
`,
      );
      watcher = watchTests({
        cwd,
        command: process.execPath,
        args: ["run.cjs"],
        paths: ["test.ts"],
        report: (message) => {
          reports.push(message);
        },
      });
      await until(() =>
        reports.some((line) => line.startsWith("Current sources passed")),
      );
      const firstCount = (await readFile(join(cwd, "runs"), "utf8")).split(
        "\n",
      ).length;
      reports.length = 0;
      await writeFile(join(cwd, "test.ts"), 'const broken: number = "wrong";');
      await until(() =>
        reports.some((line) => line.startsWith("Build or tests failed")),
      );
      assert.equal(
        (await readFile(join(cwd, "runs"), "utf8")).split("\n").length,
        firstCount,
      );
      reports.length = 0;
      await writeFile(
        join(cwd, "test.ts"),
        'throw new Error("new assertion fails");',
      );
      await until(() =>
        reports.some((line) => line.startsWith("Build or tests failed")),
      );
      assert.ok(
        (await readFile(join(cwd, "runs"), "utf8")).split("\n").length >
          firstCount,
      );
      reports.length = 0;
      await writeFile(
        join(cwd, "replacement.ts"),
        'console.log("fixed assertion");',
      );
      await rename(join(cwd, "replacement.ts"), join(cwd, "test.ts"));
      await until(() =>
        reports.some((line) => line.startsWith("Current sources passed")),
      );
    } finally {
      await watcher?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, "utf8");
      if (content) return content;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    await delay(20);
  }
  throw new Error("Child did not become ready");
}

test(
  "closing a watcher waits for a SIGTERM-resistant active child to exit",
  {
    skip: process.platform === "win32",
    timeout: 15000,
  },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "benzo-watch-stop-"));
    let watcher: ReturnType<typeof watchTests> | undefined;
    try {
      await writeFile(
        join(cwd, "child.cjs"),
        `
      require("node:fs").writeFileSync("pid", String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `,
      );
      watcher = watchTests({
        cwd,
        command: process.execPath,
        args: ["child.cjs"],
        paths: ["child.cjs"],
        report: () => {},
      });
      const pid = Number(await waitForFile(join(cwd, "pid")));
      await watcher.close();
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await watcher.close();
    } finally {
      await watcher?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(
    `watch CLI exits with ${code} after ${signal} and cleans up its active child`,
    {
      skip: process.platform === "win32",
      timeout: 15000,
    },
    async () => {
      const { spawn } = await import("node:child_process");
      const { mkdir } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const cwd = await mkdtemp(join(tmpdir(), "benzo-watch-signal-"));
      const entry = fileURLToPath(
        new URL("../scripts/test-watch.js", import.meta.url),
      );
      for (const dir of ["src", "test", "scripts", "compatibility"])
        await mkdir(join(cwd, dir));
      for (const file of [
        "package.json",
        "tsconfig.json",
        "tsconfig.tests.json",
        "tsconfig.consumer.json",
        "tsconfig.tools.json",
      ])
        await writeFile(join(cwd, file), "{}");
      const runner = join(cwd, "runner.cjs");
      await writeFile(
        runner,
        `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync("pid", String(process.pid));
      setInterval(() => {}, 1000);
    `,
      );
      const child = spawn(process.execPath, [entry], {
        cwd,
        env: { ...process.env, npm_execpath: runner },
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      try {
        const pid = Number(await waitForFile(join(cwd, "pid")));
        child.kill(signal);
        assert.equal(await exited, code);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await exited;
        }
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
}
