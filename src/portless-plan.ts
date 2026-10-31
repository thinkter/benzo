interface PortlessPlan {
  schemaVersion: 1;
  kind: "portless-adoption-plan";
  status: string;
  cwd: string;
  script: string | null;
  packageSha256: string | null;
  projectChanges: string[];
  automaticMigration: boolean;
  originPreserved: boolean;
  issues: string[];
  trial: {
    argv: string[];
    framework: "next" | "vite";
    requestedName: string | null;
    protocol: string;
    allocation: string;
    rollback: string;
  } | null;
  limitations: string[];
}
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { associatedManifest } from "./association.js";
import { unwrapPortless } from "./portless.js";

const record = (value: object | null): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Only package metadata is read. Neither wrapper code nor Portless configuration
// is evaluated, and a trial is never represented as an origin-preserving import.
export function inspectPortless(
  cwd: string,
  requestedScript?: string,
): PortlessPlan {
  const root = realpathSync(cwd);
  const report: PortlessPlan = {
    schemaVersion: 1,
    kind: "portless-adoption-plan",
    status: "unsupported",
    cwd: root,
    script: requestedScript ?? null,
    packageSha256: null,
    projectChanges: [],
    automaticMigration: false,
    originPreserved: false,
    issues: [],
    trial: null,
    limitations: [
      "Only the selected root script is inspected; workspace graphs and global Portless state are not imported.",
      "An HTTP trial does not preserve Portless TLS, full origins, proxy settings or package-manager lifecycle environment.",
      "Dependencies must already be installed. Application environment files are never read.",
    ],
  };
  const issue = (code: string): void => {
    report.issues.push(code);
  };
  let pkg: import("./types.js").PortlessPackage;
  try {
    const path = join(root, "package.json");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) {
      issue("unsupported-package-file");
      return report;
    }
    const bytes = readFileSync(path);
    report.packageSha256 = createHash("sha256").update(bytes).digest("hex");
    pkg = JSON.parse(bytes.toString("utf8"));
    if (!record(pkg) || !pkg.scripts || !record(pkg.scripts)) {
      issue("invalid-package-scripts");
      return report;
    }
  } catch {
    issue("unreadable-package");
    return report;
  }
  if (!pkg.scripts) {
    issue("invalid-package-scripts");
    return report;
  }
  const script = requestedScript ?? (pkg.scripts["dev"] ? "dev" : "start");
  report.script = script;
  if (
    !Object.hasOwn(pkg.scripts, script) ||
    typeof pkg.scripts[script] !== "string"
  ) {
    issue("missing-script");
    return report;
  }
  const files = readdirSync(root);
  if (
    Object.hasOwn(pkg, "portless") ||
    files.some((name) =>
      /^\.?portless(?:\.config)?\.(?:json|jsonc|js|cjs|mjs|ts)$/.test(name),
    )
  )
    issue("portless-configuration-requires-integration");
  if (pkg.benzo || files.includes("benzo.config.json"))
    issue("existing-benzo-configuration-takes-precedence");
  try {
    if (associatedManifest(root))
      issue("associated-benzo-configuration-takes-precedence");
  } catch {
    issue("invalid-benzo-association");
  }
  let parsed: import("./types.js").PortlessResult | null = null;
  try {
    parsed = unwrapPortless(pkg, script);
    if (!parsed) issue("not-a-literal-portless-script");
  } catch {
    issue("unsupported-portless-wrapper");
  }
  if (parsed) {
    // The launch adapter can forward literal flags. A migration planner cannot
    // infer whether those flags imply TLS, custom origins or configuration.
    if (parsed.args.length !== 5)
      issue("framework-arguments-require-integration");
  }
  if (report.issues.length || !parsed) return report;
  report.status = "http-trial-available";
  report.trial = {
    argv: ["benzo", "dev", "--cwd", root, "--script", script],
    framework: parsed.command,
    requestedName: parsed.name ?? null,
    protocol: "http",
    allocation: "resolved-at-launch; existing names and ports may be occupied",
    rollback:
      "Stop the trial with Ctrl-C in its terminal. No project changes need reverting; the original package script remains available.",
  };
  return report;
}
