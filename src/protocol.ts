import { jsonObject } from "./wire.js";
import type { Socket } from "node:net";
import type { ControlResponse, JsonObject } from "./types.js";
import { createConnection } from "node:net";

export const PROTOCOL = "benzo/1";
export function receiveMessage(
  socket: Socket,
  callback: (message: JsonObject) => void,
  { multiple = false }: { multiple?: boolean } = {},
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let received = false;
  const onData = (chunk: string) => {
    if (received) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 65536) {
      socket.destroy(new Error("Benzo control message too large."));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!multiple) {
        received = true;
        socket.off("data", onData);
      }
      try {
        callback(jsonObject(line));
      } catch {
        socket.destroy();
        return;
      }
      if (!multiple) return;
    }
  };
  socket.on("data", onData);
}
export function connectShared({
  host = "127.0.0.1",
  port = 2999,
  request,
  signal,
  timeout = 5000,
}: {
  host?: string;
  port?: number;
  request?: object;
  signal?: AbortSignal;
  timeout?: number;
} = {}): Promise<ControlResponse> {
  return new Promise((accept, reject) => {
    if (signal?.aborted) return reject(new Error("Startup cancelled."));
    const socket = createConnection({ host, port });
    let settled = false;
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clean();
      socket.destroy();
      reject(error);
    };
    const cancel = () => fail(new Error("Startup cancelled."));
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            "Timed out waiting for Benzo gateway. Another application may occupy the control port.",
          ),
        ),
      timeout,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ ...request, protocol: PROTOCOL })}\n`),
    );
    socket.on("error", (error: Error) => fail(error));
    socket.once("close", () =>
      fail(new Error("Benzo gateway closed during registration.")),
    );
    receiveMessage(socket, (message: JsonObject) => {
      if (message["protocol"] !== PROTOCOL)
        return fail(
          new Error(
            "Control port belongs to another application or incompatible Benzo version.",
          ),
        );
      if (typeof message["error"] === "string")
        return fail(new Error(message["error"]));
      if (message["ready"] !== true)
        return fail(new Error("Invalid Benzo gateway response."));
      const name = message["name"];
      const transport = message["transport"] ?? "http";
      if (typeof name !== "string" || typeof transport !== "string")
        return fail(new Error("Invalid Benzo gateway response."));
      settled = true;
      clean();
      accept({ protocol: PROTOCOL, ready: true, name, transport, socket });
    });
  });
}
