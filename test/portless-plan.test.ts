import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
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
import { inspectPortless } from "../src/portless-plan.js";

function parseObject(text: string): Record<string, Json> {
  const value: Json = JSON.parse(text);
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value;
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const exec = promisify(execFile);
const cli = resolve("dist/cli.js");
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "benzo-portless-plan-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const pkg = (root: string, value: object) =>
  writeFile(join(root, "package.json"), JSON.stringify(value));

test("Portless trial plans are deterministic, selected-script-only and leave all files unchanged", async () =>
  fixture(async (root) => {
    await pkg(root, {
      scripts: {
        dev: "portless run vite",
        custom: "node private-wrapper.js && touch marker",
      },
      privateField: "do-not-print",
    });
    await writeFile(join(root, ".env"), "TOKEN=env-private-value");
    const before = await readFile(join(root, "package.json"), "utf8");
    const report = inspectPortless(root);
    assert.equal(report.status, "http-trial-available");
    assert.deepEqual(report.projectChanges, []);
    assert.equal(report.automaticMigration, false);
    assert.equal(report.originPreserved, false);
    assert.ok(report.trial);
    assert.deepEqual(report.trial.argv, [
      "benzo",
      "dev",
      "--cwd",
      root,
      "--script",
      "dev",
    ]);
    assert.equal(report.trial.framework, "vite");
    assert.deepEqual(inspectPortless(root), report);
    assert.equal(JSON.stringify(report).includes("do-not-print"), false);
    assert.equal(JSON.stringify(report).includes("private-wrapper"), false);
    assert.equal(JSON.stringify(report).includes("env-private-value"), false);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), before);
    assert.deepEqual((await readdir(root)).sort(), [".env", "package.json"]);
    await pkg(root, {
      scripts: { start: "portless named next dev", other: "portless run vite" },
    });
    assert.equal(inspectPortless(root).trial?.requestedName, "named");
    assert.equal(inspectPortless(root, "other").trial?.framework, "vite");
  }));

test("Portless plans reject shell wrappers, hooks, TLS and custom flags without exposing script text", async () =>
  fixture(async (root) => {
    for (const script of [
      "portless run next dev\nnode secret.js",
      "portless run vite && touch marker",
      "portless run --https vite",
      "portless run next dev --experimental-https",
      "portless run vite --config private-config.ts",
      "portless run vite --port 1234",
      "portless run vite --token=credential-private-value",
      "node custom-portless-wrapper.js",
    ]) {
      await pkg(root, { scripts: { dev: script } });
      const report = inspectPortless(root);
      assert.equal(report.status, "unsupported", script);
      assert.equal(report.trial, null);
      assert.equal(JSON.stringify(report).includes("private-value"), false);
    }
    await pkg(root, {
      scripts: { dev: "portless run vite", predev: "touch marker" },
    });
    assert.ok(
      inspectPortless(root).issues.includes("unsupported-portless-wrapper"),
    );
    assert.deepEqual(await readdir(root), ["package.json"]);
  }));

test("Portless plans refuse local configuration and competing Benzo selection", async () =>
  fixture(async (root) => {
    await pkg(root, { scripts: { dev: "portless run vite" } });
    for (const file of [
      "portless.json",
      "portless.config.ts",
      ".portless.json",
      "benzo.config.json",
    ]) {
      await writeFile(
        join(root, file),
        "invalid configuration; must not execute or import",
      );
      assert.equal(inspectPortless(root).status, "unsupported");
      await rm(join(root, file));
    }
    await pkg(root, {
      scripts: { dev: "portless run vite" },
      portless: { token: "private-value" },
    });
    assert.equal(inspectPortless(root).status, "unsupported");
    await pkg(root, {
      scripts: { dev: "portless run vite" },
      benzo: { services: [] },
    });
    assert.ok(
      inspectPortless(root).issues.includes(
        "existing-benzo-configuration-takes-precedence",
      ),
    );
  }));

