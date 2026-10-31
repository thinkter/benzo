import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { createGateway } from "../../dist/core.js";
const listen = (server, port = 0) =>
  new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
const html = `<!doctype html><title>Auth fixture</title><button id="login">Sign in</button><button id="logout">Sign out</button><output id="session"></output><script>
async function session(){ const r=await fetch('/api/auth/get-session'); const s=await r.json(); document.querySelector('#session').textContent=s?.user?.email || 'signed out'; }
document.querySelector('#login').onclick=async()=>{const r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'local',callbackURL:'/'})}); const result=await r.json(); if(result.url) location.href=result.url; else document.querySelector('#session').textContent=result.code;};
document.querySelector('#logout').onclick=async()=>{await fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); await session();}; session();</script>`;

test(
  "browser OAuth baseline and two named worktrees keep one callback, PKCE and isolated cookies",
  { timeout: 60000 },
  async () => {
    let fixedCallback;
    const codes = new Map();
    let authorizations = 0;
    let validated = 0;
    const provider = createServer(async (req, res) => {
      const url = new URL(req.url, "http://provider");
      if (url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("redirect_uri"), fixedCallback);
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const code = randomUUID();
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge"),
          callback: url.searchParams.get("redirect_uri"),
        });
        authorizations++;
        const destination = new URL(fixedCallback);
        destination.searchParams.set("state", url.searchParams.get("state"));
        destination.searchParams.set("code", code);
        return res.writeHead(302, { location: destination.href }).end();
      }
      if (url.pathname === "/token") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parameters = new URLSearchParams(body);
        const code = codes.get(parameters.get("code"));
        assert.ok(code);
        assert.equal(parameters.get("redirect_uri"), code.callback);
        assert.equal(
          createHash("sha256")
            .update(parameters.get("code_verifier"))
            .digest("base64url"),
          code.challenge,
        );
        validated++;
        codes.delete(parameters.get("code"));
        return res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "test-only-access",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      }
      if (url.pathname === "/userinfo")
        return res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "local-user",
            email: "oauth@example.invalid",
            name: "Local User",
            email_verified: true,
          }),
        );
      res.writeHead(404).end();
    });
    await listen(provider);
    const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
    const placeholder = createServer();
    await listen(placeholder);
    const gatewayPort = placeholder.address().port;
    await close(placeholder);
    fixedCallback = `http://localhost:${gatewayPort}/api/auth/callback/local`;
    function app() {
      // Original fixture config is identical for baseline and Benzo. The provider
      // only accepts fixedCallback; no named origins/trustedOrigins overrides.
      const auth = betterAuth({
        secret: "benzo-test-only-secret-with-at-least-32-characters",
        database: memoryAdapter({
          user: [],
          account: [],
          session: [],
          verification: [],
        }),
        logger: { disabled: true },
        plugins: [
          genericOAuth({
            config: [
              {
                providerId: "local",
                clientId: "local-client",
                clientSecret: "test-only-secret",
                authorizationUrl: `${providerOrigin}/authorize`,
                tokenUrl: `${providerOrigin}/token`,
                userInfoUrl: `${providerOrigin}/userinfo`,
                redirectURI: fixedCallback,
                pkce: true,
              },
            ],
          }),
        ],
      });
      const handler = toNodeHandler(auth);
      return createServer((req, res) =>
        req.url.startsWith("/api/auth/")
          ? handler(req, res)
          : res.writeHead(200, { "content-type": "text/html" }).end(html),
      );
    }
    const first = app();
    const second = app();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    context.setDefaultTimeout(12000);
    context.setDefaultNavigationTimeout(20000);
    let gateway;
    try {
      // localhost may resolve to ::1 in a browser, so bind baseline dual-stack.
      await new Promise((resolve) => first.listen(gatewayPort, resolve));
      const baseline = await context.newPage();
      await baseline.goto(`http://localhost:${gatewayPort}`);
      await baseline.locator("#login").click();
      await baseline
        .locator("#session")
        .filter({ hasText: "oauth@example.invalid" })
        .waitFor()
        .catch(async () => {
          throw new Error(
            JSON.stringify({
              text: await baseline.locator("body").innerText(),
              path: new URL(baseline.url()).pathname,
              error: new URL(baseline.url()).searchParams.get("error"),
              authorizations,
              validated,
            }),
          );
        });
      await baseline.close();
      await context.clearCookies();
      await close(first);
      await listen(first);
      await listen(second);
      gateway = createGateway({
        port: gatewayPort,
        routes: new Map([
          [
            "first.localhost",
            { port: first.address().port, auth: { mode: "relay" } },
          ],
          [
            "second.localhost",
            { port: second.address().port, auth: { mode: "relay" } },
          ],
        ]),
      });
      await gateway.listen();
      const one = await context.newPage();
      const two = await context.newPage();
      await one.goto(`http://first.localhost:${gatewayPort}`);
      await two.goto(`http://second.localhost:${gatewayPort}`);
      await Promise.all([
        one.locator("#session").filter({ hasText: "signed out" }).waitFor(),
        two.locator("#session").filter({ hasText: "signed out" }).waitFor(),
      ]);
      await Promise.all([
        one.locator("#login").click(),
        two.locator("#login").click(),
      ]);
      await Promise.all([
        one
          .locator("#session")
          .filter({ hasText: "oauth@example.invalid" })
          .waitFor(),
        two
          .locator("#session")
          .filter({ hasText: "oauth@example.invalid" })
          .waitFor(),
      ]);
      assert.equal(new URL(one.url()).hostname, "first.localhost");
      assert.equal(new URL(two.url()).hostname, "second.localhost");
      const cookies = await context.cookies();
      assert.ok(
        cookies.some(
          (cookie) =>
            cookie.domain === "first.localhost" &&
            cookie.name.includes("session_token"),
        ),
      );
      assert.ok(
        cookies.some(
          (cookie) =>
            cookie.domain === "second.localhost" &&
            cookie.name.includes("session_token"),
        ),
      );
      await one.locator("#logout").click();
      await one.locator("#session").filter({ hasText: "signed out" }).waitFor();
      await two.reload();
      await two
        .locator("#session")
        .filter({ hasText: "oauth@example.invalid" })
        .waitFor();
      assert.equal(authorizations, 3);
      assert.equal(validated, 3);
    } finally {
      await context.close();
      await browser.close();
      if (gateway) await gateway.close();
      await close(first);
      await close(second);
      await close(provider);
    }
  },
);
