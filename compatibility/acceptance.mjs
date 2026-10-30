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
