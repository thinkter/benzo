import type { Server } from "node:net";
import type { Manifest, ServiceConfig } from "./types.js";
import { createServer } from "node:net";
import { stripVTControlCharacters } from "node:util";
import { listen } from "./gateway.js";
export * from "./config.js";
export * from "./gateway.js";
export * from "./process.js";
export * from "./state.js";
export * from "./protocol.js";

export function worktreeName(
  value: string | undefined,
  maxLength = 50,
): string {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength)
      .replace(/-+$/g, "") || "worktree"
  );
}
export function availableName(
  preferred: string,
  occupied: Set<string>,
  baseName = preferred,
): string {
  const desired = worktreeName(preferred, 63);
  if (!occupied.has(desired)) return desired;
  const base = worktreeName(baseName);
  for (let index = 1; ; index++) {
    const suffix = index === 1 ? "" : `-${index}`;
    const name = `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!occupied.has(name)) return name;
  }
}
export function namedOrigin(
  name: string,
  service?: string,
  port = 3000,
  protocol = "http",
): string {
  return `${protocol}://${service ? `${service}.` : ""}${name}.localhost:${port}`;
}
export function namedOrigins(
  name: string,
  services: ReadonlyArray<Pick<ServiceConfig, "name">>,
  port = 3000,
  protocol = "http",
): Record<string, string> {
  return Object.fromEntries(
    services.map((service, index) => [
      service.name,
      namedOrigin(name, index ? service.name : undefined, port, protocol),
    ]),
  );
}
export function configuration(
  slot: number,
  manifest: Manifest = { services: [] },
): { slot: number; lock: number; ports: Record<string, number> } {
  const {
    slots = 100,
    firstPort = 10000,
    stride = 32,
  } = manifest.worktree ?? {};
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots)
    throw new Error("Invalid dev slot.");
  const base = firstPort + slot * stride;
  return {
    slot,
    lock: base,
    ports: Object.fromEntries(
      (manifest.services ?? []).map((service, index) => [
        service.name,
        base + index + 1,
      ]),
    ),
  };
}
export function expand(value: string, context: Record<string, string>): string {
  return typeof value === "string"
    ? value.replace(
        /\{([a-zA-Z][a-zA-Z0-9_.-]*)\}/g,
        (token, key) => context[key] ?? token,
      )
    : value;
}
export function serviceCommand(
  service: ServiceConfig,
  context: Record<string, string>,
): { command: string; args: string[] } {
  return {
    command: expand(service.command, context),
    args: (service.args ?? []).map((arg) => expand(arg, context)),
  };
}
export async function reservePorts(
  ports: number[],
  host = "127.0.0.1",
): Promise<(all?: boolean) => Promise<void>> {
  const handles: Server[] = [];
  const close = (list: Server[]): Promise<void[]> =>
    Promise.all(
      list.map(
        (server) =>
          new Promise<void>((accept) => {
            try {
              server.close(() => accept());
            } catch {
              accept();
            }
          }),
      ),
    );
  try {
    for (const port of ports) {
      const server = createServer();
      handles.push(server);
      await listen(server, port, host);
    }
    return async (all = false): Promise<void> => {
      await close(handles.splice(all ? 0 : 1));
    };
  } catch (error) {
    await close(handles);
    throw error;
  }
}
export function logLine(
  line: string,
  colour: number | undefined = undefined,
  stream: import("node:stream").Writable & { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  stream.write(
    stream.isTTY &&
      !Object.hasOwn(env, "NO_COLOR") &&
      env["TERM"] !== "dumb" &&
      colour
      ? `\x1b[${colour}m${line}\x1b[0m`
      : stripVTControlCharacters(line),
  );
}
