import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";

// Include verdicts, recipes and working-tree helpers, not just the entry point.
export function harnessProvenance(root) {
  const paths = [
    ...readdirSync(join(root, "compatibility"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => `compatibility/${name}`),
    ...readdirSync(join(root, "src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/${name}`),
    ...readdirSync(join(root, "dist")).filter(name => name.endsWith(".js")).map(name => `dist/${name}`),
    "tsconfig.json",
    "compatibility/recipes/projects.json",
    "package.json",
    "pnpm-lock.yaml",
  ].sort();
  const inputs = paths.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex"),
  }));
  return {
    harnessSha256: createHash("sha256")
      .update(JSON.stringify(inputs))
      .digest("hex"),
    harnessInputs: inputs,
  };
}

export function refusesConnection(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
