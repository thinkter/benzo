import type { Report } from "#bench/types";
import type { ScenarioEntry } from "#bench/acceptance";
import { item } from "#bench/values";
import test from "node:test";
import assert from "node:assert/strict";
import {
  scenario,
  replacementVerdict,
  configuredVerdict,
} from "#bench/acceptance";

test("replacement acceptance never treats missing, blocked or failed cases as passes", async () => {
  const report: Report = { scenarios: [] };
  const gates = ["baseline", "portless", "parallel-auth"];
  await scenario(report, "baseline", async () => {});
  assert.equal(replacementVerdict(report.scenarios, gates), "not-established");
  report.scenarios.push({ case: "portless", result: "blocked" });
  await scenario(report, "parallel-auth", async () => {
    throw new Error("cookie=private");
  });
  assert.equal(replacementVerdict(report.scenarios, gates), "not-established");
  assert.ok(!JSON.stringify(report).includes("private"));
  item(report.scenarios, 1).result = item(report.scenarios, 2).result =
    "passed";
  assert.equal(
    replacementVerdict(report.scenarios, gates),
    "passed-scoped-trial",
  );
  assert.equal(replacementVerdict([], []), "not-established");
  report.scenarios.push({ case: "baseline", result: "failed" });
  assert.equal(
    replacementVerdict(report.scenarios, gates),
    "not-established",
    "Repeated attempts cannot hide a failure",
  );
});

test("Sokosumi prerequisites are blocked evidence rather than a fictitious TLS failure", async () => {
  const { sokosumi } = await import("#bench/consumers");
  const report: Report = { scenarios: [] };
  await sokosumi({ report });
  assert.equal(report.result, "blocked");
  assert.equal(report.replacement, "not-established");
  assert.equal(
    report.scenarios.some(
      (entry) => entry.result === "passed" || entry.result === "failed",
    ),
    false,
  );
  assert.equal(item(report.scenarios, 0)["runtimeJourneyExecuted"], false);
});

test("bench provenance changes with verdicts, recipes and runtime helpers", async () => {
  const { harnessProvenance } = await import("#bench/evidence");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "benzo-provenance-"));
  try {
    await mkdir(join(root, "compatibility/recipes"), { recursive: true });
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await mkdir(join(root, ".tools-dist/compatibility"), { recursive: true });
    const files = [
      "compatibility/run.ts",
      "compatibility/consumers.ts",
      "compatibility/acceptance.ts",
      "compatibility/runner.ts",
      "compatibility/types.ts",
      "compatibility/values.ts",
      "compatibility/evidence.ts",
      "compatibility/recipes/projects.json",
      "src/process.ts",
      "dist/process.js",
      "tsconfig.json",
      "tsconfig.tools.json",
      ".tools-dist/compatibility/acceptance.js",
      ".tools-dist/compatibility/evidence.js",
      ".tools-dist/compatibility/run.js",
      ".tools-dist/compatibility/runner.js",
      ".tools-dist/compatibility/consumers.js",
      ".tools-dist/compatibility/values.js",
      "package.json",
      "pnpm-lock.yaml",
    ];
    for (const file of files) await writeFile(join(root, file), "original");
    const before = harnessProvenance(root);
    assert.equal(before.harnessInputs.length, files.length);
    for (const file of files) {
      await writeFile(join(root, file), "changed");
      assert.notEqual(
        harnessProvenance(root).harnessSha256,
        before.harnessSha256,
        file,
      );
      await writeFile(join(root, file), "original");
    }
    assert.deepEqual(harnessProvenance(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const host of ["127.0.0.1", "::1"]) {
  test(`cleanup probe detects a live listener on ${host}`, async (t) => {
    const { refusesConnection } = await import("#bench/evidence");
    const { createServer } = await import("node:net");
    const server = createServer((socket) => socket.end());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)
      )
        return t.skip(error.code);
      throw error;
    }
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    try {
      assert.equal(await refusesConnection(port, host), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal(await refusesConnection(port, host), true);
  });
}

test("configured Benzo verdict is independent of competitor failure but requires baseline and cleanup", () => {
  const scenarios: ScenarioEntry[] = [
    { case: "app:baseline", result: "passed" },
    { case: "app:consumer-parity", result: "passed" },
    { case: "app:cleanup", result: "passed" },
    { case: "app:portless", result: "failed" },
  ];
  assert.equal(configuredVerdict(scenarios, ["app"]), "passed");
  assert.equal(
    replacementVerdict(
      scenarios,
      scenarios.map((s) => s.case),
    ),
    "not-established",
  );
  assert.equal(
    configuredVerdict(scenarios.slice(1), ["app"]),
    "not-established",
  );
  item(scenarios, 2).result = "failed";
  assert.equal(configuredVerdict(scenarios, ["app"]), "failed");
  assert.equal(configuredVerdict([], []), "not-established");
});

test("selected examples survive failure before consumer setup", async () => {
  const { stateInUrl, consumerReproduction } = await import("#bench/consumers");
  const report: Report = {
    scenarios: [],
    reproduction: consumerReproduction("state-in-url", "react"),
  };
  assert.equal(
    report.reproduction,
    "BENZO_COMPAT_APPS=react pnpm test:compat state-in-url",
  );
  // Direct consumer callers must also record selection before their first setup call.
  report.reproduction = "pnpm test:compat state-in-url";
  const fail = (): never => {
    assert.equal(report.reproduction, "BENZO_COMPAT_APPS=react pnpm test:compat state-in-url");
    throw new Error("injected setup failure");
  };
  await assert.rejects(
    stateInUrl({
      checkout: "/unused",
      cache: "/unused",
      root: "/unused",
      installedCli: "/unused",
      report,
      recipe: {
        name: "state-in-url",
        repository: "unused",
        commit: "unused",
        baselineScript: "dev",
        requiredTools: [],
      },
      env: { BENZO_COMPAT_APPS: "react" },
      run: async () => fail(),
      background: fail,
      freePort: async () => fail(),
      waitFor: async () => fail(),
      getState: async () => fail(),
    }),
    /injected setup failure/,
  );
  assert.equal(
    report.reproduction,
    "BENZO_COMPAT_APPS=react pnpm test:compat state-in-url",
  );
});
