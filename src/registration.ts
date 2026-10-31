import type {
  GatewayRegistration,
  JsonObject,
  JsonValue,
  AuthConfig,
  DiscoveryOptions,
} from "./types.js";
function record(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid registration object.");
  return value;
}
function string(value: JsonValue | undefined): string {
  if (typeof value !== "string")
    throw new Error("Invalid registration string.");
  return value;
}
export function registration(input: JsonObject): GatewayRegistration {
  if (!Array.isArray(input["services"]))
    throw new Error("Invalid service registration.");
  const services = input["services"].map((value) => {
    const service = record(value);
    if (typeof service["port"] !== "number")
      throw new Error("Invalid service registration.");
    return { name: string(service["name"]), port: service["port"] };
  });
  const result: GatewayRegistration = {
    worktree: string(input["worktree"]),
    project: string(input["project"]),
    name: string(input["name"]),
    services,
  };
  if (input["baseName"] !== undefined)
    result.baseName = string(input["baseName"]);
  if (input["external"] !== undefined) {
    if (typeof input["external"] !== "boolean")
      throw new Error("Invalid external registration.");
    result.external = input["external"];
  }
  if (input["config"] !== undefined) result.config = string(input["config"]);
  if (input["discovery"] !== undefined) {
    const value = record(input["discovery"]);
    const discovery: DiscoveryOptions = {};
    if (value["command"] !== undefined)
      discovery.command = string(value["command"]);
    if (value["script"] !== undefined)
      discovery.script = string(value["script"]);
    if (value["args"] !== undefined) {
      if (!Array.isArray(value["args"]))
        throw new Error("Invalid discovery arguments.");
      discovery.args = value["args"].map(string);
    }
    result.discovery = discovery;
  }
  if (input["backend"] !== undefined) {
    const mode = record(input["backend"])["mode"];
    if (mode !== "external" && mode !== "shared" && mode !== "none")
      throw new Error("Invalid backend mode.");
    result.backend = { mode };
  }
  if (input["auth"] !== undefined) {
    const value = record(input["auth"]);
    const mode = value["mode"];
    if (mode !== "pass-through" && mode !== "callback" && mode !== "relay")
      throw new Error("Invalid auth mode.");
    const auth: AuthConfig = { mode };
    if (value["upstream"] !== undefined)
      auth.upstream = string(value["upstream"]);
    if (value["pathPrefix"] !== undefined)
      auth.pathPrefix = string(value["pathPrefix"]);
    if (value["callbackPath"] !== undefined)
      auth.callbackPath = string(value["callbackPath"]);
    result.auth = auth;
  }
  return result;
}
