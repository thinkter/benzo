export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

export interface TlsConfig { certFile: string; keyFile: string; }
export interface GatewayConfig { host?: string; port?: number; controlPort?: number; tls?: TlsConfig; }
export interface WorktreeConfig { slots?: number; firstPort?: number; stride?: number; }
export interface BackendConfig { mode?: "shared" | "external" | "none"; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; }
export interface AuthConfig { mode?: "pass-through" | "callback" | "relay"; upstream?: string; pathPrefix?: string; callbackPath?: string; }
export interface ReadinessConfig { type?: "http" | "tcp"; path?: string; status?: number; timeout?: number; }
export interface ServiceConfig { name: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; excludeEnv?: string[]; ready?: ReadinessConfig; }
export interface Manifest { schemaVersion?: 1 | undefined; name?: string | undefined; gateway?: GatewayConfig | undefined; worktree?: WorktreeConfig; backend?: BackendConfig; auth?: AuthConfig; services: ServiceConfig[]; discovery?: string; warnings?: string[]; [key: string]: JsonValue | undefined; }
export interface NormalizedManifest extends Manifest { schemaVersion: 1; gateway: Required<Omit<GatewayConfig, "tls">> & { tls?: TlsConfig }; worktree: Required<WorktreeConfig>; backend: Required<Pick<BackendConfig, "mode">> & Omit<BackendConfig, "mode">; auth: Required<Pick<AuthConfig, "mode">> & Omit<AuthConfig, "mode">; services: ServiceConfig[]; }
export interface PortlessPackage { scripts?: Record<string, string>; portless?: JsonValue; [key: string]: JsonValue | undefined; }
export interface PortlessResult { name?: string; command: "vite" | "next"; args: string[]; }
export interface ManifestSource { kind: string; path?: string; }
export interface CliOptions { name?: string; "gateway-port"?: number; authRelay?: boolean; env: Record<string, string>; json?: boolean; cwd?: string; script?: string; from?: string; config?: string; migration?: string; dryRun?: boolean; service?: string; command?: string; args: string[]; }
export interface PublicState { instanceId: string; projectId: string; worktreeId: string; name: string; status: string; startedAt: string; urls: Record<string, string>; ports: Record<string, number>; }
export interface EnvironmentDescriptor { schemaVersion: 1; kind: "benzo-environment"; projectId: string; worktreeId: string; instanceId: string; name: string; status: string; startedAt: string; owner: { kind: "benzo-launcher"; lifetime: "launcher-connection" }; services: Array<{ id: string; name: string; origin: string; upstream: { host: string; port: number }; readiness: "ready" | "not-ready" }>; }
export interface ControlResponse extends JsonObject { protocol?: string; error?: string; ready?: boolean; socket?: import("node:net").Socket; }
export interface ManifestInput { schemaVersion?: 1 | undefined; name?: string | undefined; gateway?: GatewayConfig | undefined; worktree?: WorktreeConfig | undefined; backend?: BackendConfig | undefined; auth?: AuthConfig | undefined; services?: ServiceConfig[] | undefined; discovery?: string | undefined; warnings?: string[] | undefined; [key: string]: JsonValue | undefined; }
export interface PackageJson { packageManager?: string; scripts?: Record<string, string>; benzo?: ManifestInput; portless?: JsonValue; [key: string]: JsonValue | undefined; }
