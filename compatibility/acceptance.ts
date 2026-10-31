export type ScenarioResult =
  "running" | "passed" | "failed" | "blocked" | "not-run";
export interface ScenarioEntry {
  case: string;
  result: ScenarioResult;
  durationMs?: number;
  error?: string;
  reason?: string;
  [key: string]: string | number | boolean | undefined;
}
export interface AcceptanceReport {
  scenarios: ScenarioEntry[];
  onFailure?: (name: string, error: Error) => Promise<void>;
  onScenario?: () => void | Promise<void>;
}
export type ScenarioAction = (entry: ScenarioEntry) => Promise<void>;

export async function scenario(
  report: AcceptanceReport,
  name: string,
  action: ScenarioAction,
  metadata: Record<string, string | number | boolean> = {},
): Promise<boolean> {
  const entry: ScenarioEntry = { case: name, ...metadata, result: "running" };
  report.scenarios.push(entry);
  const started = Date.now();
  try {
    await action(entry);
    entry.result = "passed";
    return true;
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error("Unknown failure");
    await report.onFailure?.(name, failure);
    entry.result = "failed";
    entry.error = failure.name;
    entry.reason =
      "Acceptance assertion or command failed; raw output remains in the ignored cache.";
    return false;
  } finally {
    entry.durationMs = Date.now() - started;
    await report.onScenario?.();
  }
}

export function replacementVerdict(
  scenarios: readonly ScenarioEntry[],
  required: readonly string[],
): "passed-scoped-trial" | "not-established" {
  if (
    !required.length ||
    required.some((name) => !scenarios.some((s) => s.case === name))
  )
    return "not-established";
  return required.every((name) => {
    const matches = scenarios.filter((s) => s.case === name);
    return matches.length === 1 && matches[0]?.result === "passed";
  })
    ? "passed-scoped-trial"
    : "not-established";
}

export function configuredVerdict(
  scenarios: readonly ScenarioEntry[],
  apps: readonly string[],
): "passed" | "failed" | "blocked" | "not-established" {
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
