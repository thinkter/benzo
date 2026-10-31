import type { JsonValue, JsonObject, RuntimeState } from "./types.js";

export function jsonObject(text: string): JsonObject {
  const value = JSON.parse(text) as JsonValue;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value;
}
function textField(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("Expected a string.");
  return value;
}
function portField(value: JsonValue | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  )
    throw new Error("Expected a TCP port.");
  return value;
}
function record(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  return value;
}
function stringMap(value: JsonValue | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, entry]) => [
      key,
      textField(entry),
    ]),
  );
}
export function supervisorState(text: string): Omit<RuntimeState, "token"> {
  const value = jsonObject(text);
  if (value["protocol"] !== "benzo/1")
    throw new Error("Invalid supervisor protocol.");
  const slot = value["slot"];
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0)
    throw new Error("Invalid slot.");
  const ports = Object.fromEntries(
    Object.entries(record(value["ports"])).map(([key, entry]) => [
      key,
      portField(entry),
    ]),
  );
  const urls = stringMap(value["urls"]);
  const names = Object.keys(urls);
  if (
    !names.length ||
    names.length !== Object.keys(ports).length ||
    names.some((key) => !Object.hasOwn(ports, key))
  )
    throw new Error(
      "Service URLs and ports must have identical nonempty key sets.",
    );
  return {
    protocol: "benzo/1",
    slot,
    ports,
    urls,
    logs: stringMap(value["logs"]),
    controlPort: portField(value["controlPort"]),
    gateway: portField(value["gateway"]),
    instanceId: textField(value["instanceId"]),
    projectId: textField(value["projectId"]),
    worktreeId: textField(value["worktreeId"]),
    name: textField(value["name"]),
    status: textField(value["status"]),
    startedAt: textField(value["startedAt"]),
  };
}
