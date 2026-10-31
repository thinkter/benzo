// Reports deliberately contain scenario metadata, never browser cookies or logs.
export async function scenario(report, name, action, metadata = {}) {
  const entry = { case: name, ...metadata, result: "running" };
  report.scenarios.push(entry);
  const started = Date.now();
  try {
    await action(entry);
    entry.result = "passed";
    return true;
  } catch (error) {
    await report.onFailure?.(name, error);
    entry.result = "failed";
    // Assertion/Playwright messages can include response bodies or HTML.
    entry.error = error.name;
    entry.reason =
      "Acceptance assertion or command failed; reproduce using this scenario and the pinned recipe. Raw output remains in the ignored cache.";
    return false;
  } finally {
    entry.durationMs = Date.now() - started;
    await report.onScenario?.();
  }
}

export function replacementVerdict(scenarios, required) {
  if (
    !required.length ||
    required.some((name) => !scenarios.some((s) => s.case === name))
  )
    return "not-established";
  return required.every((name) => {
    const matches = scenarios.filter((s) => s.case === name);
    return matches.length === 1 && matches[0].result === "passed";
  })
    ? "passed-scoped-trial"
    : "not-established";
}

// A competitor failure invalidates comparison, not a separately measured Benzo lane.
export function configuredVerdict(scenarios, apps) {
  const required = apps.flatMap((app) => [
    `${app}:baseline`,
    `${app}:consumer-parity`,
    `${app}:cleanup`,
  ]);
  if (replacementVerdict(scenarios, required) === "passed-scoped-trial")
    return "passed";
  const relevant = scenarios.filter((entry) => required.includes(entry.case));
  if (relevant.some((entry) => entry.result === "failed")) return "failed";
  if (relevant.some((entry) => entry.result === "blocked")) return "blocked";
  return "not-established";
}
