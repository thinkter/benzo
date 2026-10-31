import type { Page, Browser } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import type { JsonValue } from "#production/types";
import type { BenchChild, BenchState, Recipe, Report } from "./types.js";
import {
  json,
  object,
  text,
  port as tcpPort,
  item,
  recipesFrom,
} from "./values.js";
import { jsonObject, supervisorState } from "#production/wire";
// Reproducible trials use installed package contents, unchanged upstream source,
// real Git worktrees and real browser DNS. Raw output stays in the ignored cache.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  copyFileSync,
} from "node:fs";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve, join, delimiter, dirname } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { launch, stop } from "#production/process";
import { loadManifest } from "#production/config";
import { harnessProvenance, refusesConnection } from "./evidence.js";
import { stateInUrl, sokosumi, consumerReproduction } from "./consumers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cache = join(root, ".compat");
mkdirSync(cache, { recursive: true });
const reports = join(root, "compatibility/reports");
mkdirSync(reports, { recursive: true });
const recipes = recipesFrom(
  readFileSync(join(root, "compatibility/recipes/projects.json"), "utf8"),
);
const strict = process.argv.includes("--require-pass");
const selected = process.argv
  .slice(2)
  .filter((arg) => arg !== "--require-pass");
const env = {
  ...process.env,
  BENZO_COMPAT_APPS: process.env["BENZO_COMPAT_APPS"],
  BROWSER: "none",
  HUSKY: "0",
  SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
  BENZO_HOME: join(cache, `bench-home-${randomUUID()}`),
  PATH: [
    join(cache, "consumer-tools/node_modules/.bin"),
    join(cache, "tools/node_modules/.bin"),
    process.env["PATH"],
  ].join(delimiter),
};
const activeChildren = new Set<ChildProcess>();
const cancellation = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    cancellation.abort(new Error("Compatibility run interrupted."));
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    await Promise.all([...activeChildren].map((child) => stop(child)));
  });
