// Reproducible trials use installed package contents, unchanged upstream source,
// real Git worktrees and real browser DNS. Raw output stays in the ignored cache.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  copyFileSync,
} from "node:fs";
import { readFile, writeFile, rm, appendFile } from "node:fs/promises";
import { resolve, join, delimiter, dirname } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { launch, stop } from "../src/process.js";
import { loadManifest } from "../src/config.js";
import { stateInUrl, sokosumi } from "./consumers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".compat");
mkdirSync(cache, { recursive: true });
const reports = join(root, "compatibility/reports");
mkdirSync(reports, { recursive: true });
const recipes = JSON.parse(
  readFileSync(join(root, "compatibility/recipes/projects.json"), "utf8"),
);
const strict = process.argv.includes("--require-pass");
const selected = process.argv
  .slice(2)
  .filter((arg) => arg !== "--require-pass");
const env = {
  ...process.env,
  BROWSER: "none",
  HUSKY: "0",
  SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
  BENZO_HOME: join(cache, "home"),
  PATH: [
    join(cache, "consumer-tools/node_modules/.bin"),
    join(cache, "tools/node_modules/.bin"),
    process.env.PATH,
  ].join(delimiter),
};
let installedCli;
let build;
const activeChildren = new Set();
const cancellation = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    cancellation.abort(new Error("Compatibility run interrupted."));
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    await Promise.all([...activeChildren].map((child) => stop(child)));
  });
function track(child) {
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}
async function run(command, args, cwd = process.cwd(), timeout = 600000) {
  const child = track(launch(command, args, cwd, env));
  let output = "";
  const log = createWriteStream(join(cache, "commands.log"), {
    flags: "a",
    mode: 0o600,
  });
  for (const pipe of [child.stdout, child.stderr])
    pipe.on("data", (data) => {
      output = `${output}${data}`.slice(-65536);
      log.write(data);
    });
  let timer;
  let timedOut = false;
  try {
    await new Promise((accept, reject) => {
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
function background(command, args, cwd, additions = {}) {
  const child = track(launch(command, args, cwd, { ...env, ...additions }));
  child.output = "";
  const log = createWriteStream(join(cache, "services.log"), {
    flags: "a",
    mode: 0o600,
  });
  for (const pipe of [child.stdout, child.stderr])
    pipe.on("data", (data) => {
      child.output = `${child.output}${data}`.slice(-8192);
      log.write(data);
    });
  child.once("close", () => log.end());
  child.on("error", (error) => {
    child.startupError = error;
  });
  return child;
}
async function waitFor(check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
    await delay(150);
  }
  throw last ?? new Error("Readiness timed out.");
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function packageBuild() {
  await run("pnpm", ["pack", "--pack-destination", cache]);
  const tarball = join(cache, "benzo-0.1.0.tgz");
  build = createHash("sha256").update(readFileSync(tarball)).digest("hex");
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
      join(cache, "install/node_modules/benzo/src/runtime.js"),
      "utf8",
    ),
    readFileSync(join(root, "src/runtime.js"), "utf8"),
  );
  installedCli = join(cache, "install/node_modules/benzo/src/cli.js");
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
}
async function getState(cwd) {
  const value = JSON.parse(
    await run(
      process.execPath,
      [installedCli, "status", "--json", "--cwd", cwd],
      root,
      5000,
    ),
  );
  return value.status === "ready" ? value : undefined;
}
async function journey(page, url) {
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
        return (
          JSON.parse(localStorage.getItem("excalidraw") ?? "[]").length > 0
        );
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 15000 },
  );
}
async function excalidraw(recipe, checkout, report) {
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
  let baseline;
  let browser;
  const children = [];
  const worktrees = [];
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
    const states = [];
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
    }
    assert.equal(states[0].name, "feature");
    assert.equal(states[1].name, "feature-2");
    assert.notEqual(states[0].ports.web, states[1].ports.web);
    const context = await browser.newContext();
    const one = await context.newPage();
    const two = await context.newPage();
    let connected = false;
    one.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        try {
          if (JSON.parse(frame.payload).type === "connected") connected = true;
        } catch {}
      });
    });
    await journey(one, states[0].urls.web);
    await journey(two, states[1].urls.web);
    report.scenarios.push(
      { case: "two-worktrees-browser-drawing", result: "passed" },
      { case: "active-name-collision", result: "passed" },
    );
    const stimulus = join(worktrees[0], recipe.hmrFile);
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
    await run(process.execPath, [installedCli, "stop", "--cwd", worktrees[0]]);
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
  }
}
await packageBuild();
if (selected.some((name) => !recipes.some((recipe) => recipe.name === name)))
  throw new Error(
    "Unknown compatibility recipe. Select a name from compatibility/recipes/projects.json.",
  );
let failed = false;
for (const recipe of recipes.filter(
  (recipe) => !selected.length || selected.includes(recipe.name),
)) {
  if (cancellation.signal.aborted) break;
  const report = {
    project: recipe.name,
    repository: recipe.repository,
    commit: recipe.commit,
    benzoBuild: build,
    testedAt: new Date().toISOString(),
    platform: {
      os: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    baseline: "not-run",
    result: "not-run",
    applicationChangesRequired: null,
    scenarios: [],
    schemaVersion: 2,
    replacement: "not-established",
    execution: "running",
    reproduction: `pnpm test:compat ${recipe.name}`,
  };
  Object.defineProperty(report, "onFailure", {
    value: (name, error) =>
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
    try {
      loadManifest(checkout);
      report.discovery = "passed";
    } catch (error) {
      report.discovery = "unsupported";
      report.discoveryDiagnostic = error.message;
    }
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
    report.reason = error.message.replaceAll(cache, "<cache>");
  }
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
