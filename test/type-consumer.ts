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