function track<T extends ChildProcess>(child: T): T {
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}
async function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
  timeout = 600000,
) {
  const child = track(launch(command, args, cwd, env));
  let output = "";
  const log = createWriteStream(join(cache, "commands.log"), {
    flags: "a",
    mode: 0o600,
  });
  for (const pipe of [child.stdout, child.stderr])
    pipe?.on("data", (data: Buffer) => {
      output = `${output}${data}`.slice(-65536);
      log.write(data);
    });
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    await new Promise<void>((accept, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        void stop(child).then(
          () => reject(new Error(`Command timed out: ${command}`)),
          reject,
        );
      }, timeout);
      child.once("error", reject);
      child.once("close", (code) =>
        timedOut
          ? reject(new Error(`Command timed out: ${command}`))
          : code === 0
            ? accept()
            : reject(new Error(`Command failed: ${command} (exit ${code})`)),
      );
    });
    return output;
  } finally {
    clearTimeout(timer);
    if (timedOut) await stop(child);
    log.end();
  }
}
function background(
  command: string,
  args: string[],
  cwd: string,
  additions: NodeJS.ProcessEnv = {},
): BenchChild {
  const child: BenchChild = Object.assign(
    track(launch(command, args, cwd, { ...env, ...additions })),
    { output: "" },
  );
  const log = createWriteStream(join(cache, "services.log"), {
    flags: "a",
    mode: 0o600,
  });
  for (const pipe of [child.stdout, child.stderr])
    pipe?.on("data", (data: Buffer) => {
      child.output = `${child.output}${data}`.slice(-8192);
      log.write(data);
    });
  child.once("close", () => log.end());
  child.on("error", (error) => {
    child.startupError = error;
  });
  return child;
}
async function waitFor<T>(check: () => T | Promise<T>, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last: Error | undefined;
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error instanceof Error && "fatal" in error && error.fatal)
        throw error;
      last =
        error instanceof Error ? error : new Error("Readiness check failed.");
    }
    await delay(150);
  }
  throw last ?? new Error("Readiness timed out.");
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function auditRejectedBare(checkout: string, report: Report) {
  report.bare = { argv: [], cwd: "repository-root", result: "running" };
  const child = background(
    join(cache, "install/node_modules/.bin/benzo"),
    [],
    checkout,
  );
  try {
    await waitFor(
      () =>
        child.exitCode !== null ||
        child.signalCode !== null ||
        child.startupError,
      15000,
    );
    assert.equal(
      child.exitCode,
      1,
      "Expected discovery refusal, not successful application startup",
    );
    assert.match(child.output, /script starts an orchestrator/);
    report.bare.result = "unsupported";
    report.bare.exitCode = child.exitCode;
    report.bare.reason =
      "Root script is an orchestrator; no automatic adaptation is attempted.";
  } catch {
    report.bare.result = "failed";
    report.bare.reason = "Unexpected exit or timeout; see private logs.";
  } finally {
    await stop(child);
  }
}
async function packageBuild() {
  await run("pnpm", ["pack", "--pack-destination", cache]);
  const tarball = join(cache, "benzo-0.1.0.tgz");
  const build = createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex");
  const immutableTarball = join(cache, `benzo-${build}.tgz`);
  copyFileSync(tarball, immutableTarball);
  await run("npm", [
    "install",
    "--prefix",
    join(cache, "install"),
    immutableTarball,
    "--ignore-scripts",
  ]);
  assert.equal(
    readFileSync(
      join(cache, "install/node_modules/benzo/dist/runtime.js"),
      "utf8",
    ),
    readFileSync(join(root, "dist/runtime.js"), "utf8"),
  );
  const installedCli = join(cache, "install/node_modules/benzo/dist/cli.js");
  assert.match(
    await run(process.execPath, [installedCli, "--version"]),
    /0\.1\.0/,
  );
  assert.match(
    await run(join(cache, "install/node_modules/.bin/benzo"), ["--version"]),
    /0\.1\.0/,
  );
  assert.match(
    await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const api = await import('benzo'); console.log(typeof api.createGateway, typeof api.loadManifest)",
      ],
      join(cache, "install"),
    ),
    /function function/,
  );
  return { installedCli, build };
}
async function getState(cwd: string): Promise<BenchState | undefined> {
  const stdout = await run(
    process.execPath,
    [installedCli, "status", "--json", "--cwd", cwd],
    root,
    5000,
  );
  return jsonObject(stdout)["status"] === "ready"
    ? supervisorState(stdout)
    : undefined;
}
async function journey(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page
    .locator("canvas.excalidraw__canvas")
    .first()
    .waitFor({ timeout: 90000 });
  await page.keyboard.press("r");
  await page.mouse.move(450, 350);
  await page.mouse.down();
  await page.mouse.move(650, 480, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    () => {
      try {
        const stored: JsonValue = JSON.parse(
          localStorage.getItem("excalidraw") ?? "[]",
        );
        return Array.isArray(stored) && stored.length > 0;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 15000 },
  );
}
async function excalidraw(recipe: Recipe, checkout: string, report: Report) {
  if (!existsSync(join(cache, "tools/node_modules/.bin/yarn")))
    await run("npm", [
      "install",
      "--prefix",
      join(cache, "tools"),
      "yarn@1.22.22",
      "--ignore-scripts",
    ]);
  console.log("Excalidraw: installing pinned upstream dependencies");
  await run(
    "yarn",
    ["install", "--frozen-lockfile", "--non-interactive"],
    checkout,
  );
  const baselinePort = await freePort();
  let baseline: BenchChild | undefined;
  let browser: Browser | undefined;
  const children: BenchChild[] = [];
  const worktrees: string[] = [];
  const listenerPorts = [baselinePort];
  const gatewayPorts = new Set<number>();
  try {
    browser = await chromium.launch({ headless: true });
    const baselineContext = await browser.newContext();
    const baselinePage = await baselineContext.newPage();
    baseline = background(
      "yarn",
      [
        "run",
        recipe.baselineScript,
        "--host",
        "127.0.0.1",
        "--port",
        String(baselinePort),
        "--strictPort",
      ],
      checkout,
    );
    console.log("Excalidraw: original command and browser drawing baseline");
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${baselinePort}`);
      return response.ok;
    });
    await journey(baselinePage, `http://127.0.0.1:${baselinePort}`);
    report.baseline = "passed";
    await baselineContext.close();
    await stop(baseline);
    baseline = undefined;
    // A literal no-argument invocation is a separate acceptance lane. Custom
    // gateway flags below must never be reported as proof that bare Benzo works.
    report.bare = { argv: [], cwd: "repository-root", result: "running" };
    const bareContext = await browser.newContext();
    let bare: BenchChild | undefined;
    try {
      bare = background(
        join(cache, "install/node_modules/.bin/benzo"),
        [],
        checkout,
      );
      const state = await waitFor(async () => {
        if (!bare || bare.startupError || bare.exitCode !== null)
          throw Object.assign(
            new Error(
              "Bare Benzo exited before readiness; inspect private service logs.",
            ),
            { fatal: true },
          );
        return getState(checkout);
      }, 45000);
      listenerPorts.push(...Object.values(state.ports).map(tcpPort), 2999);
      gatewayPorts.add(3000);
      assert.equal(new URL(text(state.urls["web"])).port, "3000");
      await journey(await bareContext.newPage(), text(state.urls["web"]));
      report.bare.result = "passed";
      report.scenarios.push({
        case: "bare-root-browser-drawing",
        result: "passed",
      });
    } catch (error) {
      report.bare.result = "failed";
      report.bare.reason = (
        error instanceof Error ? error.message : "Compatibility command failed."
      ).replaceAll(cache, "<cache>");
    } finally {
      await bareContext.close();
      if (bare) {
        await stop(bare);
        await waitFor(async () => !(await getState(checkout)), 15000);
      }
    }
    report.configured = {
      argv: ["dev", "--cwd", "<worktree>", "--gateway-port", "<allocated>"],
      result: "running",
    };
    for (const label of ["a", "b"]) {
      const cwd = join(cache, "worktrees", `excalidraw-${label}`, "feature");
      if (!existsSync(join(cwd, ".git")))
        await run(
          "git",
          ["worktree", "add", "--detach", cwd, recipe.commit],
          checkout,
        );
      await run(
        "yarn",
        ["install", "--offline", "--frozen-lockfile", "--non-interactive"],
        cwd,
      );
      worktrees.push(cwd);
    }
    const gatewayPort = await freePort();
    const states: BenchState[] = [];
    console.log("Excalidraw: two real worktrees through installed Benzo");
    for (const cwd of worktrees) {
      children.push(
        background(
          process.execPath,
          [
            installedCli,
            "dev",
            "--cwd",
            cwd,
            "--gateway-port",
            String(gatewayPort),
          ],
          root,
        ),
      );
      states.push(await waitFor(() => getState(cwd)));
      listenerPorts.push(
        ...Object.values(item(states, states.length - 1).ports).map(tcpPort),
        gatewayPort - 1,
      );
      gatewayPorts.add(gatewayPort);
    }
    assert.equal(item(states, 0).name, "feature");
    assert.equal(item(states, 1).name, "feature-2");
    assert.notEqual(
      tcpPort(item(states, 0).ports["web"]),
      tcpPort(item(states, 1).ports["web"]),
    );
    const context = await browser.newContext();
    const one = await context.newPage();
    const two = await context.newPage();
    let connected = false;
    one.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        try {
          if (object(json(frame.payload.toString()))["type"] === "connected")
            connected = true;
        } catch {}
      });
    });
    await journey(one, text(item(states, 0).urls["web"]));
    await journey(two, text(item(states, 1).urls["web"]));
    report.scenarios.push(
      { case: "two-worktrees-browser-drawing", result: "passed" },
      { case: "active-name-collision", result: "passed" },
    );
    const stimulus = join(item(worktrees, 0), text(recipe.hmrFile));
    const original = await readFile(stimulus, "utf8");
    try {
      await writeFile(
        stimulus,
        `${original}\n:root { --benzo-compat-marker: worktree-a; }\n`,
      );
      await one.waitForFunction(
        () =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--benzo-compat-marker")
            .trim() === "worktree-a",
        undefined,
        { timeout: 30000 },
      );
      assert.equal(
        await two.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--benzo-compat-marker")
            .trim(),
        ),
        "",
      );
      assert.ok(connected);
      report.scenarios.push({
        case: "hmr-websocket-and-worktree-isolation",
        result: "passed",
      });
    } finally {
      await writeFile(stimulus, original);
    }
    await run(process.execPath, [
      installedCli,
      "stop",
      "--cwd",
      item(worktrees, 0),
    ]);
    await two.reload();
    await two.locator("canvas.excalidraw__canvas").first().waitFor();
    report.scenarios.push({
      case: "stop-one-preserves-peer",
      result: "passed",
    });
    await context.close();
    for (const cwd of [checkout, ...worktrees])
      assert.equal(
        (
          await run("git", ["status", "--short", "--untracked-files=all"], cwd)
        ).trim(),
        "",
      );
    report.configured.result = "passed";
    report.sourceUnchanged = true;
    report.applicationChangesRequired = false;
    report.result = "passed";
  } finally {
    if (baseline) await stop(baseline);
    for (const cwd of worktrees)
      await run(process.execPath, [installedCli, "stop", "--cwd", cwd]).catch(
        () => {},
      );
    await Promise.all(children.map((child) => stop(child)));
    await browser?.close();
    for (const port of listenerPorts)
      await waitFor(() => refusesConnection(port), 15000);
    for (const gatewayPort of gatewayPorts) {
      for (const address of ["127.0.0.1", "::1"])
        await waitFor(() => refusesConnection(gatewayPort, address), 15000);
    }
    report.cleanupScope = {
      baseline: "IPv4 loopback",
      services: "IPv4 loopback",
      control: "IPv4 loopback",
      gateways: ["127.0.0.1", "::1"],
    };
    report.listenerCleanup = "passed";
  }
}
const { installedCli, build } = await packageBuild();
if (selected.some((name) => !recipes.some((recipe) => recipe.name === name)))
  throw new Error(
    "Unknown compatibility recipe. Select a name from compatibility/recipes/projects.json.",
  );
