import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createGateway } from "../../src/core.js";
import { tlsFixture } from "../tls-fixture.js";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};
const challenge = (value) =>
  createHash("sha256").update(value).digest("base64url");

test(
  "browser form_post preserves form bytes and PKCE across two worktrees without weakening SameSite",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "benzo-form-post-"));
    let provider, app, gateway, browser;
    try {
      const tls = await tlsFixture(directory);
      let fixedCallback;
      const codes = new Map(),
        pending = new Map(),
        expectedForms = new Map();
      let validated = 0;
      provider = createServer(async (req, res) => {
        const url = new URL(req.url, "http://provider");
        if (url.pathname === "/authorize") {
          if (
            url.searchParams.get("redirect_uri") !== fixedCallback ||
            url.searchParams.get("response_mode") !== "form_post"
          )
            return res.writeHead(400).end();
          const state = url.searchParams.get("state"),
            code = randomUUID();
          codes.set(code, {
            challenge: url.searchParams.get("code_challenge"),
          });
          expectedForms.set(
            state,
            new URLSearchParams({
              state,
              code,
              extra: "one + two ✓",
            }).toString(),
          );
          return res
            .writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            })
            .end(
              `<meta charset="utf-8"><form method="post" action="${fixedCallback}"><input name="state" value="${state}"><input name="code" value="${code}"><input name="extra" value="one + two ✓"></form><script>document.forms[0].submit()</script>`,
            );
        }
        if (url.pathname === "/token") {
          const parameters = new URLSearchParams(await body(req));
          const record = codes.get(parameters.get("code"));
          if (
            !record ||
            record.challenge !==
              challenge(parameters.get("code_verifier") ?? "") ||
            parameters.get("redirect_uri") !== fixedCallback
          )
            return res.writeHead(400).end();
          codes.delete(parameters.get("code"));
          validated++;
          return res
            .writeHead(200, { "content-type": "application/json" })
            .end('{"access_token":"fixture-only"}');
        }
        res.writeHead(404).end();
      });
      await listen(provider);
      const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
      app = createServer(async (req, res) => {
        const url = new URL(req.url, "http://app");
        if (url.pathname === "/start") {
          const state = randomUUID(),
            verifier = randomUUID();
          pending.set(state, { verifier, host: req.headers.host });
          const authorization = new URL(`${providerOrigin}/authorize`);
          for (const [key, value] of Object.entries({
            state,
            redirect_uri: fixedCallback,
            response_mode: "form_post",
            code_challenge: challenge(verifier),
            code_challenge_method: "S256",
          }))
            authorization.searchParams.set(key, value);
          return res
            .writeHead(302, {
              location: authorization.href,
              "set-cookie": `oauth_state=${state}; Secure; HttpOnly; SameSite=${url.searchParams.has("lax") ? "Lax" : "None"}; Path=/`,
            })
            .end();
        }
        if (url.pathname === "/callback") {
          const raw = await body(req),
            parameters = new URLSearchParams(raw),
            state = parameters.get("state");
          const record = pending.get(state);
          if (
            req.method !== "POST" ||
            raw !== expectedForms.get(state) ||
            record?.host !== req.headers.host
          )
            return res.writeHead(400).end("form mismatch");
          if (!req.headers.cookie?.split("; ").includes(`oauth_state=${state}`))
            return res.writeHead(403).end("state cookie missing");
          const token = await fetch(`${providerOrigin}/token`, {
            method: "POST",
            body: new URLSearchParams({
              code: parameters.get("code"),
              code_verifier: record.verifier,
              redirect_uri: fixedCallback,
            }),
          });
          if (!token.ok) return res.writeHead(403).end("PKCE failed");
          pending.delete(state);
          return res
            .writeHead(302, {
              location: fixedCallback.replace("/callback", "/signed-in"),
              "set-cookie": [
                `session=${req.headers.host.split(".")[0]}; Secure; HttpOnly; SameSite=None; Path=/`,
                "oauth_state=; Max-Age=0; Secure; HttpOnly; SameSite=None; Path=/",
              ],
            })
            .end();
        }
        if (url.pathname === "/session")
          return res.end(req.headers.cookie ?? "");
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<a id="login" href="/start">Login</a><a id="lax" href="/start?lax=1">Lax login</a>',
          );
      });
      await listen(app);
      gateway = createGateway({
        port: 0,
        tls: { cert: tls.cert, key: tls.key },
        routes: new Map([
          ["feature.localhost", app.address().port],
          ["second.localhost", app.address().port],
        ]),
      });
      await gateway.listen();
      const port = gateway.server.address().port;
      fixedCallback = `https://localhost:${port}/callback`;
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
      await Promise.all(
        ["feature", "second"].map(async (name) => {
          const page = await context.newPage(),
            origin = `https://${name}.localhost:${port}`;
          await page.goto(origin);
          await Promise.all([
            page.waitForURL(`${origin}/signed-in`),
            page.click("#login"),
          ]);
          assert.equal(
            await page.evaluate(() =>
              fetch("/session").then((response) => response.text()),
            ),
            `session=${name}`,
          );
          const cookies = await context.cookies(origin);
          assert.equal(
            cookies.find((cookie) => cookie.name === "session").secure,
            true,
          );
          assert.equal(
            cookies.find((cookie) => cookie.name === "session").sameSite,
            "None",
          );
        }),
      );
      assert.equal(validated, 2);
      const isolated = await browser.newContext(),
        page = await isolated.newPage();
      const origin = `https://feature.localhost:${port}`;
      await page.goto(origin);
      const failure = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/callback` &&
          response.request().method() === "POST",
      );
      await page.click("#lax");
      assert.equal((await failure).status(), 403);
      assert.equal(validated, 2);
      assert.equal(
        (await isolated.cookies(origin)).find(
          (cookie) => cookie.name === "oauth_state",
        ).sameSite,
        "Lax",
      );
      assert.equal(
        (await isolated.cookies(origin)).some(
          (cookie) => cookie.name === "session",
        ),
        false,
      );
    } finally {
      await browser?.close();
      await gateway?.close();
      if (app) await close(app);
      if (provider) await close(provider);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
