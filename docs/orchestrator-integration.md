# Integrating an existing runner

Keep the team's existing scripts. Choose the integration according to who owns
the development processes; Benzo never reads application environment files.

If the repository already exposes a standalone server script, select it:

```sh
benzo --script dev:web
```

Leading options are equivalent to `benzo dev` options, including
`benzo --auth-relay`. `--help` and `--version` remain informational.
Script selection does not run the root orchestrator or its dependencies. Run the
repository's normal prerequisite setup first. The selected script must either
use a recognized framework or honor `PORT`.

For independently launchable services, keep a JSON manifest outside the checkout,
for example at `$HOME/.config/benzo/my-project.json`:

```json
{
  "backend": { "mode": "external" },
  "services": [
    {
      "name": "web",
      "cwd": "apps/web",
      "command": "npm",
      "args": ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "{port}"],
      "ready": { "path": "/", "timeout": 120000 }
    },
    {
      "name": "api",
      "cwd": "apps/api",
      "command": "npm",
      "args": ["run", "dev"],
      "ready": { "path": "/health", "status": 200 }
    }
  ]
}
```

This example assumes a Next.js web script and an API that honors `PORT` and binds
loopback. Adapt the commands to the project's documented standalone entrypoints.
Service directories resolve relative to the selected checkout, not the manifest.
Benzo supplies a private `PORT` to each service; explicit arguments can use
`{port}`. Services launch independently, not in dependency order.

```sh
benzo config --config "$HOME/.config/benzo/my-project.json" --json
benzo --config "$HOME/.config/benzo/my-project.json"
```

To remember that manifest for this checkout without creating a project file:

```sh
benzo link --config "$HOME/.config/benzo/my-project.json"
benzo
```

`link` validates the manifest and stores its canonical absolute path in Benzo's
per-user home (`BENZO_HOME`, or `~/.cache/benzo`). It stores no manifest contents,
environment values, or launch flags. The manifest is read again on each launch,
so edits take effect next time. Missing/invalid files fail visibly; there is no
silent fallback to another command. A failed `link` leaves the previous
association intact. Clearing Benzo's home also clears these associations.

Associations belong to one canonical checkout, not every worktree of a project.
Symlink aliases share an association; run `link` separately in another worktree
if desired. `benzo unlink` removes only the association and is safe to repeat.
Neither command changes project files or restarts/stops an active launcher.

An explicit `--config` manifest takes precedence over the association, then
`benzo.config.json`, then discovery. During discovery an explicit command after
`--` takes precedence over the `benzo` package field and script detection.
A selected manifest takes precedence over `--script` or a command after `--`.
Use `unlink` to restore ordinary discovery. CLI gateway/auth/environment overrides
apply after loading. `config` and `explain` show the selected source and redact
command arguments and environment values; actual
allocated origins are available through `benzo describe --json` after launch.

The manifest version is `schemaVersion: 1`; omitted versions retain version 1
behavior. Unsupported versions and malformed known fields fail before launch.
Environment values and command arguments must be strings. Readiness uses `http`
or `tcp`, positive integer millisecond timeouts, and optional HTTP status integers
from 100 to 599; HTTP paths must start with `/` and encode spaces. Unknown fields
are retained for compatibility and reported by `config`, `explain`, and startup
diagnostics. Those diagnostics identify field paths without printing values.
This validation does not evaluate shell commands, read environment files, or
guarantee that an application's configured URL/security policy is compatible.

The same explicit integration works without `package.json`. For example, a
Python standard-library static server can be trialed with:

```sh
benzo -- python3 -m http.server '{port}' --bind 127.0.0.1
```

To make later launches bare, associate an external manifest whose service is
`{"name":"web","command":"python3","args":["-m","http.server","{port}","--bind","127.0.0.1"]}`.
The optional `test:clients` suite verifies this against the original Python
command in two isolated directories. It is an explicit command integration,
not Python framework auto-discovery.

If Wireit, Turbo, Compose, or another runner owns dependency order, workers,
migrations, or restart policy, keep it authoritative. Use the
[external listener lease API](environment-api.md#external-listener-leases) in an
integration around that runner: reserve names, start listeners through the runner,
attach their actual loopback ports, then report readiness. Observe `lease.closed`
and release the lease on shutdown; the runner still owns process cleanup.
Do not flatten a task graph into this manifest and assume equivalent behavior.
Automatic task-graph adaptation is not implemented yet.

## Inspect declared Wireit tasks

```sh
benzo inspect --from wireit --script dev --json
```

This reads `package.json` metadata without invoking Wireit, package-manager
hooks, shell commands, or application environment files. It reports a versioned
`wireit-inspection` graph: task IDs, declared dependency edges and `cascade`
settings, aggregate/ordinary/long-running/opaque task distinctions, readiness
mode, and environment key names. Commands, readiness patterns and environment
values are redacted. Relative package references are followed only within the
canonical inspection root; package-file symlinks and oversized package files
are rejected. Traversal is bounded to 128 packages, 256 tasks and 2048 edges.
Task IDs encode a tuple of canonical root-relative package path and script name;
consumers should treat them as opaque and use the separate `package` and `script`
fields for display. Colons in either component cannot merge distinct tasks.

`status: inspected` means the metadata graph was traversed; it is not a Wireit
configuration validator or a compatibility verdict. `status: incomplete` and
exit code 1 identify cycles, missing/opaque tasks, boundary violations, malformed
metadata or traversal limits. Ordinary shell scripts remain opaque leaves;
Benzo does not parse commands to infer additional dependencies. Run from the
workspace root to include sibling package references within that boundary.

A Wireit `service` means long-running, not necessarily an HTTP listener: a
library watcher can be a service too. Every such node reports `listener: unknown`,
and all reports retain `launch: requires-explicit-listener-integration`.
Inspection does not translate the graph into a Benzo manifest or change bare
launch behavior. Keep Wireit authoritative and integrate known listeners through
the lease API. See Wireit's [service and dependency
contract](https://github.com/google/wireit/blob/main/README.md).