let failed = false;
for (const recipe of recipes.filter(
  (recipe) => !selected.length || selected.includes(recipe.name),
)) {
  if (cancellation.signal.aborted) break;
  const report: Report = {
    project: recipe.name,
    repository: recipe.repository,
    commit: recipe.commit,
    benzoBuild: build,
    ...harnessProvenance(root),
    testedAt: new Date().toISOString(),
    platform: {
      os: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    bare: { argv: [], cwd: "repository-root", result: "not-run" },
    configured: { result: "not-run" },
    baseline: "not-run",
    result: "not-run",
    applicationChangesRequired: null,
    scenarios: [],
    schemaVersion: 2,
    replacement: "not-established",
    execution: "running",
    reproduction: consumerReproduction(recipe.name, env["BENZO_COMPAT_APPS"]),
  };
  Object.defineProperty(report, "onFailure", {
    value: (name: string, error: Error) =>
      appendFile(join(cache, "assertions.log"), `${name}\n${error.stack}\n`, {
        mode: 0o600,
      }),
  });
  Object.defineProperty(report, "onScenario", {
    value: () =>
      writeFileSync(
        join(reports, `${recipe.name}-${process.platform}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      ),
  });
  await report.onScenario?.();
  try {
    const checkout = join(cache, recipe.name);
    if (!existsSync(join(checkout, ".git"))) {
      await run("git", [
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        recipe.repository,
        checkout,
      ]);
      await run("git", ["checkout", "--detach", recipe.commit], checkout);
    }
    assert.equal(
      (await run("git", ["rev-parse", "HEAD"], checkout)).trim(),
      recipe.commit,
      "Cached project must match pinned commit.",
    );
    assert.equal(
      (
        await run(
          "git",
          ["status", "--short", "--untracked-files=all"],
          checkout,
        )
      ).trim(),
      "",
      "Refusing a dirty consumer checkout",
    );
    try {
      loadManifest(checkout);
      report.discovery = "passed";
    } catch (error) {
      report.discovery = "unsupported";
      report.discoveryDiagnostic =
        error instanceof Error ? error.message : "Discovery failed.";
    }
    if (
      report.discovery === "unsupported" &&
      /script starts an orchestrator/.test(report.discoveryDiagnostic ?? "")
    )
      await auditRejectedBare(checkout, report);
    await report.onScenario?.();
    for (const tool of recipe.requiredTools) {
      try {
        await run(tool, ["version"], root, 10000);
      } catch {
        report.baseline = "blocked";
        report.result = "blocked";
        report.reason = `Missing usable ${tool}. ${recipe.prerequisite}`;
      }
    }
    if (report.result !== "blocked") {
      if (recipe.name === "excalidraw")
        await excalidraw(recipe, checkout, report);
      else if (["state-in-url", "sokosumi"].includes(recipe.name))
        await (recipe.name === "state-in-url" ? stateInUrl : sokosumi)({
          recipe,
          checkout,
          report,
          cache,
          root,
          installedCli,
          run,
          background,
          waitFor,
          freePort,
          getState,
          env,
          signal: cancellation.signal,
        });
      else {
        report.result = "not-run";
        report.reason =
          "The pinned application journey has not been implemented; prerequisites alone are not acceptance.";
      }
    }
  } catch (error) {
    failed = true;
    report.result = report.baseline === "passed" ? "failed" : "blocked";
    report.reason = (
      error instanceof Error ? error.message : "Compatibility command failed."
    ).replaceAll(cache, "<cache>");
  }
  if (report.bare?.result === "failed" && report.result === "passed") {
    report.result = "failed";
    report.reason =
      "Configured journeys passed, but the bare-root lane failed.";
    failed = true;
  }
  if (report.configured?.result === "running")
    report.configured.result = "failed";
  if (report.result === "blocked" && report.configured?.result === "not-run")
    report.configured = { result: "blocked", reason: report.reason };
  report.execution = cancellation.signal.aborted ? "interrupted" : "completed";
  writeFileSync(
    join(reports, `${recipe.name}-${process.platform}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `${recipe.name}: ${report.result}${report.reason ? ` — ${report.reason}` : ""}`,
  );
  if (strict && report.result !== "passed") failed = true;
}
if (failed && !cancellation.signal.aborted) process.exitCode = 1;
