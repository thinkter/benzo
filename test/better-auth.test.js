import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import { createGateway } from "../dist/core.js";
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
function request(
  port,
  path,
  { host, method = "GET", body, cookie, origin = `http://${host}` },
) {
  return new Promise((accept, reject) => {
    const encoded = body && JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host,
          origin,
          connection: "close",
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(encoded),
              }
            : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          accept({
            status: response.statusCode,
            headers: response.headers,
            body: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(encoded);
  });
}
function authOptions() {
  return {
    secret: "benzo-local-test-only-secret-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
  };
}

test("real Better Auth defaults work through named gateway without auth configuration changes", async () => {
  const auth = betterAuth(authOptions());
  const app = createServer(toNodeHandler(auth));
  await listen(app);
  const gateway = createGateway({
    port: 0,
    routes: new Map([
      ["first.localhost", app.address().port],
      ["second.localhost", app.address().port],
    ]),
  });
  await gateway.listen();
  const port = gateway.server.address().port;
  try {
    const signup = await request(port, "/api/auth/sign-up/email", {
      host: `first.localhost:${port}`,
      method: "POST",
      body: {
        name: "Local Test",
        email: "benzo@example.invalid",
        password: "local-password-123456",
      },
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    const cookie = signup.headers["set-cookie"]
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.equal(
      (
        await request(port, "/api/auth/get-session", {
          host: `first.localhost:${port}`,
          cookie,
        })
      ).body.user.email,
      "benzo@example.invalid",
    );
    assert.equal(
      (
        await request(port, "/api/auth/get-session", {
          host: `second.localhost:${port}`,
        })
      ).body,
      null,
    );
    const rejected = await request(port, "/api/auth/sign-out", {
      host: `first.localhost:${port}`,
      cookie,
      method: "POST",
      body: {},
      origin: "http://attacker.invalid",
    });
    assert.equal(rejected.status, 403);
    const signout = await request(port, "/api/auth/sign-out", {
      host: `first.localhost:${port}`,
      cookie,
      method: "POST",
      body: {},
    });
    assert.equal(signout.status, 200);
  } finally {
    await gateway.close();
    await close(app);
  }
});

test("fixed auth baseURL incompatibility remains a visible 403; gateway never bypasses CSRF", async () => {
  const auth = betterAuth({
    ...authOptions(),
    baseURL: "http://localhost:3000",
  });
  const app = createServer(toNodeHandler(auth));
  await listen(app);
  const gateway = createGateway({
    port: 0,
    routes: new Map([["feature.localhost", app.address().port]]),
  });
  await gateway.listen();
  try {
    const result = await request(
      gateway.server.address().port,
      "/api/auth/sign-up/email",
      {
        host: "feature.localhost:3000",
        method: "POST",
        body: {
          name: "Local Test",
          email: "test@example.invalid",
          password: "local-password-123456",
        },
      },
    );
    assert.equal(result.status, 403);
    assert.match(result.body.code, /ORIGIN/);
  } finally {
    await gateway.close();
    await close(app);
  }
});
