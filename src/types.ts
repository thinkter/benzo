export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface TlsConfig {
  certFile: string;
  keyFile: string;
}
export interface GatewayConfig {
  host?: string;
  port?: number;
  controlPort?: number;
  tls?: TlsConfig;
}
export interface WorktreeConfig {
  slots?: number;
  firstPort?: number;
  stride?: number;
}
export interface BackendConfig {
  mode?: "shared" | "external" | "none";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface AuthConfig {
  mode?: "pass-through" | "callback" | "relay";
  upstream?: string;
  pathPrefix?: string;
  callbackPath?: string;
}
export interface ReadinessConfig {
  type?: "http" | "tcp";
  path?: string;
  status?: number;
  timeout?: number;
}
export interface ServiceConfig {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  excludeEnv?: string[];
  ready?: ReadinessConfig;
}
export interface Manifest {
  schemaVersion?: 1 | undefined;
  name?: string | undefined;
  gateway?: GatewayConfig | undefined;
  worktree?: WorktreeConfig;
  backend?: BackendConfig;
  auth?: AuthConfig;
  services: ServiceConfig[];
  discovery?: string | undefined;
  warnings?: string[] | undefined;
}
export interface NormalizedManifest extends Manifest {
  schemaVersion: 1;
  gateway: Required<Omit<GatewayConfig, "tls">> & { tls?: TlsConfig };
  worktree: Required<WorktreeConfig>;
  backend: Required<Pick<BackendConfig, "mode">> & Omit<BackendConfig, "mode">;
  auth: Required<Pick<AuthConfig, "mode">> & Omit<AuthConfig, "mode">;
  services: ServiceConfig[];
}
export interface PortlessPackage {
  scripts?: Record<string, string>;
  portless?: JsonValue;
  benzo?: ManifestInput;
}
export interface PortlessResult {
  name?: string;
  command: "vite" | "next";
  args: string[];
}
export interface ManifestSource {
  kind: string;
  path?: string;
}
export interface DiscoveryOptions {
  command?: string;
  args?: string[];
  script?: string;
}
export type CliOptionValue =
  | string
  | number
  | boolean
  | Record<string, string>
  | DiscoveryOptions
  | string[]
  | undefined;
export interface CliOptions {
  cwd: string;
  name?: string;
  "gateway-port"?: number;
  authRelay?: boolean;
  env: Record<string, string>;
  json?: boolean;
  script?: string;
  from?: string;
  config?: string;
  migration?: string;
  dryRun?: boolean;
  service?: string;
  command: string;
  args?: string[];
  discovery: DiscoveryOptions;
  [key: string]: CliOptionValue;
}
export interface PublicState {
  instanceId: string;
  projectId: string;
  worktreeId: string;
  name: string;
  status: string;
  startedAt: string;
  urls: Record<string, string>;
  ports: Record<string, number | null>;
}
export interface EnvironmentDescriptor {
  schemaVersion: 1;
  kind: "benzo-environment";
  projectId: string;
  worktreeId: string;
  instanceId: string;
  name: string;
  status: string;
  startedAt: string;
  owner: {
    kind: "benzo-launcher" | "external-orchestrator";
    lifetime: "launcher-connection" | "registration-connection";
  };
  services: Array<{
    id: string;
    name: string;
    origin: string;
    upstream: { host: string; port: number | null };
    readiness: "ready" | "not-ready";
  }>;
}
export interface ControlResponse {
  protocol: string;
  ready: true;
  name: string;
  transport: string;
  socket: import("node:net").Socket;
}
export interface ManifestInput {
  schemaVersion?: 1 | undefined;
  name?: string | undefined;
  gateway?: GatewayConfig | undefined;
  worktree?: WorktreeConfig | undefined;
  backend?: BackendConfig | undefined;
  auth?: AuthConfig | undefined;
  services?: ServiceConfig[] | undefined;
  discovery?: string | undefined;
  warnings?: string[] | undefined;
}
export interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  benzo?: ManifestInput;
  portless?: JsonValue;
}

export interface RuntimeState extends PublicState {
  protocol: string;
  token: string;
  controlPort: number;
  slot: number;
  logs: Record<string, string>;
  gateway: number;
}
export interface GatewayRegistration {
  worktree: string;
  project: string;
  name: string;
  baseName?: string;
  services: { name: string; port: number }[];
  external?: boolean;
  backend?: BackendConfig;
  auth?: AuthConfig;
  config?: string | undefined;
  discovery?: DiscoveryOptions | undefined;
}
export interface GatewayLaunch {
  gateway: {
    port: number;
    controlPort: number;
    tls?: import("node:tls").SecureContextOptions | undefined;
  };
  transport?: string;
  ownerProject: string;
}
