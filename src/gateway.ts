import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { effectivePort } from "./origin.js";
import { readCallbackState } from "./callback-form.js";

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
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Applications sometimes build absolute redirects from a fixed local base URL.
// A response received through a named worktree must stay on that worktree, so
// rewrite only redirects back to this gateway. External redirects and relative
// redirects remain byte-for-byte unchanged.
function rewriteLocalRedirect(location, request, gatewayPort, protocol) {
  if (typeof location !== "string") return location;
  try {
    const target = new URL(location);
    const requestHost = request.headers.host;
    if (
      !requestHost ||
      !LOOPBACK_HOSTS.has(target.hostname.toLowerCase()) ||
      effectivePort(target) !== String(gatewayPort) ||
      target.protocol !== `${protocol}:` ||
      target.username ||
      target.password
    )
      return location;
    const origin = new URL(`${protocol}://${requestHost}`);
    target.protocol = origin.protocol;
    target.hostname = origin.hostname;
    target.port = origin.port;
    return target.href;
  } catch {
    return location;
  }
}

// Recognize only an unambiguous delay; url=URL header. Keep formatting and
// delay intact, and leave other refresh syntax to the browser unchanged.
function rewriteLocalRefresh(value, request, gatewayPort, protocol) {
  if (typeof value !== "string") return value;
  const match = value.match(/^([\t ]*\d+(?:\.\d+)?[\t ]*;[\t ]*url[\t ]*=[\t ]*)(?:"([^"\s]+)"|'([^'\s]+)'|([^\s"']+))([\t ]*)$/i);
  if (!match) return value;
  const target = match[2] ?? match[3] ?? match[4];
  const rewritten = rewriteLocalRedirect(target, request, gatewayPort, protocol);
  if (rewritten === target) return value;
  const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : "";
  return `${match[1]}${quote}${rewritten}${quote}${match[5]}`;
}

