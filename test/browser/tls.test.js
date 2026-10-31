import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createGateway } from "../../dist/core.js";
import { tlsFixture } from "../tls-fixture.js";

test(
  "HTTPS browser origins retain Secure cookies, Refresh navigation and encrypted WebSockets",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "benzo-browser-tls-"));
    let app, gateway, browser;
    try {
      const tls = await tlsFixture(directory);
      let port;
      app = createServer((req, res) => {
        if (req.url === "/refresh")
          return res
            .writeHead(200, {
              refresh: `0;url=https://localhost:${port}/done`,
              "content-type": "text/html",
            })
            .end("redirecting");
        if (req.url === "/session") return res.end(req.headers.cookie ?? "");
        if (req.url === "/set")
          res.setHeader(
            "set-cookie",
            `session=${req.headers.host.split(".")[0]}; Secure; HttpOnly; SameSite=Lax; Path=/`,
          );
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<title>TLS fixture</title><a href="/refresh" id="refresh">Refresh redirect</a>',
          );
      });
      app.on("upgrade", (req, socket) => {
        const accept = createHash("sha1")
          .update(
            `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
          )
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        let pending = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          if (pending.length < 6) return;
          const length = pending[1] & 127;
          if (length >= 126 || !(pending[1] & 128)) return socket.destroy();
          if (pending.length < length + 6) return;
          if ((pending[0] & 15) === 8)
            return socket.end(Buffer.from([0x88, 0]));
          const decoded = Buffer.from(pending.subarray(6, 6 + length));
          for (let index = 0; index < decoded.length; index++)
            decoded[index] ^= pending[2 + (index % 4)];
          const reply = Buffer.from(
            `${req.headers["x-forwarded-proto"]}:${decoded}`,
          );
          socket.write(
            Buffer.concat([Buffer.from([0x81, reply.length]), reply]),
          );
          pending = pending.subarray(length + 6);
        });
        socket.on("end", () => socket.end());
        socket.on("error", () => socket.destroy());
      });
      await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
      gateway = createGateway({
        port: 0,
        tls: { cert: tls.cert, key: tls.key },
        routes: new Map([
          ["feature.localhost", app.address().port],
          ["second.localhost", app.address().port],
        ]),
      });
      await gateway.listen();
      port = gateway.server.address().port;
      // Scoped test-only exception, NOT evidence of OS/browser CA trust.
      const spki = createHash("sha256")
        .update(
          new X509Certificate(tls.cert).publicKey.export({
            type: "spki",
            format: "der",
          }),
        )
        .digest("base64");
      browser = await chromium.launch({
        headless: true,
        args: [`--ignore-certificate-errors-spki-list=${spki}`],
      });
      const context = await browser.newContext();
      const first = await context.newPage();
      const second = await context.newPage();
      const origin = `https://feature.localhost:${port}`;
      const other = `https://second.localhost:${port}`;
      await first.goto(`${origin}/set`);
      await second.goto(`${other}/set`);
      assert.equal(await first.evaluate(() => window.isSecureContext), true);
      assert.equal(
        await first.evaluate(() =>
          fetch("/session").then((response) => response.text()),
        ),
        "session=feature",
      );
      assert.equal(
        await second.evaluate(() =>
          fetch("/session").then((response) => response.text()),
        ),
        "session=second",
      );
      assert.equal((await context.cookies(origin))[0].secure, true);
      assert.equal((await context.cookies(origin))[0].httpOnly, true);
      await first.click("#refresh");
      await first.waitForURL(`${origin}/done`);
      assert.equal(
        await first.evaluate(() =>
          fetch("/session").then((response) => response.text()),
        ),
        "session=feature",
      );
      const echo = await first.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const socket = new WebSocket(
              location.origin.replace("https:", "wss:"),
            );
            socket.onopen = () => socket.send("probe");
            socket.onmessage = (event) => {
              socket.close();
              resolve(event.data);
            };
            socket.onerror = () => reject(new Error("WebSocket failed"));
          }),
      );
      assert.equal(echo, "https:probe");
    } finally {
      await browser?.close();
      await gateway?.close();
      if (app)
        await new Promise((resolve) => {
          app.close(resolve);
          app.closeAllConnections();
        });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
