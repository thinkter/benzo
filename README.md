# Benzo

Run development servers in parallel Git worktrees with stable URLs:

```text
http://feature.localhost:3000
http://feature-2.localhost:3000
http://api.feature.localhost:3000
```

**No application edits.** Benzo discovers common development commands, assigns
internal ports, supervises services, and shares one HTTP/WebSocket gateway. It
keeps its files outside your checkout. Auth passes through by default.

## Use it

From a checkout with an existing `dev` script (or `start` when there is no `dev`):

```sh
benzo dev
```

Node.js 20.19+ is required. During development, install this unpublished package
from its checkout or packed tarball:

```sh
pnpm add -D /absolute/path/to/benzo
pnpm exec benzo dev
```

Or install the CLI outside the application:

```sh
npm install --global /absolute/path/to/benzo
benzo dev --cwd /path/to/worktree
```

After publication, the same flows can use the registry package (`pnpm add -D
benzo`, or `pnpm dlx benzo dev`). This repository has not been published.

Benzo recognizes Vite, Next.js, Nuxt and Astro commands and passes their existing
port/host flags. It follows common workspace `--cwd` delegation and final dev
commands in `&&` chains, preserving the original script. Recognition is broader
than the currently tested framework set. Other scripts must already honor `PORT`.

Any executable can also be launched directly, without adding a manifest:

```sh
benzo dev -- node server.js
benzo dev -- python -m http.server {port}
benzo dev --script start:web
```

Benzo does not interpret shell command strings. Put arguments after `--` as
separate tokens. A framework's script still uses its own normal package manager.

## Everyday commands

```text
benzo status              live status, internal ports, URLs and log paths
benzo urls                URLs for this worktree
benzo logs                captured output, including the last stopped run
benzo logs --service api  one service's captured output
benzo stop                ask the owning supervisor to stop this worktree
benzo doctor              discovery, DNS and auth compatibility diagnostics
```

Use `--json` with status, urls or doctor. Use `--cwd`, `--name`, or
`--gateway-port` to override the checkout, public name, or shared gateway port.
Repeat `--env KEY=value` to override an existing application setting for this
launch. For example, `benzo dev --env APP_URL='{origin}'` supplies that service's
public URL without editing an environment file. Launch overrides win over manifest
values and support the same placeholders. Values are not included in status or
doctor output; use your normal secret delivery for credentials rather than CLI
arguments.
The first service uses `<name>.localhost`; subsequent services use
`<service>.<name>.localhost`. Active name collisions get numeric suffixes. Names
and preferred slots persist across stops.

Startup waits for HTTP readiness before printing the compact service summary.
Application log lines have no Benzo service prefixes. A required service failure
stops its worktree and produces a failing exit status. Stopping one worktree leaves
its peers running; the last lease stops the gateway and shared backend watchers.

## Existing auth and fixed OAuth callbacks

Ordinary auth requests, cookies, request bodies, headers and redirects pass through.
Benzo preserves the environment expected by the original command, including auth
settings. It never records inherited environment values in state.

If an existing OAuth provider returns to a fixed localhost callback, opt into:

```sh
benzo dev --auth-relay
```

The relay observes OAuth state in authorization redirects or small uncompressed
auth JSON responses. When the existing callback returns to this gateway's
`localhost` origin, it redirects the browser once to the initiating named
worktree. The original provider `redirect_uri`, code exchange and PKCE validation
stay intact. There are no additional provider callback URLs to register. State
mappings stay in memory, expire after ten minutes, and reject ambiguous/replayed
callbacks. IPv4 and IPv6 listeners share the mappings.

**Limits:** a fixed trusted origin/baseURL, hard-coded browser API origin, parent
Domain cookies, HTTPS-only setup, or OAuth `form_post` flow can require more than
transparent routing. The relay does not fix those cases. It never disables CSRF,
rewrites security policy, or reconfigures the provider. A fixed callback on a
different port is not captured. See [auth cases and existing user
reports](docs/auth-compatibility.md).

## Optional manifest for multiple services

Benzo supports `benzo.config.json`, a `benzo` field in package.json, or an
**external** JSON file via `--config /path/project.json`. None requires changing
application source or existing framework/auth configuration.

```json
{
  "services": [
    { "name": "web", "command": "pnpm", "args": ["dev", "--port", "{port}"] },
    {
      "name": "api",
      "cwd": "backend",
      "command": "node",
      "args": ["server.js"],
      "env": { "PORT": "{port}" },
      "ready": { "path": "/health", "status": 200, "timeout": 60000 }
    }
  ]
}
```

Arguments and explicit `env` values expand `{port}`, `{name}`, `{origin}`,
`{gateway}`, `{service}` and `{services.api.origin}`. Existing env files remain the
application's responsibility; Benzo does not read them. `excludeEnv` optionally
removes named inherited variables for a particular service. A non-HTTP service
can use `ready: { "type": "tcp" }`.

Backends default to `backend: { "mode": "external" }` and are never stopped by
Benzo. `none` is also supported. `shared` accepts `command`, `args`, `cwd` and `env`
for one watcher per Git project, owned by the gateway until all leases end.
Backend configurations must agree across participating worktrees. Benzo does not
provision databases, run migrations, or promise database isolation.

An explicit remote auth adapter remains available with `auth: { "mode":
"callback", "upstream": "https://your-existing-auth-service", "pathPrefix":
"/api/auth/" }`. It forwards matching routes for known worktrees and only callback
GET routes on the fixed localhost host. This adapter is separate from the local
state relay.

## Package API

```js
import { loadManifest, createGateway, namedOrigins, launch, stop } from "benzo";

const config = loadManifest(process.cwd()); // discover if no manifest exists
const urls = namedOrigins("feature", config.services, 3000);
const gateway = createGateway({
  port: 3000,
  routes: new Map([["feature.localhost", 10001]]),
});
await gateway.listen();
// ...
await gateway.close();
```

`reservePorts([ownershipPort, ...servicePorts])` returns an async release function:
`await release()` hands service ports to children; `await release(true)` releases
the ownership lease too. `safeEnvironment` preserves values unless `exclude` is
explicitly provided. CLI processes own their control channels; stop contacts the
supervisor rather than trusting persisted PIDs.

## Portability and demonstrated scope

Runtime code uses Node networking/filesystem/process APIs and argv-based execution.
Windows package-manager shims use cross-spawn; Windows process trees use
`taskkill.exe`, because Node has no Windows process-group termination API. No Unix
shell utilities, privileged setup, hosts-file edits, Git CLI, or containers are
required by Benzo itself.

`.localhost` works in the tested Chromium browser without DNS setup. Some OS
resolvers do not resolve it for command-line clients; doctor reports that and
status exposes the internal loopback ports. Switching origins can affect auth.

State/logs live in `~/.cache/benzo` by default; set `BENZO_HOME` to move them.
State uses private permissions where supported. Application output can contain
sensitive information; don't publish raw logs.

Linux trials passed for packaged Benzo with Excalidraw and eight state-in-url
example apps (React, Router 6/7, Remix, Astro and Next 14/15/16), plus Vite/Next.js
and Better Auth OAuth/PKCE browser fixtures. Consumer application files stayed
unchanged. Root orchestration and automatic Portless migration remain unsupported.
Sokosumi requires HTTPS443 and an authenticated backend baseline; Documenso and
Plane are blocked by missing Docker prerequisites. Native Windows/macOS and
external OAuth providers have not been demonstrated locally. See the [results and
reproduction instructions](compatibility/README.md) and [replacement roadmap](docs/replacement-roadmap.md).
