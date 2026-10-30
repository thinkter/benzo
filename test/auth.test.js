import test from "node:test";
import { effectivePort } from "../src/origin.js";
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

function postForm(port, path, body, headers = {}, host = `localhost:${port}`) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          host,
          connection: "close",
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
      },
      (res) => {
        let bytes = "";
        res.on("data", (chunk) => (bytes += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: bytes,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("form_post callbacks require the observed method, unique state and active owner while preserving replay bytes", async () => {
  let port;
  const callbacks = new Map();
  const app = createServer(async (req, res) => {
    if (req.url.startsWith("/start")) {
      const input = new URL(req.url, "http://app");
      const authorization = new URL("https://provider.invalid/authorize");
      authorization.searchParams.set("state", input.searchParams.get("state"));
      authorization.searchParams.set(
        "redirect_uri",
        `http://localhost:${port}${input.searchParams.get("callback") ?? "/callback"}`,
      );
      authorization.searchParams.set(
        "response_mode",
        input.searchParams.get("mode") ?? "form_post",
      );
      return res.writeHead(302, { location: authorization.href }).end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
  });
  await listen(app);
  const routes = new Map([["feature.localhost", { port: app.address().port }]]);
  const gateway = createGateway({ port: 0, routes, callbackStore: callbacks });
  await gateway.listen();
  port = gateway.server.address().port;
  const start = (state, suffix = "") =>
    request(
      port,
      `/start?state=${state}${suffix}`,
      `feature.localhost:${port}`,
    );
  try {
    await start("post-state");
    assert.equal(
      (await request(port, "/callback?state=post-state", `localhost:${port}`))
        .status,
      409,
    );
    const body = "code=a%2Bb+%E2%9C%93&state=post-state&extra=%3D%26";
    assert.equal((await postForm(port, "/wrong", body)).status, 409);
    const callback = await postForm(port, "/callback", body);
    assert.equal(callback.status, 307);
    assert.equal(
      callback.headers.location,
      `http://feature.localhost:${port}/callback`,
    );
    assert.equal(callback.headers["cache-control"], "no-store");
    assert.equal(callback.headers["referrer-policy"], "no-referrer");
    assert.equal(
      (await postForm(port, "/callback", body, {}, `feature.localhost:${port}`))
        .body,
      body,
    );
    assert.equal((await postForm(port, "/callback", body)).status, 409);
    await start("get-state", "&mode=query");
    assert.equal(
      (await postForm(port, "/callback", "state=get-state")).status,
      409,
    );
    assert.equal(
      (
        await request(
          port,
          "/callback?state=get-state&state=other",
          `localhost:${port}`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await request(port, "/callback?state=get-state", `localhost:${port}`))
        .status,
      307,
    );
    await start("replace");
    routes.set("feature.localhost", { port: app.address().port });
    assert.equal(
      (await postForm(port, "/callback", "state=replace")).status,
      409,
    );
    await start("expire");
    for (const entry of callbacks.values()) entry.expires = Date.now() - 1;
    assert.equal(
      (await postForm(port, "/callback", "state=expire")).status,
      409,
    );
    await start("ambiguous");
    await start("ambiguous", "&mode=query");
    assert.equal(
      (await postForm(port, "/callback", "state=ambiguous")).status,
      409,
    );
    assert.equal(
      (await request(port, "/callback?state=ambiguous", `localhost:${port}`))
        .status,
      409,
    );
    await start("static-query", "&callback=%2Fcallback%3Ftenant%3Dstatic");
    assert.equal(
      (await postForm(port, "/callback", "state=static-query")).status,
      409,
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});

test(
  "form_post rejects ambiguous, malformed, encoded and oversized bodies without consuming valid state",
  { timeout: 10000 },
  async () => {
    let port;
    const app = createServer((_req, res) => {
      const authorization = new URL("https://provider.invalid/authorize");
      authorization.searchParams.set("state", "valid");
      authorization.searchParams.set(
        "redirect_uri",
        `http://localhost:${port}/callback`,
      );
      authorization.searchParams.set("response_mode", "form_post");
      res.writeHead(302, { location: authorization.href }).end();
    });
    await listen(app);
    const gateway = createGateway({
      port: 0,
      routes: new Map([["feature.localhost", app.address().port]]),
    });
    await gateway.listen();
    port = gateway.server.address().port;
    try {
      await request(port, "/", `feature.localhost:${port}`);
      for (const [body, headers, expected, path = "/callback"] of [
        ["state=valid&state=valid", {}, 400],
        ["st%61te=valid&state=other", {}, 400],
        ["code=only", {}, 400],
        ["state=", {}, 400],
        ["state=valid%zz", {}, 400],
        ["state=valid&code=%ff", {}, 400],
        [Buffer.from([0xff]), {}, 400],
        [
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from("state=valid"),
          ]),
          {},
          400,
        ],
        ["state=valid", { "content-type": "application/json" }, 415],
        ["state=valid", { "content-encoding": "gzip" }, 415],
        ["state=valid", {}, 400, "/callback?state=valid"],
        ["state=valid&code=body-code", {}, 400, "/callback?code=query-code"],
        ["state=valid&code=body-code", {}, 400, "/callback?co%64e=query-code"],
        [
          "state=valid&code=body-code",
          {},
          400,
          "/callback?error=access_denied",
        ],
        ["state=valid", {}, 400, "/callback?tenant=static"],
        [`state=valid&code=${"a".repeat(65536)}`, {}, 413],
        [
          `state=valid&code=${"a".repeat(65536)}`,
          { "transfer-encoding": "chunked" },
          413,
        ],
      ])
        assert.equal(
          (await postForm(port, path, body, headers)).status,
          expected,
        );
      // A stalled sender gets a bounded deadline and cannot reserve the state.
      const timeout = await new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/callback",
            method: "POST",
            headers: {
              host: `localhost:${port}`,
              "content-type": "application/x-www-form-urlencoded",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.write("state=valid");
      });
      assert.equal(timeout, 408);
      assert.equal(
        (
          await postForm(port, "/callback", "state=valid", {
            "content-type":
              'application/x-www-form-urlencoded; charset="UTF-8"',
          })
        ).status,
        307,
      );
    } finally {
      await gateway.close();
      await close(app);
    }
  },
);

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

test("default callback relay returns each state to its worktree, once, without changing redirect_uri", async () => {
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
    ["first.localhost", app.address().port],
    ["second.localhost", app.address().port],
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

test("default JSON authorization response stays byte-identical while callback affinity is observed", async () => {
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
    routes: new Map([["feature.localhost", app.address().port]]),
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

test("standard auth JSON navigation envelope is observed with content-type parameters", async () => {
  let callbackOrigin;
  const app = createServer((_req, res) => {
    const url = new URL("https://provider.invalid/authorize");
    url.searchParams.set("state", "standard-json-state");
    url.searchParams.set("redirect_uri", `${callbackOrigin}/callback`);
    const original = JSON.stringify({ url: url.href });
    res
      .writeHead(200, { "content-type": "application/json; charset=utf-8" })
      .end(original);
  });
  await listen(app);
  const gateway = createGateway({
    port: 0,
    routes: new Map([["feature.localhost", app.address().port]]),
  });
  await gateway.listen();
  const port = gateway.server.address().port;
  callbackOrigin = `http://localhost:${port}`;
  try {
    const response = await request(
      port,
      "/api/auth/sign-in",
      `feature.localhost:${port}`,
    );
    assert.equal(
      response.body.includes('"url":"https://provider.invalid/authorize'),
      true,
    );
    const callback = await request(
      port,
      "/callback?state=standard-json-state&code=ok",
      `localhost:${port}`,
    );
    assert.equal(callback.status, 307);
    assert.equal(
      callback.headers.location,
      `http://feature.localhost:${port}/callback?state=standard-json-state&code=ok`,
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

test("callback affinity rejects replacement owners, including reused ports", async () => {
  let fixed;
  const app = createServer((_req, res) => {
    const url = new URL("https://provider.invalid/authorize");
    url.searchParams.set("state", "owner-test");
    url.searchParams.set("redirect_uri", fixed);
    res.writeHead(302, { location: url.href }).end();
  });
  await listen(app);
  const routes = new Map([["feature.localhost", app.address().port]]);
  const gateway = createGateway({ routes, port: 0 });
  await gateway.listen();
  const port = gateway.server.address().port;
  fixed = `http://localhost:${port}/api/auth/callback/provider`;
  try {
    await request(port, "/api/auth/signin", `feature.localhost:${port}`);
    routes.delete("feature.localhost");
    routes.set("feature.localhost", app.address().port);
    const result = await request(
      port,
      "/api/auth/callback/provider?state=owner-test&code=private",
      `localhost:${port}`,
    );
    assert.equal(result.status, 409);
    assert.equal(result.headers.location, undefined);
    await request(port, "/api/auth/signin", `feature.localhost:${port}`);
    assert.equal(
      (
        await request(
          port,
          "/api/auth/callback/provider?state=owner-test",
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

test("redirect translation preserves HTTPS, userinfo, foreign ports and response bodies", async () => {
  let location;
  const body = 'fetch("http://localhost:3000/private")';
  const app = createServer((_req, res) =>
    res.writeHead(302, { location }).end(body),
  );
  await listen(app);
  const gateway = createGateway({
    routes: new Map([["feature.localhost", app.address().port]]),
    port: 0,
  });
  await gateway.listen();
  const port = gateway.server.address().port;
  try {
    for (location of [
      `https://localhost:${port}/secure`,
      `http://user:secret@localhost:${port}/private`,
      `http://user@localhost:${port}/private`,
      `http://localhost:${port === 4000 ? 4001 : 4000}/other`,
      "/relative",
      "https://provider.invalid/authorize",
    ]) {
      const result = await request(port, "/", `feature.localhost:${port}`);
      assert.equal(result.headers.location, location);
      assert.equal(result.body, body);
    }
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("Refresh redirects isolate worktrees without rewriting opaque content or unsupported destinations", async () => {
  let refresh;
  const body =
    '<meta http-equiv="refresh" content="0;url=http://localhost:3000/private">';
  const cookie = "session=opaque; Path=/; HttpOnly; SameSite=Lax";
  const app = createServer((_req, res) =>
    res
      .writeHead(200, {
        refresh,
        "set-cookie": cookie,
        "content-type": "text/html",
        "content-length": Buffer.byteLength(body),
      })
      .end(body),
  );
  await listen(app);
  const gateway = createGateway({
    routes: new Map([
      ["first.localhost", app.address().port],
      ["second.localhost", app.address().port],
    ]),
    port: 0,
  });
  await gateway.listen();
  const port = gateway.server.address().port;
  const local = `http://localhost:${port}/logout?next=%2Fhome#done`;
  try {
    for (const hostname of ["first.localhost", "second.localhost"]) {
      for (const [source, expected] of [
        [
          `0;url=${local}`,
          `0;url=http://${hostname}:${port}/logout?next=%2Fhome#done`,
        ],
        [
          `2.5; URL = "${local}"`,
          `2.5; URL = "http://${hostname}:${port}/logout?next=%2Fhome#done"`,
        ],
        [
          `10; url='http://[::1]:${port}/'`,
          `10; url='http://${hostname}:${port}/'`,
        ],
        [
          `0;url=http://127.0.0.1:${port}/`,
          `0;url=http://${hostname}:${port}/`,
        ],
      ]) {
        refresh = source;
        const result = await request(port, "/", `${hostname}:${port}`);
        assert.equal(result.headers.refresh, expected);
        assert.equal(result.body, body);
        assert.equal(
          Number(result.headers["content-length"]),
          Buffer.byteLength(body),
        );
        assert.deepEqual(result.headers["set-cookie"], [cookie]);
      }
    }
    for (refresh of [
      "5",
      "0;url=/relative",
      "0;url=https://provider.invalid/login",
      `0;url=https://localhost:${port}/`,
      `0;url=http://user:secret@localhost:${port}/`,
      `0;url=http://localhost:${port === 4000 ? 4001 : 4000}/`,
      `0;url=//localhost:${port}/`,
      `-1;url=${local}`,
      `0;url="${local}`,
      `0;url='${local}' unexpected`,
      `0;url=${local} extra`,
      [`0;url=${local}`, "1;url=https://provider.invalid/"],
    ]) {
      const result = await request(port, "/", `first.localhost:${port}`);
      assert.equal(
        result.headers.refresh,
        Array.isArray(refresh) ? refresh.join(", ") : refresh,
      );
      assert.equal(result.body, body);
    }
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("late authorization response cannot create affinity for a replacement route", async () => {
  let release;
  let arrived;
  const arrival = new Promise((resolve) => {
    arrived = resolve;
  });
  const app = createServer((_req, res) => {
    release = (fixed) => {
      const url = new URL("https://provider.invalid/authorize");
      url.searchParams.set("state", "late-state");
      url.searchParams.set("redirect_uri", fixed);
      res.writeHead(302, { location: url.href }).end();
    };
    arrived();
  });
  await listen(app);
  const routes = new Map([["feature.localhost", { port: app.address().port }]]);
  const callbacks = new Map();
  const gateway = createGateway({ routes, callbackStore: callbacks, port: 0 });
  await gateway.listen();
  const port = gateway.server.address().port;
  try {
    const pending = request(
      port,
      "/api/auth/signin",
      `feature.localhost:${port}`,
    );
    await arrival;
    routes.set("feature.localhost", { port: app.address().port });
    release(`http://localhost:${port}/callback`);
    await pending;
    assert.equal(callbacks.size, 0);
    assert.equal(
      (await request(port, "/callback?state=late-state", `localhost:${port}`))
        .status,
      409,
    );
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("IPv4 sign-in shares callback affinity with IPv6 and rejects expired recycled ownership", async () => {
  let fixed;
  let state = "dual-state";
  const app = createServer((_req, res) => {
    const url = new URL("https://provider.invalid/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", fixed);
    res.writeHead(302, { location: url.href }).end();
  });
  await listen(app);
  const routes = new Map([["feature.localhost", { port: app.address().port }]]);
  const callbacks = new Map();
  const v4 = createGateway({ routes, callbackStore: callbacks, port: 0 });
  await v4.listen();
  const port = v4.server.address().port;
  const v6 = createGateway({
    routes,
    callbackStore: callbacks,
    port,
    host: "::1",
  });
  try {
    await v6.listen();
    fixed = `http://localhost:${port}/callback`;
    await request(port, "/api/auth/signin", `feature.localhost:${port}`);
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "::1",
          port,
          path: "/callback?state=dual-state",
          headers: { host: `[::1]:${port}` },
        },
        (res) => {
          assert.equal(
            res.headers.location,
            `http://feature.localhost:${port}/callback?state=dual-state`,
          );
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 307);
    assert.equal(
      (await request(port, "/callback?state=dual-state", `localhost:${port}`))
        .status,
      409,
    );
    state = "expired-state";
    await request(port, "/api/auth/signin", `feature.localhost:${port}`);
    for (const entry of callbacks.values()) entry.expires = Date.now() - 1;
    assert.equal(
      (
        await request(
          port,
          "/callback?state=expired-state",
          `localhost:${port}`,
        )
      ).status,
      409,
    );
    routes.set("feature.localhost", { port: app.address().port });
    await request(port, "/api/auth/signin", `feature.localhost:${port}`);
    assert.equal(
      (
        await request(
          port,
          "/callback?state=expired-state",
          `localhost:${port}`,
        )
      ).status,
      409,
    );
  } finally {
    await v6.close();
    await v4.close();
    await close(app);
  }
});

test("port 80 redirects and OAuth callbacks use the effective default port", async (t) => {
  let destination;
  const app = createServer((_req, res) =>
    res.writeHead(302, { location: destination }).end(),
  );
  await listen(app);
  const gateway = createGateway({
    port: 80,
    routes: new Map([["feature.localhost", app.address().port]]),
  });
  try {
    try {
      await gateway.listen();
    } catch (error) {
      if (["EADDRINUSE", "EACCES"].includes(error.code)) {
        t.skip(`Port 80 unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    for (const explicit of ["", ":80"]) {
      destination = `http://localhost${explicit}/done?q=1#section`;
      const redirected = await request(80, "/", "feature.localhost");
      assert.equal(
        redirected.headers.location,
        "http://feature.localhost/done?q=1#section",
      );
      const authorization = new URL("https://provider.invalid/authorize");
      authorization.searchParams.set(
        "redirect_uri",
        `http://localhost${explicit}/callback`,
      );
      authorization.searchParams.set("state", `default-port${explicit}`);
      destination = authorization.href;
      await request(80, "/api/auth/signin", "feature.localhost");
      const callback = await request(
        80,
        `/callback?state=${encodeURIComponent(`default-port${explicit}`)}`,
        "localhost",
      );
      assert.equal(callback.status, 307);
      assert.match(
        callback.headers.location,
        /^http:\/\/feature\.localhost\/callback/,
      );
    }
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("effective origin ports include implicit and explicit HTTP defaults", () => {
  for (const raw of [
    "http://localhost/",
    "http://localhost:80/",
    "http://[::1]:80/",
  ])
    assert.equal(effectivePort(new URL(raw)), "80");
  assert.equal(effectivePort(new URL("http://localhost:3000/")), "3000");
  assert.equal(effectivePort(new URL("https://localhost/")), "443");
});
