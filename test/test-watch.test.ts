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
