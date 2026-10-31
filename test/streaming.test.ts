import type {
  RequestListener,
  ClientRequest,
  IncomingHttpHeaders,
} from "node:http";
import type { Server } from "node:net";
function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener.");
  return address.port;
}
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { createGateway } from "#production/gateway";

async function fixture(handler: RequestListener) {
  const app = createServer(handler).listen(0, "127.0.0.1");
  await once(app, "listening");
  const gateway = createGateway({
    port: 0,
    routes: new Map([["test.localhost", portOf(app)]]),
  });
  await gateway.listen();
  return {
    port: portOf(gateway.server),
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => {
        app.close(() => resolve());
        app.closeAllConnections();
      });
    },
  };
}

test(
  "an upstream upload rejection preserves 413 before the client finishes sending",
  { timeout: 10000 },
  async () => {
    const app = await fixture((_req, res) =>
      res
        .writeHead(413, { "x-app-rejection": "too-large" })
        .end("upload rejected"),
    );
    let sender: NodeJS.Timeout | undefined;
    try {
      const result = await new Promise<{
        status: number | undefined;
        body: string;
        header: IncomingHttpHeaders[string];
      }>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: app.port,
            method: "POST",
            headers: {
              host: "test.localhost",
              "content-length": String(64 * 1024 * 1024),
            },
          },
          (res) => {
            clearInterval(sender);
            let body = "";
            res.on("data", (data) => (body += data));
            res.on("end", () => {
              req.destroy();
              resolve({
                status: res.statusCode,
                body,
                header: res.headers["x-app-rejection"],
              });
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(Buffer.alloc(1024));
        sender = setInterval(() => req.write(Buffer.alloc(1024)), 10);
      });
      assert.deepEqual(result, {
        status: 413,
        body: "upload rejected",
        header: "too-large",
      });
    } finally {
      clearInterval(sender);
      await app.close();
    }
  },
);

test(
  "SSE flushes before completion while concurrent POST bytes and statuses survive",
  { timeout: 10000 },
  async () => {
    let disconnected: () => void = () => {};
    const closed = new Promise<void>((resolve) => (disconnected = resolve));
    const app = await fixture(async (req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("data: first\n\n");
        const timer = setInterval(() => res.write("data: alive\n\n"), 15);
        res.once("close", () => {
          clearInterval(timer);
          disconnected();
        });
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          if (!Buffer.isBuffer(chunk)) throw new Error("Expected buffer.");
          chunks.push(chunk);
        }
        res.writeHead(201).end(Buffer.concat(chunks));
      }
    });
    let stream: ClientRequest | undefined;
    try {
      const first = await new Promise<{ body: string; complete: boolean }>(
        (resolve, reject) => {
          stream = request(
            {
              host: "127.0.0.1",
              port: app.port,
              path: "/events",
              headers: { host: "test.localhost" },
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += chunk;
                if (body.includes("\n\n"))
                  resolve({ body, complete: res.complete });
              });
              res.once("error", reject);
            },
          );
          stream.once("error", reject);
          stream.end();
        },
      );
      assert.ok(first.body.startsWith("data: first\n\n"));
      assert.equal(
        first.complete,
        false,
        "SSE must flush before the response ends",
      );
      await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          const body = Buffer.from(`request-${index}:` + "x".repeat(32768));
          const result = await new Promise<{
            status: number | undefined;
            body: Buffer;
          }>((resolve, reject) => {
            const req = request(
              {
                host: "127.0.0.1",
                port: app.port,
                path: "/api",
                method: "POST",
                headers: { host: "test.localhost" },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.once("error", reject);
                res.once("end", () =>
                  resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks),
                  }),
                );
              },
            );
            req.once("error", reject);
            req.end(body);
          });
          assert.equal(result.status, 201);
          assert.deepEqual(result.body, body);
        }),
      );
      assert.ok(stream);
      stream.destroy();
      await closed;
    } finally {
      stream?.destroy();
      await app.close();
    }
  },
);
