import type { JsonObject, JsonValue } from "./types.js";

type Raw = Record<string, unknown>;
const object = (value: unknown): value is Raw => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (path: string, expected: string): never => { throw new Error(`Invalid Benzo config field ${path}: expected ${expected}.`); };
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string");
const commandShape = (value: Raw, path: string): void => {
  for (const key of ["command", "cwd"] as const) if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key])) fail(`${path}.${key}`, "a nonempty string");
  if (value.args !== undefined && !strings(value.args)) fail(`${path}.args`, "an array of strings");
  if (value.env !== undefined && (!object(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string"))) fail(`${path}.env`, "an object with string values");
};
export function validateManifestShape(config: unknown): asserts config is Raw {
  if (!object(config)) return fail("manifest", "an object");
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) fail("schemaVersion", "1");
  if (config.discovery !== undefined && typeof config.discovery !== "string") fail("discovery", "a string");
  if (config.warnings !== undefined && !strings(config.warnings)) fail("warnings", "an array of strings");
  if (config.name !== undefined && (typeof config.name !== "string" || !config.name)) fail("name", "a nonempty string");
  for (const key of ["gateway", "worktree", "backend", "auth"] as const) if (config[key] !== undefined && !object(config[key])) fail(key, "an object");
  const backend = config.backend as Raw | undefined;
  if (backend?.mode !== undefined && !["shared", "external", "none"].includes(String(backend.mode))) fail("backend.mode", "shared, external, or none");
  const auth = config.auth as Raw | undefined;
  if (auth?.mode !== undefined && !["pass-through", "callback", "relay"].includes(String(auth.mode))) fail("auth.mode", "pass-through, callback, or relay");
  const gateway = config.gateway as Raw | undefined;
  if (gateway?.tls !== undefined) { if (!object(gateway.tls)) return fail("gateway.tls", "an object containing certFile and keyFile"); for (const field of ["certFile", "keyFile"] as const) if (typeof gateway.tls[field] !== "string" || !gateway.tls[field]) fail(`gateway.tls.${field}`, "a nonempty PEM file path"); }
  if (config.services !== undefined && !Array.isArray(config.services)) fail("services", "an array");
  const services = Array.isArray(config.services) ? config.services : [];
  for (const [index, service] of services.entries()) {
    const path = `services[${index}]`; if (!object(service)) { fail(path, "an object"); continue; } commandShape(service, path);
    if (service.excludeEnv !== undefined && !strings(service.excludeEnv)) fail(`${path}.excludeEnv`, "an array of strings");
    if (service.ready !== undefined) { const ready = service.ready; if (!object(ready)) { fail(`${path}.ready`, "an object"); continue; } if (ready.type !== undefined && !["http", "tcp"].includes(String(ready.type))) fail(`${path}.ready.type`, "http or tcp"); if (ready.path !== undefined && (typeof ready.path !== "string" || !ready.path.startsWith("/") || /[\x00-\x20\x7f]/.test(ready.path))) fail(`${path}.ready.path`, "an encoded HTTP path starting with /"); if (ready.status !== undefined && (!Number.isInteger(ready.status) || Number(ready.status) < 100 || Number(ready.status) > 599)) fail(`${path}.ready.status`, "an HTTP status integer from 100 to 599"); if (ready.timeout !== undefined && (!Number.isSafeInteger(ready.timeout) || Number(ready.timeout) <= 0)) fail(`${path}.ready.timeout`, "a positive integer in milliseconds"); }
  }
  if (backend) commandShape(backend, "backend");
  if (auth) { for (const key of ["pathPrefix", "callbackPath"] as const) if (auth[key] !== undefined && (typeof auth[key] !== "string" || !auth[key].startsWith("/"))) fail(`auth.${key}`, "a path starting with /"); if (auth.upstream !== undefined) { try { const upstream = new URL(String(auth.upstream)); if (typeof auth.upstream !== "string" || !["http:", "https:"].includes(upstream.protocol)) throw new Error(); } catch { fail("auth.upstream", "an absolute HTTP(S) URL"); } } }
}
export interface ManifestDiagnostic { code: "unknown-field"; path: string; }
export function manifestDiagnostics(config: unknown): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = []; const check = (value: unknown, path: string, known: string[]): void => { if (!object(value)) return; for (const key of Object.keys(value)) if (!known.includes(key)) diagnostics.push({ code: "unknown-field", path: `${path}[${JSON.stringify(key)}]` }); };
  if (!object(config)) return diagnostics;
  check(config, "manifest", ["schemaVersion", "name", "gateway", "worktree", "backend", "auth", "services", "discovery", "warnings"]);
  check(config.gateway, "gateway", ["host", "port", "controlPort", "tls"]); check(object(config.gateway) ? config.gateway.tls : undefined, "gateway.tls", ["certFile", "keyFile"]); check(config.worktree, "worktree", ["slots", "firstPort", "stride"]); check(config.backend, "backend", ["mode", "command", "args", "cwd", "env"]); check(config.auth, "auth", ["mode", "upstream", "pathPrefix", "callbackPath"]);
  for (const [index, service] of (Array.isArray(config.services) ? config.services : []).entries()) { check(service, `services[${index}]`, ["name", "command", "args", "cwd", "env", "excludeEnv", "ready"]); check(object(service) ? service.ready : undefined, `services[${index}].ready`, ["type", "path", "status", "timeout"]); }
  return diagnostics;
}
