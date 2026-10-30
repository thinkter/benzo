import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createGateway } from "../src/core.js";
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
function request(port, path, host = "feature.localhost:3000", headers = {}) {
  return new Promise((accept, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host, connection: "close", ...headers },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          accept({
            status: response.statusCode,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("opt-in upstream adapter preserves callback headers and rejects unknown hosts", async () => {
  const calls = [];
  const app = createServer((req, res) => {
    calls.push({
      url: req.url,
      cookie: req.headers.cookie,
      host: req.headers["x-better-auth-forwarded-host"],
    });
    res
      .writeHead(302, {
        location: "http://feature.localhost:3000/",
        "set-cookie": ["session=ok; Path=/", "state=; Max-Age=0; Path=/"],
      })
      .end();
  });
  await listen(app);
  const gateway = createGateway({
    port: 0,
    routes: new Map([["feature.localhost", 1]]),
    auth: {
      mode: "callback",
      upstream: `http://127.0.0.1:${app.address().port}`,
      pathPrefix: "/api/auth/",
    },
  });
  await gateway.listen();
  try {
    const callback = await request(
      gateway.server.address().port,
      "/api/auth/callback/google?state=test",
      undefined,
      { cookie: "state=test" },
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers["set-cookie"].length, 2);
    assert.equal(calls[0].host, "feature.localhost:3000");
    assert.equal(
      (
        await request(
          gateway.server.address().port,
          "/api/auth/callback/google",
          "unknown.localhost",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          gateway.server.address().port,
          "/api/auth/get-session",
          "localhost",
        )
      ).status,
      404,
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("fixed OAuth callback relay returns each state to its worktree, once, without changing redirect_uri", async () => {
  let callbackOrigin;
  const observed = [];
  const app = createServer((req, res) => {
    const state = req.url.includes("second") ? "state-second" : "state-first";
    const url = new URL("https://provider.invalid/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set(
      "redirect_uri",
      `${callbackOrigin}/api/auth/callback/provider`,
    );
    observed.push(url.searchParams.get("redirect_uri"));
    res
      .writeHead(302, {
        location: url.href,
        "set-cookie": "state=opaque; HttpOnly; Path=/",
      })
      .end();
  });
  await listen(app);
  const routes = new Map([
    ["first.localhost", { port: app.address().port, auth: { mode: "relay" } }],
    ["second.localhost", { port: app.address().port, auth: { mode: "relay" } }],
  ]);
  const gateway = createGateway({ routes, port: 0 });
  await gateway.listen();
  const port = gateway.server.address().port;
  callbackOrigin = `http://localhost:${port}`;
  try {
    await request(port, "/api/auth/sign-in", `first.localhost:${port}`);
    await request(port, "/api/auth/sign-in?second", `second.localhost:${port}`);
    assert.deepEqual(observed, [
      `${callbackOrigin}/api/auth/callback/provider`,
      `${callbackOrigin}/api/auth/callback/provider`,
    ]);
    const first = await request(
      port,
      "/api/auth/callback/provider?state=state-first&code=example",
      `localhost:${port}`,
    );
    assert.equal(first.status, 307);
    assert.equal(
      first.headers.location,
      `http://first.localhost:${port}/api/auth/callback/provider?state=state-first&code=example`,
    );
    assert.equal(
      (
        await request(
          port,
          "/api/auth/callback/provider?state=state-first",
          `localhost:${port}`,
        )
      ).status,
      409,
    );
    const second = await request(
      port,
      "/api/auth/callback/provider?state=state-second",
      `localhost:${port}`,
    );
    assert.match(second.headers.location, /second\.localhost/);
    assert.equal(
      (await request(port, "/wrong?state=unknown", `localhost:${port}`)).status,
      409,
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("Better Auth JSON authorization response stays byte-identical while relay observes state", async () => {
  let callbackOrigin;
  let original;
  const app = createServer((_req, res) => {
    const url = new URL("https://provider.invalid/authorize");
    url.searchParams.set("state", "json-opaque-state");
    url.searchParams.set(
      "redirect_uri",
      `${callbackOrigin}/api/auth/callback/provider`,
    );
    original = JSON.stringify({ url: url.href, redirect: true });
    res.writeHead(200, { "content-type": "application/json" }).end(original);
  });
  await listen(app);
  const gateway = createGateway({
    port: 0,
    routes: new Map([
      [
        "feature.localhost",
        { port: app.address().port, auth: { mode: "relay" } },
      ],
    ]),
  });
  await gateway.listen();
  const port = gateway.server.address().port;
  callbackOrigin = `http://localhost:${port}`;
  try {
    const result = await request(
      port,
      "/api/auth/sign-in/social",
      `feature.localhost:${port}`,
    );
    assert.equal(result.body, original);
    assert.equal(
      (
        await request(
          port,
          "/api/auth/callback/provider?state=json-opaque-state",
          `localhost:${port}`,
        )
      ).status,
      307,
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("relay refuses ambiguous states, expired states and wrong callback paths", async () => {
  let fixed;
  const callbacks = new Map();
  const app = createServer((_req, res) => {
    const url = new URL("https://provider.invalid/authorize");
    url.searchParams.set("state", "same-state");
    url.searchParams.set("redirect_uri", fixed);
    res.writeHead(302, { location: url.href }).end();
  });
  await listen(app);
  const gateway = createGateway({
    port: 0,
    callbackStore: callbacks,
    routes: new Map([
      ["one.localhost", { port: app.address().port, auth: { mode: "relay" } }],
      ["two.localhost", { port: app.address().port, auth: { mode: "relay" } }],
    ]),
  });
  await gateway.listen();
  const port = gateway.server.address().port;
  fixed = `http://localhost:${port}/api/auth/callback/provider`;
  try {
    await request(port, "/api/auth/sign-in", `one.localhost:${port}`);
    assert.equal(
      (await request(port, "/wrong?state=same-state", `localhost:${port}`))
        .status,
      409,
    );
    await request(port, "/api/auth/sign-in", `two.localhost:${port}`);
    assert.equal(
      (
        await request(
          port,
          "/api/auth/callback/provider?state=same-state",
          `localhost:${port}`,
        )
      ).status,
      409,
    );
    callbacks.clear();
    await request(port, "/api/auth/sign-in", `one.localhost:${port}`);
    for (const value of callbacks.values()) value.expires = Date.now() - 1;
    assert.equal(
      (
        await request(
          port,
          "/api/auth/callback/provider?state=same-state",
          `localhost:${port}`,
        )
      ).status,
      409,
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});