test("Portless inspection bounds package input and refuses symlinks", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "package.json"), " ".repeat(1048577));
    assert.ok(
      inspectPortless(root).issues.includes("unsupported-package-file"),
    );
    await pkg(root, { scripts: [] });
    assert.ok(inspectPortless(root).issues.includes("invalid-package-scripts"));
    await pkg(root, { scripts: { start: "node server.js" } });
    assert.ok(inspectPortless(root, "dev").issues.includes("missing-script"));
    if (process.platform !== "win32") {
      await rm(join(root, "package.json"));
      await writeFile(
        join(root, "outside.json"),
        '{"scripts":{"dev":"portless run vite"}}',
      );
      await symlink(join(root, "outside.json"), join(root, "package.json"));
      assert.ok(
        inspectPortless(root).issues.includes("unsupported-package-file"),
      );
    }
  }));

test("CLI migration dry-run and dev inspection never launch or write state; unsafe flags fail", async () =>
  fixture(async (root) => {
    await pkg(root, { scripts: { dev: "portless run vite" } });
    const env = { ...process.env, BENZO_HOME: join(root, "home") };
    const run = (args: string[]) =>
      exec(process.execPath, [cli, ...args, "--cwd", root], {
        env,
        timeout: 10000,
      });
    const first = parseObject(
      (await run(["migrate", "portless", "--dry-run", "--json"])).stdout,
    );
    const second = parseObject(
      (await run(["dev", "--from", "portless", "--json"])).stdout,
    );
    assert.deepEqual(second, first);
    assert.equal(first["status"], "http-trial-available");
    for (const args of [
      ["migrate", "portless"],
      ["dev", "--dry-run"],
      ["migrate", "portless", "--dry-run", "--env", "SECRET=private"],
      ["dev", "--from", "portless", "--gateway-port", "1234"],
    ])
      await assert.rejects(run(args));
    assert.deepEqual(await readdir(root), ["package.json"]);
    await pkg(root, { scripts: { dev: "node wrapper.js" } });
    await assert.rejects(
      run(["migrate", "portless", "--dry-run", "--json"]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in error);
        assert.equal(error.code, 1);
        assert.ok("stdout" in error && typeof error.stdout === "string");
        assert.equal(parseObject(error.stdout)["status"], "unsupported");
        return true;
      },
    );
  }));

test("a saved external manifest blocks trial suggestions without changing the association", async () =>
  fixture(async (root) => {
    await pkg(root, { scripts: { dev: "portless run vite" } });
    const manifest = join(root, "external.json");
    await writeFile(
      manifest,
      JSON.stringify({
        services: [{ name: "web", command: "node", args: ["custom.js"] }],
      }),
    );
    const home = join(root, "home");
    const run = (args: string[]) =>
      exec(process.execPath, [cli, ...args, "--cwd", root], {
        env: { ...process.env, BENZO_HOME: home },
        timeout: 10000,
      });
    await run(["link", "--config", manifest]);
    const files = await readdir(join(home, "associations"));
    const file = files[0];
    assert.ok(file);
    const receipt = join(home, "associations", file);
    const before = await readFile(receipt, "utf8");
    await assert.rejects(
      run(["migrate", "portless", "--dry-run", "--json"]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in error);
        assert.equal(error.code, 1);
        assert.ok("stdout" in error && typeof error.stdout === "string");
        const report = parseObject(error.stdout);
        assert.equal(report["trial"], null);
        assert.ok(
          Array.isArray(report["issues"]) &&
            report["issues"].includes(
              "associated-benzo-configuration-takes-precedence",
            ),
        );
        return true;
      },
    );
    assert.equal(await readFile(receipt, "utf8"), before);
    await run(["unlink"]);
    const report = parseObject(
      (await run(["migrate", "portless", "--dry-run", "--json"])).stdout,
    );
    assert.equal(report["status"], "http-trial-available");
  }));
