import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { launch, stop } from "../../src/process.js";
const root = resolve(".");
const cli = resolve("src/cli.js");
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function command(args, cwd, env) {
  const child = launch(
    process.execPath,
    [cli, ...args, "--cwd", cwd],
    root,
    env,
  );
  child.output = "";
  for (const pipe of [child.stdout, child.stderr])
    pipe.on("data", (data) => (child.output += data));
  child.done = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? accept(child.output) : reject(new Error(child.output)),
    );
  });
  child.done.catch(() => {});
  return child;
}
async function waitState(cwd, env, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const output = await command(["status", "--json"], cwd, env).done;
    const state = JSON.parse(output);
    if (state.status === "ready") return state;
    await delay(150);
  }
  throw new Error("Fixture did not become ready.");
}
for (const framework of ["vite", "next"])
  test(
    `${framework}: unchanged baseline and two named apps support interaction, HMR and session-origin separation`,
    { timeout: 180000 },
    async () => {
      await mkdir(join(root, ".compat"), { recursive: true });
      const directory = await mkdtemp(join(root, ".compat", `${framework}-`));
      const env = {
        ...process.env,
        BENZO_HOME: join(directory, "home"),
        NEXT_TELEMETRY_DISABLED: "1",
      };
      const gatewayPort = await port();
      const children = [];
      let browser;
      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        context.setDefaultTimeout(25000);
        const worktrees = [];
        for (const name of ["first", "second"]) {
          const cwd = join(directory, name);
          worktrees.push(cwd);
          await mkdir(cwd);
          await symlink(
            join(root, "node_modules"),
            join(cwd, "node_modules"),
            process.platform === "win32" ? "junction" : "dir",
          );
          await writeFile(
            join(cwd, "package.json"),
            JSON.stringify({
              name: `benzo-${name}-fixture`,
              private: true,
              scripts: { dev: framework === "vite" ? "vite" : "next dev" },
            }),
          );
          if (framework === "vite") {
            await writeFile(
              join(cwd, "index.html"),
              '<title>Vite fixture</title><button id="counter">0</button><div id="marker">first</div><script type="module" src="/main.js"></script>',
            );
            await writeFile(
              join(cwd, "main.js"),
              "import './style.css'; let n=0; document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent=String(++n)",
            );
            await writeFile(
              join(cwd, "style.css"),
              ":root { --fixture: first; }",
            );
          } else {
            await mkdir(join(cwd, "app"));
            await writeFile(
              join(cwd, "app/layout.js"),
              "export default function Layout({children}) { return <html><body>{children}</body></html> }",
            );
            await writeFile(
              join(cwd, "app/page.js"),
              "'use client'; import { useState } from 'react'; export default function Page(){ const [n,setN]=useState(0); return <><button id='counter' onClick={()=>setN(n+1)}>{n}</button><div id='marker'>first</div></> }",
            );
          }
        }
        // Establish the ordinary framework baseline with exactly the same source.
        const baselinePort = await port();
        const entry = resolve(
          `node_modules/${framework === "next" ? "next/dist/bin/next" : "vite/bin/vite.js"}`,
        );
        const baseline = launch(
          process.execPath,
          [
            entry,
            ...(framework === "next" ? ["dev", "--hostname"] : ["--host"]),
            "127.0.0.1",
            "--port",
            String(baselinePort),
          ],
          worktrees[0],
          env,
        );
        children.push(baseline);
        baseline.stdout.resume();
        baseline.stderr.resume();
        const baselinePage = await context.newPage();
        await baselinePage
          .goto(`http://127.0.0.1:${baselinePort}`, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          })
          .catch(async () => {
            await delay(2000);
            await baselinePage.goto(`http://127.0.0.1:${baselinePort}`, {
              timeout: 60000,
            });
          });
        await baselinePage.locator("#counter").click();
        await baselinePage
          .locator("#counter")
          .filter({ hasText: "1" })
          .waitFor();
        await baselinePage.close();
        await stop(baseline);
        const states = [];
        for (const cwd of worktrees) {
          const child = command(
            ["dev", "--gateway-port", String(gatewayPort)],
            cwd,
            env,
          );
          children.push(child);
          try {
            states.push(await waitState(cwd, env));
          } catch (error) {
            throw new Error(`${error.message}\n${child.output.slice(-2000)}`);
          }
        }
        const one = await context.newPage();
        const two = await context.newPage();
        await one.goto(states[0].urls.web);
        await two.goto(states[1].urls.web);
        await one.locator("#counter").click();
        await one.locator("#counter").filter({ hasText: "1" }).waitFor();
        assert.equal(await two.locator("#counter").innerText(), "0");
        if (framework === "vite") {
          await writeFile(
            join(worktrees[0], "style.css"),
            ":root { --fixture: updated; }",
          );
          await one.waitForFunction(
            () =>
              getComputedStyle(document.documentElement)
                .getPropertyValue("--fixture")
                .trim() === "updated",
          );
          assert.equal(
            await two.evaluate(() =>
              getComputedStyle(document.documentElement)
                .getPropertyValue("--fixture")
                .trim(),
            ),
            "first",
          );
        } else {
          const pagePath = join(worktrees[0], "app/page.js");
          await writeFile(
            pagePath,
            (await readFile(pagePath, "utf8")).replace(">first<", ">updated<"),
          );
          await one.locator("#marker").filter({ hasText: "updated" }).waitFor();
          assert.equal(await one.locator("#counter").innerText(), "1");
          assert.equal(await two.locator("#marker").innerText(), "first");
        }
        await command(["stop"], worktrees[0], env).done;
        await two.reload();
        await two.locator("#counter").waitFor();
        await command(["stop"], worktrees[1], env).done;
        await context.close();
      } finally {
        await Promise.all(children.map((child) => stop(child)));
        await browser?.close();
        await delay(1000);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
