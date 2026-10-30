import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";

export function listen(server, port, host = "127.0.0.1") {
  return new Promise((accept, reject) => {
    const error = (value) => reject(value);
    server.once("error", error);
    server.listen({ port, host, exclusive: true }, () => {
      server.off("error", error);
      accept();
    });
  });
}
function hostFor(request) {
  const host = request.headers.host;
  if (
    typeof host !== "string" ||
    !/^(?:[a-z0-9.-]+|\[::1\])(?::[0-9]+)?$/i.test(host)
  )
    return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
const stateKey = (value) => createHash("sha256").update(value).digest("hex");
export function createGateway({
  routes = new Map(),
  port = 3000,
  host = "127.0.0.1",
  auth = { mode: "pass-through" },
  callbackStore,
} = {}) {
  const sockets = new Set();
  const callbacks = callbackStore ?? new Map();
  function observe(location, request, routeAuth) {
    if (routeAuth?.mode !== "relay" || typeof location !== "string") return;
    try {
      const authorization = new URL(location);
      const state = authorization.searchParams.get("state");
      const redirect = new URL(authorization.searchParams.get("redirect_uri"));
      if (
        !state ||
        state.length > 8192 ||
        !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ||
        redirect.protocol !== "http:" ||
        redirect.port !== String(server.address().port)
      )
        return;
      const key = stateKey(state);
      const destination = `http://${request.headers.host}`;
      const existing = callbacks.get(key);
      // Ambiguous states must not be routed to the wrong worktree.
      if (existing && existing.origin !== destination) {
        callbacks.set(key, { ambiguous: true, expires: Date.now() + 600000 });
        return;
      }
      if (callbacks.size >= 2048)
        callbacks.delete(callbacks.keys().next().value);
      callbacks.set(key, {
        origin: destination,
        path: redirect.pathname,
        expires: Date.now() + 600000,
      });
    } catch {
      /* Not an OAuth authorization redirect. */
    }
  }
  function proxy(request, response, target, routeAuth) {
    const authRequest =
      routeAuth.mode === "callback" &&
      request.url.startsWith(routeAuth.pathPrefix ?? "/api/auth/");
    const destination = authRequest ? new URL(routeAuth.upstream) : undefined;
    const headers = {
      ...request.headers,
      "x-forwarded-host": request.headers.host,
      "x-forwarded-proto": "http",
    };
    if (authRequest) {
      headers.host = destination.host;
      headers["x-better-auth-forwarded-host"] = request.headers.host;
      headers["x-better-auth-forwarded-proto"] = "http";
    }
    const transport =
      destination?.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = transport(
      {
        hostname: destination?.hostname ?? "127.0.0.1",
        port:
          destination?.port ||
          (destination
            ? destination.protocol === "https:"
              ? 443
              : 80
            : target.port),
        method: request.method,
        path: request.url,
        headers,
      },
      (incoming) => {
        observe(incoming.headers.location, request, routeAuth);
        response.writeHead(incoming.statusCode, incoming.headers);
        // Better Auth returns the authorization URL in JSON rather than Location.
        // Relay mode only observes a bounded copy; response bytes pass unchanged.
        let collected = [];
        let size = 0;
        const observeJson =
          routeAuth.mode === "relay" &&
          request.url.startsWith(routeAuth.pathPrefix ?? "/api/auth/") &&
          /^application\/json\b/.test(incoming.headers["content-type"] ?? "") &&
          !incoming.headers["content-encoding"];
        if (observeJson)
          incoming.on("data", (chunk) => {
            size += chunk.length;
            if (size <= 65536) collected.push(chunk);
            else collected = [];
          });
        if (observeJson)
          incoming.once("end", () => {
            if (size <= 65536) {
              try {
                observe(
                  JSON.parse(Buffer.concat(collected).toString()).url,
                  request,
                  routeAuth,
                );
              } catch {}
            }
          });
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(502)
          .end("Benzo: development service is unavailable.");
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  }
  const server = createServer((request, response) => {
    const hostname = hostFor(request);
    if (
      !hostname ||
      !request.url?.startsWith("/") ||
      request.url.startsWith("//") ||
      request.url.includes("\\")
    )
      return response.writeHead(400).end("Invalid local request.");
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      return response.writeHead(400).end("Invalid request URL.");
    }
    const value = routes.get(hostname);
    const target = typeof value === "number" ? { port: value, auth } : value;
    if (!target && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      const state = url.searchParams.get("state");
      const entry = state && callbacks.get(stateKey(state));
      if (
        entry &&
        !entry.ambiguous &&
        entry.expires > Date.now() &&
        entry.path === url.pathname &&
        request.method === "GET" &&
        routes.has(new URL(entry.origin).hostname)
      ) {
        callbacks.delete(stateKey(state));
        return response
          .writeHead(307, {
            location: `${entry.origin}${request.url}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          })
          .end();
      }
      if (state)
        return response
          .writeHead(409, { "cache-control": "no-store" })
          .end(
            "Benzo cannot associate this callback with an active worktree. Restart sign-in from its named URL.",
          );
      // Legacy upstream adapter is explicit, and only the configured callback path
      // is exposed on the fixed localhost origin.
      if (
        auth.mode === "callback" &&
        request.method === "GET" &&
        url.pathname.startsWith(auth.callbackPath ?? "/api/auth/callback/")
      )
        return proxy(request, response, {}, auth);
    }
    if (!target)
      return response
        .writeHead(404)
        .end("Unknown Benzo worktree. Use benzo urls.");
    proxy(request, response, target, target.auth ?? auth);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
  );
  server.on("upgrade", (request, socket, head) => {
    const value = routes.get(hostFor(request));
    const target = typeof value === "number" ? { port: value } : value;
    if (!target || !request.url.startsWith("/") || request.url.startsWith("//"))
      return socket.destroy();
    const upstream = createConnection({ host: "127.0.0.1", port: target.port });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      const headers = {
        ...request.headers,
        "x-forwarded-host": request.headers.host,
        "x-forwarded-proto": "http",
      };
      upstream.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
          Object.entries(headers)
            .flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value]).map(
                (entry) => `${name}: ${entry}`,
              ),
            )
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  return {
    server,
    listen: () => listen(server, port, host),
    close: () =>
      new Promise((accept) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => accept());
        server.closeAllConnections();
      }),
  };
}
