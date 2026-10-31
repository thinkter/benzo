import test from "node:test";
import assert from "node:assert/strict";
import {
  scenario,
  replacementVerdict,
  configuredVerdict,
} from "../.tools-dist/compatibility/acceptance.js";

test("replacement acceptance never treats missing, blocked or failed cases as passes", async () => {
  const report = { scenarios: [] };
  const gates = ["baseline", "portless", "parallel-auth"];
  await scenario(report, "baseline", async () => {});
  assert.equal(replacementVerdict(report.scenarios, gates), "not-established");
  report.scenarios.push({ case: "portless", result: "blocked" });
  await scenario(report, "parallel-auth", async () => {
    throw new Error("cookie=private");
  });
  assert.equal(replacementVerdict(report.scenarios, gates), "not-established");
  assert.ok(!JSON.stringify(report).includes("private"));
  report.scenarios[1].result = report.scenarios[2].result = "passed";
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
  const { sokosumi } = await import("../compatibility/consumers.mjs");
  const report = { scenarios: [] };
  await sokosumi({ report });
  assert.equal(report.result, "blocked");
  assert.equal(report.replacement, "not-established");
  assert.equal(
    report.scenarios.some(
      (entry) => entry.result === "passed" || entry.result === "failed",
    ),
    false,
  );
  assert.equal(report.scenarios[0].runtimeJourneyExecuted, false);
});

test("bench provenance changes with verdicts, recipes and runtime helpers", async () => {
  const { harnessProvenance } =
    await import("../.tools-dist/compatibility/evidence.js");
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
      "compatibility/run.mjs",
      "compatibility/consumers.mjs",
      "compatibility/acceptance.ts",
      "compatibility/evidence.ts",
      "compatibility/recipes/projects.json",
      "src/process.ts",
      "dist/process.js",
      "tsconfig.json",
      "tsconfig.tools.json",
      ".tools-dist/compatibility/acceptance.js",
      ".tools-dist/compatibility/evidence.js",
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
    const { refusesConnection } =
      await import("../.tools-dist/compatibility/evidence.js");
    const { createServer } = await import("node:net");
    const server = createServer((socket) => socket.end());
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
    } catch (error) {
      if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code))
        return t.skip(error.code);
      throw error;
    }
    const port = server.address().port;
    try {
      assert.equal(await refusesConnection(port, host), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(await refusesConnection(port, host), true);
  });
}

test("configured Benzo verdict is independent of competitor failure but requires baseline and cleanup", () => {
  const scenarios = [
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
  scenarios[2].result = "failed";
  assert.equal(configuredVerdict(scenarios, ["app"]), "failed");
  assert.equal(configuredVerdict([], []), "not-established");
});
