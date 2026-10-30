import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { request } from "node:http";
import { chromium, expect } from "@playwright/test";
import { stop } from "../src/process.js";
import { scenario, replacementVerdict } from "./acceptance.mjs";

const examples = ["react", "react-router6", "react-router7", "remix2", "astro", "nextjs14", "nextjs15", "nextjs16"];
function reachable(port, host = "localhost") {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, headers: { host }, timeout: 120000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error("HTTP readiness timed out")));
    req.end();
  });
}

// Adapted from upstream tests/useUrlState/{main,history}.spec.ts. The app stays
// unchanged; the same assertions run at baseline, Portless and Benzo origins.
async function journey(page, origin, app, marker = "Benzo consumer") {
  const route = app.startsWith("nextjs") ? "/test-use-client" : "/";
  await page.goto(`${origin}${route}?replace=false`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const name = app === "react" ? page.locator('input#name').first() : page.getByLabel("name", { exact: true });
  await expect(name).toBeVisible({ timeout: 90000 });
  await name.fill(marker);
  const parsed = page.getByTestId("parsed");
  await expect.poll(async () => JSON.parse(await parsed.textContent()).name).toBe(marker);
  if (app !== "react") {
    await expect.poll(() => new URL(page.url()).searchParams.get("name")).toContain(marker);
    const saved = page.url();
    await page.reload();
    await expect(name).toHaveValue(marker, { timeout: 60000 });
    assert.equal(page.url(), saved);
    await name.fill(`${marker} again`);
    await expect.poll(() => new URL(page.url()).searchParams.get("name")).toContain(`${marker} again`);
    await page.goBack();
    await expect(name).toHaveValue(marker);
    await page.goForward();
    await expect(name).toHaveValue(`${marker} again`);
  } else {
    await expect(page.getByTestId("name-input")).toHaveValue(marker);
  }
}

export async function stateInUrl(h) {
  const { checkout, cache, root, report, recipe, run, background, freePort, installedCli, waitFor, getState } = h;
  const pnpm = join(cache, "consumer-tools/node_modules/.bin/pnpm");
  if (!existsSync(pnpm)) await run("npm", ["install", "--prefix", join(cache, "consumer-tools"), "pnpm@10.26.0", "--ignore-scripts"]);
  const launchEnv = { PATH: [join(cache, "consumer-tools/node_modules/.bin"), h.env.PATH].join(delimiter), npm_config_manage_package_manager_versions: "false" };
  assert.match(await run(pnpm, ["--version"]), /10\.26\.0/);
  console.log("state-in-url: frozen workspace install and library build");
  await run(pnpm, ["install", "--frozen-lockfile"], checkout);
  await run(pnpm, ["run", "build"], checkout);
  report.packageManager = "pnpm@10.26.0";
  report.setup = { applicationEdits: 0, manifestFiles: 0, baselineCommands: ["pnpm install --frozen-lockfile", "pnpm run build"], benzoFlags: ["--cwd", "--name", "--gateway-port"], environmentOverrides: [], upstreamShellScriptsPortable: false };
  const worktrees = [];
  for (const label of ["a", "b"]) {
    const cwd = join(cache, "worktrees", `state-in-url-${label}`, "feature");
    if (!existsSync(join(cwd, ".git"))) await run("git", ["worktree", "add", "--detach", cwd, recipe.commit], checkout);
    assert.equal((await run("git", ["rev-parse", "HEAD"], cwd)).trim(), recipe.commit);
    await run(pnpm, ["install", "--frozen-lockfile"], cwd);
    await run(pnpm, ["run", "build"], cwd);
    worktrees.push(cwd);
  }
  const browser = await chromium.launch();
  report.browser = { name: "chromium", version: browser.version() };
  const selected = process.env.BENZO_COMPAT_APPS?.split(",") ?? examples;
  assert.ok(selected.every((app) => examples.includes(app)), "Unknown BENZO_COMPAT_APPS example");
  const required = [];
  try {
    for (const app of examples) {
      if (!selected.includes(app)) {
        report.scenarios.push({ case: `${app}:consumer-parity`, result: "not-run" });
        continue;
      }
      const folder = `packages/example-${app}`;
      const cwd = join(checkout, folder);
      const baselinePort = await freePort();
      console.log(`state-in-url: ${app} baseline, Portless, Benzo worktrees`);
      const original = background(pnpm, ["run", "dev"], cwd, { ...launchEnv, PORT: String(baselinePort) });
      let baseline;
      try {
        baseline = await scenario(report, `${app}:baseline`, async () => {
          await waitFor(() => reachable(baselinePort));
          const context = await browser.newContext();
          try { await journey(await context.newPage(), `http://localhost:${baselinePort}`, app); }
          finally { await context.close(); }
        }, { lane: "original-command" });
      } finally { await stop(original); }
      if (!baseline) {
        report.scenarios.push({ case: `${app}:consumer-parity`, result: "blocked", reason: "Original-command journey failed; Benzo parity cannot be evaluated." });
        continue;
      }
      // Portless's actual version is pinned by the upstream lockfile. Isolate its
      // state and disable HTTPS exactly as this consumer's wrapper does.
      const portlessPackage = JSON.parse(await readFile(join(checkout, "node_modules/portless/package.json"), "utf8"));
      report.competitor = { name: "portless", version: portlessPackage.version };
      const portlessPort = await freePort();
      const portlessHome = join(cache, `portless-${app}`);
      const portlessEnv = { ...launchEnv, PORTLESS_PORT: String(portlessPort), PORTLESS_HTTPS: "0", PORTLESS_STATE_DIR: portlessHome };
      const portlessCli = join(checkout, "node_modules/portless", typeof portlessPackage.bin === "string" ? portlessPackage.bin : portlessPackage.bin.portless);
      const competitor = background(process.execPath, [portlessCli, "run", "--name", `example-${app}`, "--app-port", String(await freePort()), "--", pnpm, "run", "dev"], cwd, portlessEnv);
      const origin = `http://example-${app}.localhost:${portlessPort}`;
      let competitorPassed;
      try {
        competitorPassed = await scenario(report, `${app}:portless`, async () => {
          await waitFor(() => reachable(portlessPort, new URL(origin).host));
          const context = await browser.newContext();
          try { await journey(await context.newPage(), origin, app); }
          finally { await context.close(); }
        }, { lane: "portless", origin });
      } finally {
        await stop(competitor);
        // Only stop the proxy whose isolated state/port we created.
        const proxyStop = background(process.execPath, [portlessCli, "proxy", "stop"], cwd, portlessEnv);
        await new Promise((accept) => { proxyStop.once("close", accept); proxyStop.once("error", accept); });
        await stop(proxyStop);
      }
      const children = [];
      const serviceCwds = worktrees.map((tree) => join(tree, folder));
      const gatewayPort = portlessPort; // exact scheme, hostname and port parity
      const testCase = `${app}:consumer-parity`;
      required.push(`${app}:baseline`, `${app}:portless`, testCase);
      try {
        await scenario(report, testCase, async (entry) => {
          const states = [];
          // Concurrent startup also exercises allocation rather than fixed tables.
          for (const tree of serviceCwds) children.push(background(process.execPath, [installedCli, "dev", "--cwd", tree, "--name", `example-${app}`, "--gateway-port", String(gatewayPort)], root, launchEnv));
          for (const tree of serviceCwds) states.push(await waitFor(() => getState(tree)));
          assert.notEqual(states[0].ports.web, states[1].ports.web);
          assert.deepEqual(new Set(states.map((s) => s.name)), new Set([`example-${app}`, `example-${app}-2`]));
          assert.ok(states.some((s) => s.urls.web === origin), "Original complete origin must be preserved");
          entry.originPreserved = true;
          entry.comparedWithPortless = competitorPassed;
          const context = await browser.newContext();
          try {
            const pages = await Promise.all([context.newPage(), context.newPage()]);
            for (const [i, page] of pages.entries()) await journey(page, states[i].urls.web, app, `Worktree ${i}`);
            if (app === "react") {
              const file = join(worktrees[0], "packages/shared/styles.css");
              const source = await readFile(file, "utf8");
              try {
                await writeFile(file, `${source}\n:root { --benzo-consumer-hmr: worktree-a; }\n`);
                await pages[0].waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--benzo-consumer-hmr").trim() === "worktree-a");
                assert.equal(await pages[1].evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--benzo-consumer-hmr").trim()), "");
                entry.hmrIsolation = "passed";
              } finally { await writeFile(file, source); }
            }
            await run(process.execPath, [installedCli, "stop", "--cwd", serviceCwds[0]]);
            await journey(pages[1], states[1].urls.web, app, "Surviving peer");
            entry.stopPreservesPeer = true;
          } finally { await context.close(); }
        }, { lane: "packaged-benzo", applicationEdits: 0, manifestFiles: 0 });
      } finally {
        for (const tree of serviceCwds) await run(process.execPath, [installedCli, "stop", "--cwd", tree]).catch(() => {});
        await Promise.all(children.map((child) => stop(child)));
        await waitFor(async () => !(await getState(serviceCwds[0])) && !(await getState(serviceCwds[1])), 10000);
      }
    }
  } finally { await browser.close(); }
  for (const tree of [checkout, ...worktrees]) assert.equal((await run("git", ["status", "--short", "--untracked-files=all"], tree)).trim(), "", "Consumer source/config must stay unchanged");
  report.sourceUnchanged = true;
  report.applicationChangesRequired = false;
  report.baseline = report.scenarios.some((s) => s.lane === "original-command" && s.result === "passed") ? "passed" : "failed";
  report.result = report.scenarios.some((s) => s.result === "failed") ? "failed" : report.scenarios.some((s) => s.result === "blocked" || s.result === "not-run") ? "partial" : "passed";
  report.replacement = replacementVerdict(report.scenarios, examples.flatMap((app) => [`${app}:baseline`, `${app}:portless`, `${app}:consumer-parity`]));
  report.scope = "Eight example apps; upstream root Wireit orchestration and literal-origin upstream E2E suite are not replaced. Assertions are adapted from upstream, not the entire upstream test suite.";
  if (report.result === "failed") process.exitCode = 1;
}

export async function sokosumi({ report }) {
  report.result = "blocked";
  report.reason = "No isolated PostgreSQL/auth baseline established; consumer also explicitly requires trusted HTTPS on port 443, which Benzo does not implement.";
  report.scenarios.push({ case: "complete-origin-preservation", result: "failed", category: "missing-tls", expected: "https://web.sokosumi.localhost on implicit 443", actual: "Benzo currently exposes HTTP origins only" }, { case: "login-core-web-session-isolation", result: "blocked", reason: "Requires a runnable isolated backend and HTTPS baseline" });
  report.applicationChangesRequired = null;
  report.replacement = "not-established";
}
