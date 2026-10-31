import type { PortlessPackage, PortlessResult } from "./types.js";
// Deliberately a literal-command recognizer, not a shell interpreter.
export function unwrapPortless(
  pkg: PortlessPackage,
  script: string,
): PortlessResult | null {
  const source = pkg.scripts?.[script];
  if (
    !pkg.scripts ||
    typeof source !== "string" ||
    !/^portless(?:\s|$)/.test(source.trim())
  )
    return null;
  const unsupported = () => {
    throw new Error(
      "Unsupported Portless wrapper. Select the original script with --script or use an external Benzo config; no files were changed.",
    );
  };
  if (/[\r\n]/.test(source)) unsupported();
  if (pkg.scripts[`pre${script}`] || pkg.scripts[`post${script}`])
    unsupported();
  // Reject shell expansion, quoting and operators rather than changing their meaning.
  const words = source.trim().split(/\s+/);
  if (words.some((word) => !/^[a-zA-Z0-9_./:@=+-]+$/.test(word))) unsupported();
  words.shift();
  let name: string | undefined;
  if (words[0] === "run") words.shift();
  else {
    name = words.shift();
    if (!name || !/^[a-z][a-z0-9-]{0,49}$/.test(name)) unsupported();
  }
  if (words[0] === "--name") {
    words.shift();
    name = words.shift();
    if (!name || !/^[a-z][a-z0-9-]{0,49}$/.test(name)) unsupported();
  }
  if (words[0] === "--") words.shift();
  const command = words.shift();
  if (command !== "vite" && !(command === "next" && words[0] === "dev"))
    unsupported();
  if (command === "vite" && words[0] && !words[0].startsWith("-"))
    unsupported();
  if (
    words.some((word) =>
      /^(?:--(?:port|host|hostname)|-p|-H)(?:=|$)/.test(word),
    )
  )
    unsupported();
  if (words.includes("--")) unsupported();
  return {
    ...(name ? { name } : {}),
    command: command as "vite" | "next",
    args: [
      ...words,
      command === "next" ? "--hostname" : "--host",
      "127.0.0.1",
      "--port",
      "{port}",
      ...(command === "vite" ? ["--strictPort"] : []),
    ],
  };
}
