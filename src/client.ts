import type { EnvironmentDescriptor } from "./types.js";
import { constants } from "node:os";
import { getEnvironment } from "./sdk.js";
import { launch, safeEnvironment, stop } from "./process.js";

// Bind only public descriptor fields. Never expose supervisor capabilities or
// infer application environment keys from configuration files.
export function clientEnvironment(
  descriptor: EnvironmentDescriptor | null,
  bindings: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (
    !descriptor ||
    descriptor.schemaVersion !== 1 ||
    descriptor.status !== "ready"
  )
    throw new Error(
      "No ready Benzo environment. Start benzo in this checkout first.",
    );
  const fields = new Map([
    ["name", descriptor.name],
    ["instanceId", descriptor.instanceId],
  ]);
  for (const service of descriptor.services) {
    if (service.readiness !== "ready")
      throw new Error("Benzo services are not ready.");
    for (const [field, value] of Object.entries({
      origin: service.origin,
      host: service.upstream.host,
      port: service.upstream.port,
    }))
      fields.set(`services.${service.name}.${field}`, String(value));
  }
  const additions = Object.fromEntries(
    Object.entries(bindings).map(([key, value]) => [
      key,
      value.replace(
        /\{([a-zA-Z][a-zA-Z0-9_.-]*)\}/g,
        (_token: string, field: string): string => {
          if (!fields.has(field))
            throw new Error(
              "Unknown descriptor placeholder in --env. Use {services.<name>.origin}, .host, .port, {name}, or {instanceId}.",
            );
          return fields.get(field) ?? "";
        },
      ),
    ]),
  );
  return safeEnvironment(inherited, additions);
}

export async function runClient({
  cwd,
  command,
  args = [],
  env = {},
}: {
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<number> {
  if (!command)
    throw new Error("Use benzo exec [--env KEY=value] -- <command> [args].");
  const environment = clientEnvironment(await getEnvironment({ cwd }), env);
  const child = launch(command, args, cwd, environment, { stdio: "inherit" });
  let cancelled: NodeJS.Signals | undefined;
  let stopping: Promise<void> | undefined;
  const stopOnce = () => (stopping ??= stop(child));
  let rejectCancellation: (error: Error) => void = () => {};
  const cancellationFailure = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = async (): Promise<void> => {
    try {
      await stopOnce();
    } catch (error) {
      rejectCancellation(
        error instanceof Error ? error : new Error("Client cleanup failed."),
      );
    }
  };
  const interrupt = () => {
    cancelled ??= "SIGINT";
    void cancel();
  };
  const terminate = () => {
    cancelled ??= "SIGTERM";
    void cancel();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((accept, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            `Could not start exec command (${error.code ?? "spawn failed"}).`,
          ),
        ),
      );
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        accept({ code, signal }),
      );
    });
    const result = await Promise.race([exited, cancellationFailure]);
    await stopOnce(); // Also clean up descendants if the command leader exits.
    const signal = cancelled ?? result.signal ?? undefined;
    return signal
      ? 128 + (constants.signals[signal as keyof typeof constants.signals] ?? 1)
      : (result.code ?? 1);
  } finally {
    try {
      await stopOnce();
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  }
}
