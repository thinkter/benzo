# Live environment descriptor (version 1)

Use `benzo describe --json` or `import { getEnvironment } from 'benzo'`:

```js
const environment = await getEnvironment({ cwd: '/path/to/checkout' });
if (environment?.status === 'ready') {
  const web = environment.services.find(service => service.name === 'web');
  console.log(web.origin);
}
```

Both return `null` when no launcher answers the authenticated status request.
An older running launcher without descriptor support produces an explicit restart
error, rather than a fabricated identity. Stop and restart it to upgrade.

The descriptor contains `schemaVersion: 1`, `kind: 'benzo-environment'`, opaque
`projectId` and `worktreeId`, a fresh `instanceId` for each launcher lifetime,
`name`, `status`, `startedAt`, `owner`, and `services`.

Each service has a stable `id` within its worktree, a `name`, its actual public
`origin`, private `upstream.host`/`upstream.port`, and `readiness`. Readiness is
conservative: all required services must have passed startup checks before it
reports `ready`. This is a snapshot, not continuous health monitoring.

Identity is local to this machine and canonical checkout paths. Linked Git
worktrees share a project identity but have distinct worktree/service identities.
Origins are allocated, not predicted. Consumers must not persist an internal port
across launcher restarts. `owner.lifetime` describes the gateway lease's launcher
connection; the snapshot does not grant control of that lease.

No control token, supervisor control port, environment values or log paths are
returned. Additional fields may appear within version 1. Incompatible changes
require a new schema version. Consumers should check schemaVersion and tolerate
unknown fields. The existing `status --json` output remains available; this
explicit descriptor is the integration contract for new consumers.

`getEnvironment` reads CLI-managed launchers. External orchestrators use the
lease handle below; they do not publish a supervisor into CLI status files.

## Run a client against the live environment

### Inspect a launch before starting it

`benzo config --json` and `benzo explain --json` produce a `launch-plan`, not
a live descriptor. `provenance` identifies defaults, the selected source,
CLI overrides, and derived control ports for the displayed fields. Explicitly
configured values equal to defaults still retain their configured provenance.
Environment entries report key names and source labels only; command arguments
and readiness paths remain redacted. No application environment files are read.

Service environment provenance includes inherited process key names after
`excludeEnv`, runtime-provided `PORT`/`BENZO_NAME`/`BENZO_ORIGIN`, manifest
bindings, and CLI `--env` overrides, in that precedence order. Exclusion removes
only inherited bindings: an explicit binding can restore the same key.
`excludedInheritedKeys` records those removals separately. Local executable
directories are prepended to the effective search path at spawn. This describes
Benzo's process environment; it does not predict changes made by an application's
own dotenv loader or package manager. The process environment is a snapshot of
the inspection invocation, not a previously started server's environment.

`requestedName` is the CLI/configured name or checkout basename fallback.
Launch may reuse a saved name when no explicit name is supplied, and active
collisions may change the allocated name. `allocatedName`, each service's
`origin`, and `upstreamPort` are therefore `null` in the plan. `originTemplate`
shows the transport and service prefix with an unresolved `{allocatedName}`.
These templates are explanatory, not URLs to use in clients. Commands and
environment placeholders are expanded only at launch. Use `benzo describe
--json` to obtain the actual allocated values, even if a server is already
running when you inspect configuration.

### Launch a client

```sh
benzo exec --env BASE_URL='{services.web.origin}' -- npx playwright test
benzo exec --env API_ADDRESS='{services.api.host}:{services.api.port}' -- node client.mjs
```

The first example assumes the test runner already reads `BASE_URL`. Benzo does
not infer which variables a client needs or edit its configuration. It requires
a ready CLI-managed environment in the selected checkout (`--cwd` is supported).
It reads the authenticated descriptor, not the current manifest or application
environment files. An external SDK lease is not discoverable through this command.

Explicit `--env` bindings support `{name}`, `{instanceId}`, and each service's
`{services.NAME.origin}`, `{services.NAME.host}`, `{services.NAME.port}`. `origin`
is the named public URL; `host` and `port` are the current private loopback
listener. Numeric loopback access has different host/cookie semantics. Check
named-host DNS in the client's runtime; browsers and Node can behave differently.
Unknown placeholders fail before the command starts. Inherited environment values
are preserved, explicit bindings override them, and an empty value remains empty.

The command runs in the selected checkout with inherited input/output and local
`node_modules/.bin` resolution. Arguments after `--` are literal: Benzo does not
expand descriptor placeholders in arguments or invoke a shell. Invoke a shell
explicitly if the client requires one. Client exit codes propagate; SIGINT and
SIGTERM cancel its owned processes and return 130/143. On Unix this covers the
command's process group, including ordinary descendants; children that explicitly
detach into another group are outside that ownership. The group is also cleaned
up when the command exits. Native Windows process-tree behavior
uses the existing `taskkill.exe` helper and remains unverified on Windows.
On Unix, signal errors other than a vanished group are reported as cleanup
failures. After escalation, Benzo waits up to five seconds for termination.
Linux uses `/proc` to distinguish zombies from running processes; other Unix
systems wait for the group to disappear. No external `ps` command is required.
If termination cannot be verified, cleanup reports failure rather than success.

`exec` owns only its client command; it never starts, restarts, or stops the dev
environment. The descriptor is a startup snapshot, not a lease: a later dev
server stop/restart can invalidate its URLs or ports. Restart the client to pick
up a new descriptor. Environment mappings are neither logged nor persisted by
Benzo; the client remains responsible for its own output.

## External listener leases

```js
import { reserveEnvironment } from 'benzo';
import { createServer } from 'node:http';

const lease = await reserveEnvironment({
  cwd: process.cwd(), name: 'feature', services: ['web'],
});
// Public origins exist before upstream startup.
const origin = lease.describe().services[0].origin;
const server = createServer((req, res) => res.end(`Serving ${origin}`));
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await lease.attach('web', { port: server.address().port });
  // Perform the application's health checks before announcing readiness.
  await lease.setReady('web');
  // Keep the orchestrator running; observe lease.closed for lost gateway ownership.
} catch (error) {
  await lease.release();
  server.close();
  throw error;
}
// On shutdown: await lease.release(); then close your own server.
```

`reserveEnvironment` accepts optional `gateway` settings and an AbortSignal.
`gateway.tls` can specify user-supplied `certFile` and `keyFile` paths for
[HTTPS](https.md); relative paths resolve against `cwd`. Certificate coverage
must include the allocated names. TLS does not change external listener ownership.
Each canonical checkout has one active registration. Names are collision-resolved
by the shared daemon. It reserves routing identities, not upstream ports: callers
can bind port 0 themselves. Routes return 503 and reject WebSocket upgrades until
attached and marked ready. `attach(service, {port, ready: true})` combines those
steps when the caller has already verified readiness. Only loopback ports are
supported, and gateway/control ports are rejected to avoid self-routing.

Updates are acknowledged and serialized on the authenticated registration
connection. They can only change services registered on that connection. Replacing
an upstream invalidates pending callback affinity for the old route. A closed
connection removes its routes; release is idempotent. `closed` resolves on local
connection loss or release; remote deregistration follows connection teardown.
The descriptor marks detached services stopped, while `readiness` is per service
and aggregate status becomes ready only when all services are ready.

Benzo never receives an external server PID and never closes its listener.
Aborting, releasing, or losing the gateway leaves server cleanup to its original
owner. The orchestrator must observe `closed` and decide whether to keep its
ordinary localhost server available or stop it. No application or environment
files are rewritten, and no database or worker lifecycle is inferred.
