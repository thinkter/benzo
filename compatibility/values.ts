import assert from "node:assert/strict";
import type { JsonValue, JsonObject } from "#production/types";
import type { Recipe } from "./types.js";
export function json(source: string): JsonValue {
  const value: JsonValue = JSON.parse(source);
  return value;
}
export function object(value: JsonValue | undefined): JsonObject {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected JSON object",
  );
  return value;
}
export function text(value: JsonValue | undefined): string {
  assert.ok(typeof value === "string", "Expected string");
  return value;
}
export function port(value: number | null | undefined): number {
  assert.ok(
    typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= 65535,
    "Expected TCP port",
  );
  return value;
}
export function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, "Missing collection entry");
  return value;
}
export function recipesFrom(source: string): Recipe[] {
  const values = json(source);
  assert.ok(Array.isArray(values), "Expected recipe array");
  return values.map((value) => {
    const entry = object(value);
    const requiredTools = entry["requiredTools"];
    assert.ok(Array.isArray(requiredTools));
    return {
      name: text(entry["name"]),
      repository: text(entry["repository"]),
      commit: text(entry["commit"]),
      baselineScript: text(entry["baselineScript"]),
      requiredTools: requiredTools.map(text),
      ...(entry["hmrFile"] === undefined
        ? {}
        : { hmrFile: text(entry["hmrFile"]) }),
      ...(entry["prerequisite"] === undefined
        ? {}
        : { prerequisite: text(entry["prerequisite"]) }),
    };
  });
}
