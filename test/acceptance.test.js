import test from "node:test";
import assert from "node:assert/strict";
import { scenario, replacementVerdict } from "../compatibility/acceptance.mjs";

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
