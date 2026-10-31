import {
  namedOrigins,
  logLine,
  type ManifestInput,
  type EnvironmentDescriptor,
} from "../dist/index.js";
const manifest: ManifestInput = {
  services: [{ name: "web", command: "node" }],
};
const origins: Record<string, string> = namedOrigins("feature", [
  { name: "web" },
]);
function show(environment: EnvironmentDescriptor): void {
  logLine(environment.name);
}
void manifest;
void origins;
void show;

import { publicState } from "../dist/runtime.js";
import type { RuntimeState } from "../dist/index.js";
const absent = publicState(undefined);
const optionalStatus: string | undefined = absent.status;
function snapshot(state: RuntimeState): string {
  return publicState(state).status;
}
void optionalStatus;
void snapshot;