export function createGateway({
  routes = new Map(),
  port = 3000,
  host = "127.0.0.1",
  auth = { mode: "pass-through" },
  callbackStore,
  tls,
} = {}) {
  const protocol = tls ? "https" : "http";
  const sockets = new Set();
  const callbacks = callbackStore ?? new Map();
  function observe(location, request, routeAuth, owner) {
    // State observation is transparent: pass-through mode keeps the upstream
    // response unchanged but still needs callback affinity for named origins.
    // The explicit callback adapter remains excluded because it owns the
    // fixed callback path itself.
    if (
      !["pass-through", "relay"].includes(routeAuth?.mode) ||
      typeof location !== "string"
    )
      return;
    try {
      const authorization = new URL(location);
      const state = authorization.searchParams.get("state");
      const mode = authorization.searchParams.get("response_mode") ?? "query";
      const method = mode === "form_post" ? "POST" : "GET";
      const redirect = new URL(authorization.searchParams.get("redirect_uri"));
      if (
        !owner ||
        routes.get(hostFor(request)) !== owner ||
        !state ||
        authorization.searchParams.getAll("state").length !== 1 ||
        authorization.searchParams.getAll("redirect_uri").length !== 1 ||
        authorization.searchParams.getAll("response_mode").length > 1 ||
        !["query", "form_post"].includes(mode) ||
        (method === "POST" && redirect.search !== "") ||
        redirect.username || redirect.password ||
        state.length > 8192 ||
        !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ||
        redirect.protocol !== `${protocol}:` ||
        effectivePort(redirect) !== String(server.address().port)
      )
        return;
      const key = stateKey(state);
      const destination = `${protocol}://${request.headers.host}`;
      const existing = callbacks.get(key);
      // Ambiguous states must not be routed to the wrong worktree.
      if (existing && (existing.ambiguous || existing.origin !== destination || existing.owner !== owner || existing.path !== redirect.pathname || (existing.method ?? "GET") !== method)) {
        callbacks.set(key, { ambiguous: true, expires: Date.now() + 600000 });
        return;
      }
      if (callbacks.size >= 2048)
        callbacks.delete(callbacks.keys().next().value);
      callbacks.set(key, {
        origin: destination,
        owner,
        path: redirect.pathname,
        method,
        expires: Date.now() + 600000,
      });
    } catch {
      /* Not an OAuth authorization redirect. */
    }
  }
  function relayCallback(request, response, url, state) {
    const entry = callbacks.get(stateKey(state));
    if (entry && !entry.ambiguous && entry.expires > Date.now() &&
        entry.path === url.pathname && request.method === (entry.method ?? "GET") &&
        entry.owner !== undefined && routes.get(new URL(entry.origin).hostname) === entry.owner) {
      callbacks.delete(stateKey(state));
      return response.writeHead(307, {
        location: `${entry.origin}${request.url}`,
        "cache-control": "no-store", "referrer-policy": "no-referrer",
      }).end();
    }
    return response.writeHead(409, { "cache-control": "no-store" }).end(
      "Benzo cannot associate this callback with an active worktree. Restart sign-in from its named URL.",
    );
  }
  function invalidForm(request, response, status) {
    if (response.destroyed) return;
    response.once("finish", () => request.destroy());
    response.writeHead(status, { "cache-control": "no-store", connection: "close" }).end("Invalid or unsupported OAuth form callback.");
    request.resume();
  }
  function proxy(request, response, target, routeAuth) {
    const authRequest =
      routeAuth.mode === "callback" &&
      request.url.startsWith(routeAuth.pathPrefix ?? "/api/auth/");
    const destination = authRequest ? new URL(routeAuth.upstream) : undefined;
    const headers = {
      ...request.headers,
      "x-forwarded-host": request.headers.host,
      "x-forwarded-proto": protocol,
    };
    if (authRequest) {
      headers.host = destination.host;
      headers["x-better-auth-forwarded-host"] = request.headers.host;
      headers["x-better-auth-forwarded-proto"] = protocol;
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
        observe(incoming.headers.location, request, routeAuth, target);
        const headers = { ...incoming.headers };
        if (headers.location)
          headers.location = rewriteLocalRedirect(
            headers.location,
            request,
            server.address().port,
            protocol,
          );
        // Multiple Refresh fields have no defined common parsing contract.
        const refreshCount = incoming.rawHeaders.filter((value, index) =>
          index % 2 === 0 && value.toLowerCase() === "refresh",
        ).length;
        if (refreshCount === 1)
          headers.refresh = rewriteLocalRefresh(headers.refresh, request, server.address().port, protocol);
        response.writeHead(incoming.statusCode, headers);
        // Better Auth returns the authorization URL in JSON rather than Location.
        // Relay mode only observes a bounded copy; response bytes pass unchanged.
        let collected = [];
        let size = 0;
        const observeJson =
          ["pass-through", "relay"].includes(routeAuth.mode) &&
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
                  target,
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
  const handleRequest = (request, response) => {
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
    if (typeof value === "number") routes.set(hostname, target);
    if (!target && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      const states = url.searchParams.getAll("state");
      if (request.method === "POST" && auth.mode !== "callback") {
        if (url.search !== "") return invalidForm(request, response, 400);
        void readCallbackState(request).then(
          state => relayCallback(request, response, url, state),
          error => invalidForm(request, response, error.status ?? 400),
        );
        return;
      }
      if (states.length > 1 || states[0]?.length > 8192)
        return response.writeHead(400, { "cache-control": "no-store" }).end("Invalid callback state.");
      if (states[0]) return relayCallback(request, response, url, states[0]);
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
    if (target.ready === false)
      return response.writeHead(503, { "cache-control": "no-store" }).end("Benzo: service is not ready.");
    proxy(request, response, target, target.auth ?? auth);
  };
  const server = tls ? createHttpsServer(tls, handleRequest) : createServer(handleRequest);
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
    if (!target || target.ready === false || !request.url.startsWith("/") || request.url.startsWith("//"))
      return socket.destroy();
    const upstream = createConnection({ host: "127.0.0.1", port: target.port });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      const headers = {
        ...request.headers,
        "x-forwarded-host": request.headers.host,
        "x-forwarded-proto": protocol,
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
