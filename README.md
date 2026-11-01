# Benzo

Benzo runs an existing local development server behind a stable origin for its
Git worktree.

```text
http://feature.localhost:3000
http://api.feature.localhost:3000
```

It starts your command, assigns the process a private loopback port, and proxies
requests through one shared gateway. It does not edit your application, package
scripts, environment files, hosts file, or teammates' workflow.

Benzo is not a project orchestrator. It does not infer dependency graphs, start
databases, run migrations, or manage application-specific workers.

## Start a project

Benzo is not published yet. Install it from this checkout:

```sh
pnpm add -D /absolute/path/to/benzo
pnpm exec benzo dev
```

Or run the CLI directly:

```sh
node /absolute/path/to/benzo/dist/cli.js dev --cwd /path/to/project
```

Node.js 20.19 or newer is required.

`benzo dev` selects the root `dev` script, then `start`. If the root has neither,
it searches nested packages. One package is selected automatically; multiple
candidates are reported so you can choose one with `--cwd`.

Run a command directly when needed:

```sh
benzo dev -- node server.js
benzo dev -- python -m http.server {port}
benzo dev --script start:web
```

Arguments after `--` are passed as separate arguments. Benzo does not evaluate
shell strings or guess how a custom wrapper forwards ports. The server must honor
`PORT`, or receive an explicit `{port}` argument.

A script that starts a project orchestrator is not wrapped automatically. Keep
that launcher, describe its services in a manifest, or integrate it through the
SDK.

## Commands

```text
benzo dev                         start the selected worktree
benzo status                      show state, URLs, and private ports
benzo urls                        show public URLs
benzo logs [--service NAME]       show captured output
benzo stop                        stop this worktree
benzo doctor                      check discovery, DNS, and auth constraints
benzo config --json               inspect the redacted launch plan
benzo explain                     explain launch decisions
benzo describe --json             read the live environment descriptor
benzo exec -- <command> [args]    run a client with live service bindings
```

Useful launch options:

```sh
benzo dev --cwd ../feature --name feature
benzo dev --gateway-port 3100
benzo dev --env APP_URL='{origin}'
```

Names default to the checkout directory. An active collision gets a numeric
suffix. The first service is `<name>.localhost`; later services are
`<service>.<name>.localhost`. Use `status --json` or `describe --json` for the
actual allocated values.

## Multiple services

Put a manifest in `benzo.config.json`, add a `benzo` field to `package.json`, or
pass an external file with `--config`. Link an external file for later launches:

```sh
benzo link --config /path/to/benzo.json
benzo unlink
```

Example:

```json
{
  "schemaVersion": 1,
  "services": [
    {
      "name": "web",
      "command": "pnpm",
      "args": ["dev", "--port", "{port}"]
    },
    {
      "name": "api",
      "cwd": "backend",
      "command": "node",
      "args": ["server.js"],
      "env": { "PORT": "{port}" },
      "ready": { "path": "/health", "status": 200 }
    }
  ]
}
```

Supported placeholders in command arguments and explicit environment values:

```text
{port}                    private port for this service
{name}                    allocated worktree name
{origin}                  public origin for this service
{gateway}                 gateway port
{service}                 service name
{services.api.origin}     another service's public origin
```

Benzo does not read `.env` files. It preserves inherited environment variables;
`excludeEnv` can remove selected inherited keys. Manifest and `--env` values win
over inherited values. `config` and `explain` show keys, not values or command
arguments.

A service can use HTTP or TCP readiness checks. Backend mode defaults to
`external`, meaning Benzo leaves the backend alone. `shared` runs one configured
watcher for the project; `none` disables backend handling. Benzo does not
provision or isolate backend state.

## Origins, auth, and HTTPS

The gateway forwards request bodies, cookies, headers, streaming responses,
WebSockets, and external redirects. It translates supported redirects back to
the named origin when an app sends a fixed local gateway URL.

Supported local OAuth flows keep callback affinity with the worktree that started
sign-in. Benzo does not change the provider's `redirect_uri`, perform the code
exchange, or disable CSRF checks. Hard-coded trusted origins, parent-domain
cookies, fixed callbacks on another port, and unsupported response modes still
need application-specific handling. Run `benzo doctor`; see
[auth compatibility](docs/auth-compatibility.md).

HTTP is the default. HTTPS is opt-in with a certificate and key you provide:

```json
{
  "gateway": {
    "port": 8443,
    "tls": {
      "certFile": "/path/to/cert.pem",
      "keyFile": "/path/to/key.pem"
    }
  },
  "services": [
    { "name": "web", "command": "pnpm", "args": ["dev", "--port", "{port}"] }
  ]
}
```

Benzo does not generate certificates, install a CA, change trust stores, or edit
DNS. See [HTTPS](docs/https.md).

## Existing orchestrators

An orchestrator can keep ownership of its processes and register listeners with
Benzo:

```js
import { reserveEnvironment } from "benzo";

const lease = await reserveEnvironment({
  cwd: process.cwd(),
  name: "feature",
  services: ["web"],
});

// Start the service with the orchestrator's normal lifecycle.
await lease.attach("web", { port: 4173, ready: true });
// await lease.release() during shutdown.
```

Benzo owns the route for the lifetime of the lease. The orchestrator owns the
process and decides when to stop it. See [the environment API](docs/environment-api.md).

## Portless

Portless inspection is read-only:

```sh
benzo migrate portless --dry-run --json
```

Benzo does not rewrite package files, migrate TLS, preserve Portless origins, or
run workspace graphs. See [the adapter limits](docs/portless-adapter.md).

## State and development

State and logs live in `~/.cache/benzo`. Set `BENZO_HOME` to move them. Logs are
application output and may contain secrets.

```sh
pnpm install
pnpm build
pnpm test
pnpm test:browser       # optional Playwright fixtures
pnpm test:compat        # optional pinned OSS trials
```

The supported core is named worktree origins, private service ports, readiness,
one shared gateway, transparent proxying, and explicit manifest or SDK
integration. Task graphs, framework-specific adapters, databases, migrations,
tunnels, and application rewrites remain outside that core.
