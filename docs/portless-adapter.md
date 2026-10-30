# Literal Portless script adapter

Bare `benzo` recognizes these single-command package scripts without editing the
project or starting Portless:

```json
{ "scripts": { "dev": "portless run vite" } }
```

Supported forms are `portless run [--name simple-name] [--] vite ...`,
`portless run [--name simple-name] [--] next dev ...`, and
`portless simple-name vite ...` / `portless simple-name next dev ...`.
Names must be single DNS labels. Arguments must be literal unquoted tokens.
Benzo invokes the underlying executable directly with its own host and port
flags; inherited process environment remains intact. Package-manager-generated
lifecycle environment variables are not synthesized by this adapter.

This is an HTTP trial, not complete origin-preserving migration. Startup warns
that Portless TLS/origins/proxy settings are not imported. The selected Benzo name
can still collide and receive a suffix. Existing app dependencies must already
be installed. No package scripts, environment files or provider registrations
are changed; teammates can keep using the original command.

Rejected rather than guessed: lifecycle pre/post hooks, shell operators,
expansion, quoting, fixed framework host/port flags, unknown executables,
Portless-specific flags and existing local Portless configuration. Use an
original unwrapped `--script`, explicit command or external manifest for those
cases. Project orchestrators and arbitrary custom wrappers remain outside Benzo. The external-listener SDK is available for orchestrators that
need to retain their process ownership.

Tests cover parser rejection and source preservation plus real Vite/Next
browser interaction/HMR with one wrapped and one ordinary worktree. They do not
establish full replacement of a consumer's TLS setup or workspace orchestration.

## Read-only adoption plans

```sh
benzo dev --from portless --json
benzo migrate portless --dry-run --script dev --json
```

Both commands inspect the selected root package script and exit without starting
a server, creating state or editing files. Selection defaults to `dev`, then
`start`. A successful report has `status: "http-trial-available"`, a literal argv
array for an optional Benzo trial, the package SHA-256, and an empty
`projectChanges` array. Stop that trial with Ctrl-C; the original package script
and team workflow remain available. Repeated inspection is deterministic for
unchanged metadata and association state. The checksum identifies the inspected
snapshot; it does not lock files against subsequent changes.

This planner accepts only bare literal Vite/Next wrappers, optionally with a
simple name. It is deliberately narrower than the launch adapter: extra framework
arguments require explicit integration because their origin/configuration effects
cannot be inferred. Hooks, shell wrappers, local Portless configuration, and
existing Benzo configuration or associations produce `status: "unsupported"`
with issue codes and exit status 1. Configuration files are detected by name;
their contents are not evaluated or imported. Package metadata is limited to a
regular, non-symlink file of at most 1 MiB. Commands, unknown configuration values
and environment values are not copied into the report.

`automaticMigration` and `originPreserved` remain false even for an available
trial. Global Portless state, TLS trust, tunnels, workspace graphs and full-origin
parity are not established by this report. `benzo migrate portless` without
`--dry-run` is rejected: package rewriting, backups and applied-migration rollback
are not implemented. Use the external manifest or listener SDK for explicit
integration; the planner does not silently replace a custom workflow.
