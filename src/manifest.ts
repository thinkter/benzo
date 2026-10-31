const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (path, expected) => {
  throw new Error(`Invalid Benzo config field ${path}: expected ${expected}.`);
};
const strings = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function commandShape(value, path) {
  for (const key of ["command", "cwd"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !value[key])
    )
      fail(`${path}.${key}`, "a nonempty string");
  if (value.args !== undefined && !strings(value.args))
    fail(`${path}.args`, "an array of strings");
  if (
    value.env !== undefined &&
    (!object(value.env) ||
      Object.values(value.env).some((entry) => typeof entry !== "string"))
  )
    fail(`${path}.env`, "an object with string values");
}

// Validate raw containers before normalization can spread a string/array into
// an apparently valid object. Values are intentionally absent from diagnostics.
export function validateManifestShape(config) {
  if (!object(config)) fail("manifest", "an object");
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1)
    fail("schemaVersion", "1");
  if (config.discovery !== undefined && typeof config.discovery !== "string")
    fail("discovery", "a string");
  if (config.warnings !== undefined && !strings(config.warnings))
    fail("warnings", "an array of strings");
  if (
    config.name !== undefined &&
    (typeof config.name !== "string" || !config.name)
  )
    fail("name", "a nonempty string");
  for (const key of ["gateway", "worktree", "backend", "auth"])
    if (config[key] !== undefined && !object(config[key]))
      fail(key, "an object");
  if (
    config.backend?.mode !== undefined &&
    !["shared", "external", "none"].includes(config.backend.mode)
  )
    fail("backend.mode", "shared, external, or none");
  if (
    config.auth?.mode !== undefined &&
    !["pass-through", "callback", "relay"].includes(config.auth.mode)
  )
    fail("auth.mode", "pass-through, callback, or relay");
  if (config.gateway?.tls !== undefined) {
    if (!object(config.gateway.tls)) fail("gateway.tls", "an object containing certFile and keyFile");
    for (const field of ["certFile", "keyFile"])
      if (typeof config.gateway.tls[field] !== "string" || !config.gateway.tls[field])
        fail(`gateway.tls.${field}`, "a nonempty PEM file path");
  }
  if (config.services !== undefined && !Array.isArray(config.services))
    fail("services", "an array");
  for (const [index, service] of (config.services ?? []).entries()) {
    const path = `services[${index}]`;
    if (!object(service)) fail(path, "an object");
    commandShape(service, path);
    if (service.excludeEnv !== undefined && !strings(service.excludeEnv))
      fail(`${path}.excludeEnv`, "an array of strings");
    if (service.ready !== undefined) {
      const ready = service.ready;
      if (!object(ready)) fail(`${path}.ready`, "an object");
      if (ready.type !== undefined && !["http", "tcp"].includes(ready.type))
        fail(`${path}.ready.type`, "http or tcp");
      if (
        ready.path !== undefined &&
        (typeof ready.path !== "string" ||
          !ready.path.startsWith("/") ||
          /[\x00-\x20\x7f]/.test(ready.path))
      )
        fail(`${path}.ready.path`, "an encoded HTTP path starting with /");
      if (
        ready.status !== undefined &&
        (!Number.isInteger(ready.status) ||
          ready.status < 100 ||
          ready.status > 599)
      )
        fail(`${path}.ready.status`, "an HTTP status integer from 100 to 599");
      if (
        ready.timeout !== undefined &&
        (!Number.isSafeInteger(ready.timeout) || ready.timeout <= 0)
      )
        fail(`${path}.ready.timeout`, "a positive integer in milliseconds");
    }
  }
  if (config.backend) commandShape(config.backend, "backend");
  if (config.auth) {
    for (const key of ["pathPrefix", "callbackPath"])
      if (
        config.auth[key] !== undefined &&
        (typeof config.auth[key] !== "string" ||
          !config.auth[key].startsWith("/"))
      )
        fail(`auth.${key}`, "a path starting with /");
    if (config.auth.upstream !== undefined) {
      try {
        const upstream = new URL(config.auth.upstream);
        if (
          typeof config.auth.upstream !== "string" ||
          !["http:", "https:"].includes(upstream.protocol)
        )
          throw new Error();
      } catch {
        fail("auth.upstream", "an absolute HTTP(S) URL");
      }
    }
  }
}

export function manifestDiagnostics(config) {
  const diagnostics = [];
  const check = (value, path, known) => {
    if (!object(value)) return;
    for (const key of Object.keys(value))
      if (!known.includes(key))
        diagnostics.push({
          code: "unknown-field",
          path: `${path}[${JSON.stringify(key)}]`,
        });
  };
  check(config, "manifest", [
    "schemaVersion",
    "name",
    "gateway",
    "worktree",
    "backend",
    "auth",
    "services",
    "discovery",
    "warnings",
  ]);
  check(config.gateway, "gateway", ["host", "port", "controlPort", "tls"]);
  check(config.gateway?.tls, "gateway.tls", ["certFile", "keyFile"]);
  check(config.worktree, "worktree", ["slots", "firstPort", "stride"]);
  check(config.backend, "backend", ["mode", "command", "args", "cwd", "env"]);
  check(config.auth, "auth", [
    "mode",
    "upstream",
    "pathPrefix",
    "callbackPath",
  ]);
  for (const [index, service] of (config.services ?? []).entries()) {
    check(service, `services[${index}]`, [
      "name",
      "command",
      "args",
      "cwd",
      "env",
      "excludeEnv",
      "ready",
    ]);
    check(service.ready, `services[${index}].ready`, [
      "type",
      "path",
      "status",
      "timeout",
    ]);
  }
  return diagnostics;
}
