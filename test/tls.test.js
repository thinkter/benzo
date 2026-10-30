import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, normalizeManifest } from "../src/core.js";
import { gatewayTransport } from "../src/tls.js";
import { tlsFixture, secureRequest } from "./tls-fixture.js";
import { reserveEnvironment } from "../src/sdk.js";
import { setTimeout as delay } from "node:timers/promises";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });

test(
  "external HTTPS leases advertise secure origins and retain readiness control",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "benzo-sdk-tls-"));
    const oldHome = process.env.BENZO_HOME;
    process.env.BENZO_HOME = join(directory, "home");
    const app = createServer((_req, res) => res.end("external"));
    let lease;
    try {
      const tls = await tlsFixture(directory);
      const probe = createServer();
      await listen(probe);
      const port = probe.address().port;
      await close(probe);
      await listen(app);
      lease = await reserveEnvironment({
        cwd: directory,
        name: "feature",
        gateway: {
          port,
          tls: { certFile: tls.certFile, keyFile: tls.keyFile },
        },
      });
      assert.equal(
        lease.describe().services[0].origin,
        `https://feature.localhost:${port}`,
      );
      assert.equal((await secureRequest(port, tls.cert)).status, 503);
      await lease.attach("web", { port: app.address().port });
      await lease.setReady("web");
      assert.equal((await secureRequest(port, tls.cert)).body, "external");
      await lease.setReady("web", false);
      assert.equal((await secureRequest(port, tls.cert)).status, 503);
      await lease.release();
      assert.equal(app.listening, true);
    } finally {
      await lease?.release();
      await close(app);
      if (oldHome === undefined) delete process.env.BENZO_HOME;
      else process.env.BENZO_HOME = oldHome;
      await delay(1000);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "HTTPS gateway preserves schemes, Secure cookies, callback ownership and WSS forwarding",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "benzo-tls-"));
    let app, gateway;
    try {
      const fixture = await tlsFixture(directory);
      const transport = gatewayTransport({ tls: fixture }, directory);
      let port;
      app = createServer((req, res) => {
        if (req.url === "/login") {
          const authorization = new URL("https://provider.invalid/authorize");
          authorization.searchParams.set("state", "secure-state");
          authorization.searchParams.set(
            "redirect_uri",
            `https://localhost:${port}/callback`,
          );
          return res.writeHead(302, { location: authorization.href }).end();
        }
        if (req.url === "/redirect")
          return res
            .writeHead(302, { location: `https://localhost:${port}/done` })
            .end();
        if (req.url === "/http")
          return res
            .writeHead(302, { location: `http://localhost:${port}/done` })
            .end();
        if (req.url === "/refresh")
          return res
            .writeHead(200, { refresh: `0;url=https://localhost:${port}/done` })
            .end();
        res
          .writeHead(200, {
            "set-cookie":
              "session=opaque; Secure; HttpOnly; SameSite=Lax; Path=/",
          })
          .end(
            JSON.stringify({
              host: req.headers.host,
              protocol: req.headers["x-forwarded-proto"],
            }),
          );
      });
      app.on("upgrade", (req, socket) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        socket.write(req.headers["x-forwarded-proto"]);
        socket.on("data", (chunk) => socket.write(chunk));
        socket.on("end", () => socket.end());
      });
      await listen(app);
      gateway = createGateway({
        port: 0,
        tls: transport.tls,
        routes: new Map([["feature.localhost", app.address().port]]),
      });
      await gateway.listen();
      port = gateway.server.address().port;
      const response = await secureRequest(port, fixture.cert);
      assert.deepEqual(JSON.parse(response.body), {
        host: `feature.localhost:${port}`,
        protocol: "https",
      });
      assert.deepEqual(response.headers["set-cookie"], [
        "session=opaque; Secure; HttpOnly; SameSite=Lax; Path=/",
      ]);
      await assert.rejects(
        secureRequest(port, undefined),
        (error) => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT",
      );
      await assert.rejects(
        secureRequest(port, fixture.cert, "/", "uncovered.localhost"),
        (error) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
      );
      assert.equal(
        (await secureRequest(port, fixture.cert, "/redirect")).headers.location,
        `https://feature.localhost:${port}/done`,
      );
      assert.equal(
        (await secureRequest(port, fixture.cert, "/http")).headers.location,
        `http://localhost:${port}/done`,
      );
      assert.equal(
        (await secureRequest(port, fixture.cert, "/refresh")).headers.refresh,
        `0;url=https://feature.localhost:${port}/done`,
      );
      const auth = await secureRequest(port, fixture.cert, "/login");
      assert.equal(
        new URL(auth.headers.location).searchParams.get("redirect_uri"),
        `https://localhost:${port}/callback`,
      );
      const callback = await secureRequest(
        port,
        fixture.cert,
        "/callback?state=secure-state&code=opaque",
        "localhost",
      );
      assert.equal(callback.status, 307);
      assert.equal(
        callback.headers.location,
        `https://feature.localhost:${port}/callback?state=secure-state&code=opaque`,
      );
      assert.equal(
        (
          await secureRequest(
            port,
            fixture.cert,
            "/callback?state=secure-state",
            "localhost",
          )
        ).status,
        409,
      );
      await new Promise((resolve, reject) => {
        const req = httpsRequest({
          hostname: "127.0.0.1",
          servername: "feature.localhost",
          port,
          ca: fixture.cert,
          headers: {
            host: `feature.localhost:${port}`,
            connection: "Upgrade",
            upgrade: "websocket",
          },
        });
        req.on("error", reject);
        req.on("response", () =>
          reject(new Error("Expected WebSocket upgrade")),
        );
        req.on("upgrade", (res, socket, head) => {
          let bytes = head.toString();
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("WSS timeout"));
          }, 5000);
          socket.on("error", reject);
          socket.on("data", (chunk) => {
            bytes += chunk;
            if (bytes.includes("httpsprobe")) {
              clearTimeout(timer);
              socket.destroy();
              resolve();
            }
          });
          socket.write("probe");
        });
        req.end();
      });
    } finally {
      await gateway?.close();
      if (app) await close(app);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "TLS configuration rejects missing, malformed and mismatched PEM before startup",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "benzo-tls-invalid-"));
    try {
      const base = { services: [{ name: "web", command: "node" }] };
      for (const tls of [
        true,
        null,
        {},
        { certFile: "cert.pem" },
        { certFile: 12, keyFile: "key.pem" },
      ])
        assert.throws(
          () => normalizeManifest({ ...base, gateway: { tls } }),
          /gateway.tls/,
        );
      assert.throws(
        () =>
          gatewayTransport(
            { tls: { certFile: "missing", keyFile: "missing" } },
            directory,
          ),
        /Cannot load gateway TLS/,
      );
      await writeFile(join(directory, "bad.pem"), "private-key-secret");
      assert.throws(
        () =>
          gatewayTransport(
            { tls: { certFile: "bad.pem", keyFile: "bad.pem" } },
            directory,
          ),
        (error) =>
          !error.message.includes("private-key-secret") &&
          /Cannot load gateway TLS/.test(error.message),
      );
      const one = await tlsFixture(directory, "one");
      const two = await tlsFixture(directory, "two");
      assert.throws(
        () =>
          gatewayTransport(
            { tls: { certFile: one.certFile, keyFile: two.keyFile } },
            directory,
          ),
        /Cannot load gateway TLS/,
      );
      assert.equal(gatewayTransport({}, directory).identity, "http");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
