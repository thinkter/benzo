import type { CliOptions, Manifest, ManifestSource, JsonValue } from "./types.js";
// Provenance is an allowlisted projection: never copy configuration values here.
export function planProvenance(
  input: Manifest,
  source: ManifestSource,
  options: CliOptions,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, JsonValue> {
  const selected = source.kind;
  const field = (object, key) =>
    Object.hasOwn(object ?? {}, key) ? selected : "default";
  return {
    requestedName:
      options.name !== undefined
        ? "--name"
        : field(input, "name") === "default"
          ? "checkout-basename"
          : selected,
    gateway: {
      host: field(input.gateway, "host"),
      port: options["gateway-port"]
        ? "--gateway-port"
        : field(input.gateway, "port"),
      controlPort: options["gateway-port"]
        ? "derived:--gateway-port"
        : Object.hasOwn(input.gateway ?? {}, "controlPort")
          ? selected
          : input.gateway?.port
            ? "derived:gateway.port"
            : "default",
      protocol: input.gateway?.tls ? selected : "default",
    },
    worktree: Object.fromEntries(
      ["slots", "firstPort", "stride"].map((key) => [
        key,
        field(input.worktree, key),
      ]),
    ),
    backendMode: field(input.backend, "mode"),
    authMode: options.authRelay ? "--auth-relay" : field(input.auth, "mode"),
    services: input.services.map((service) => ({
      name: service.name,
      command: selected,
      args: field(service, "args"),
      cwd: field(service, "cwd"),
      ready: Object.fromEntries(
        ["type", "path", "status", "timeout"].map((key) => [
          key,
          field(service.ready, key),
        ]),
      ),
      env: Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(inherited).filter(
              (key) => !(service.excludeEnv ?? []).includes(key),
            ),
            "PORT",
            "BENZO_NAME",
            "BENZO_ORIGIN",
            ...Object.keys(service.env ?? {}),
            ...Object.keys(options.env),
          ]),
        ]
          .sort()
          .map((key) => [
            key,
            Object.hasOwn(options.env, key)
              ? "--env"
              : Object.hasOwn(service.env ?? {}, key)
                ? selected
                : ["PORT", "BENZO_NAME", "BENZO_ORIGIN"].includes(key)
                  ? "runtime-allocation"
                  : "inherited-process",
          ]),
      ),
      excludedInheritedKeys: Object.keys(inherited)
        .filter((key) => (service.excludeEnv ?? []).includes(key))
        .sort(),
      executableSearchPath:
        "local node_modules/.bin directories are prepended at spawn",
      excludeEnv: field(service, "excludeEnv"),
    })),
  };
}
