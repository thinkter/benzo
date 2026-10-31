import type { ChildProcess } from "node:child_process";
import type { JsonObject, RuntimeState } from "#production/types";
import type { AcceptanceReport } from "./acceptance.js";
export type BenchChild = ChildProcess & {
  output: string;
  startupError?: Error;
};
export type BenchState = Omit<RuntimeState, "token">;
export interface Recipe {
  name: string;
  repository: string;
  commit: string;
  baselineScript: string;
  requiredTools: string[];
  hmrFile?: string;
  prerequisite?: string;
}
export interface Lane {
  result: string;
  argv?: string[];
  cwd?: string;
  exitCode?: number;
  reason?: string | undefined;
  scope?: string;
  selectedApps?: string[];
}
export interface Report extends AcceptanceReport {
  project?: string;
  repository?: string;
  commit?: string;
  benzoBuild?: string;
  harnessSha256?: string;
  harnessInputs?: { path: string; sha256: string }[];
  testedAt?: string;
  platform?: { os: string; architecture: string; node: string };
  bare?: Lane;
  configured?: Lane;
  baseline?: string;
  result?: string;
  applicationChangesRequired?: boolean | null;
  schemaVersion?: number;
  replacement?: string;
  execution?: string;
  reproduction?: string;
  discovery?: string;
  discoveryDiagnostic?: string;
  reason?: string;
  sourceUnchanged?: boolean;
  listenerCleanup?: string;
  cleanupScope?: JsonObject;
  packageManager?: string;
  setup?: JsonObject;
  browser?: { name: string; version: string };
  competitor?: { name: string; version: string };
  scope?: string;
}
export interface Harness {
  checkout: string;
  cache: string;
  root: string;
  report: Report;
  recipe: Recipe;
  installedCli: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  run(
    command: string,
    args: string[],
    cwd?: string,
    timeout?: number,
  ): Promise<string>;
  background(
    command: string,
    args: string[],
    cwd: string,
    additions?: NodeJS.ProcessEnv,
  ): BenchChild;
  freePort(): Promise<number>;
  waitFor<T>(
    check: () => T | Promise<T>,
    timeout?: number,
  ): Promise<NonNullable<T>>;
  getState(cwd: string): Promise<BenchState | undefined>;
}
