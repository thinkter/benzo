# Drop-in replacement roadmap

The goal is to remove project-specific development glue: keep the application's
commands and behavior, add Benzo, and stop thinking about port assignments.
Passing a proxy smoke test does not establish replacement. Each advertised
integration must pass its real application workflow without adoption patches.

This plan follows the [consumer evidence](portless-opportunities-research.md).
That document records reports and inspected patches; it is not benchmark evidence.
The executable evidence lives in [compatibility reports](../compatibility/reports).

## Acceptance contract

- No changes to application code, framework/auth/CORS configuration, existing
  scripts, provider callback registrations, or committed environment files.
- One invocation should discover common single-server scripts. Optional Benzo
  settings can live outside the project. Record every required flag, environment
  key, extra file and manual action, separately from ordinary upstream setup.
- Preserve the complete effective origin when claiming a Portless replacement:
  scheme, hostname and port. An HTTP fallback is useful but fails HTTPS parity.
- Run the same functional journey first with the original command, then with
  the consumer's pinned Portless version, then with the installed Benzo tarball.
  A failed baseline blocks parity. A failed competitor case does not prove Benzo
  replaces that consumer's complete integration.
- Test simultaneous worktrees, internal port separation, state/cookie scope,
  HMR, peer survival and cleanup. Verify source/config remains unchanged.
- Report failed, blocked and not-run cases. Missing prerequisites never count as
  support. Keep raw logs and session material out of checked-in reports.

## 1. Establish the consumer regression suite

Implemented in this change: pinned state-in-url and Sokosumi recipes; reusable
scenario/verdict helpers; explicit original/Portless/packaged-Benzo lanes for
state-in-url; real detached worktrees; form and component-state assertions;
URL serialization, reload and back/forward assertions for router examples;
concurrent startup, name collisions, peer survival and Vite CSS HMR isolation.
These journeys adapt upstream assertions without editing upstream tests.

The suite uses the eight state-in-url examples (React, Router 6/7, Remix 2,
Astro, Next 14/15/16). A selective run records omitted examples as not-run.
Root Wireit orchestration and upstream tests with literal origins remain separate
acceptance work; do not call the whole consumer migrated based on these examples.
Sokosumi records the missing HTTPS capability and blocked authenticated baseline.

Also implemented: Remix Vite launch detection, workspace package-manager
inheritance, diagnostics for Wireit/recursive pnpm/already wrapped commands,
repeatable `--env KEY=value` launch overrides, and protocol regressions for early
upload rejection plus concurrent SSE/POST. The protocol cases investigate the
reported failure classes; they do not reproduce or diagnose Portless's issues.

The manual consumer CI workflow executes these recipes, preserves reports on
failure and fails required lanes on blocked/partial results. Next gate: execute
it remotely and broaden native-platform coverage. Refresh pins separately from
runtime fixes. Run one real app on native Windows/macOS before advertising those
platforms as verified. Upstream shell-dependent scripts remain upstream limits.

## 2. Make configuration predictable and small

Use one precedence order: defaults → discovery → explicit Benzo config → launch
flags. Explicit commands must have documented precedence over package settings.
Add a versioned config schema, unknown-key diagnostics and `benzo config --json`
showing effective commands, origin bindings and environment **key names only**.
Do not print values by default. Keep the normal output to services and URLs.

`--env APP_URL={origin}` already permits a temporary supported runtime override;
`{services.api.origin}` works in manifest bindings. Next add named service overrides
and a dry-run explanation so simple customization does not require wrapper code.
Never infer auth/database settings by reading private environment files.

Gate: config/CLI precedence tests, typo diagnostics, npm/pnpm execution and no
checkout changes. The Sokosumi recipe must replace its URL-injection helper with
a small external Benzo config, preserving its intended session/cookie scope.

Keep discovery independent of JavaScript metadata: explicit commands already
work without package.json. Add documented launch adapters for Django/Uvicorn,
Rails and compiled servers only with real consumer baselines. Each adapter must
preserve the existing command's environment and prove port/host handling on its
supported platforms. Plane's backend is a candidate for the non-Node lane once
its prerequisite services are available. An upstream command that itself depends
on a Unix shell cannot establish Windows support for that consumer.

## 3. Expose a lifecycle API, not terminal parsing

Introduce a public versioned environment descriptor with canonical checkout ID,
effective origins, service IDs, readiness, ownership and lease lifetime. Keep
control capabilities private. Status currently carries `benzo/1`; formalize the
schema and compatibility policy before downstream tools depend on its shape.

Add SDK operations to reserve origins before service startup, attach externally
owned listeners, report readiness and release a lease. In-process Vite/Alchemy
integrations need this; a CLI command wrapper cannot cover them. External
listeners are never terminated by Benzo. Test disconnects, duplicate owners,
interrupted writes and a foreign process occupying a port.

Add `benzo exec -- <command>` using the active descriptor and explicit environment
bindings for test runners and auxiliary clients. Do not require tests to scrape
terminal output or internal state files. DNS and later TLS trust must be checked
in the actual client runtime, including Node and Go.

Gate: an in-process server integration and an external Playwright runner consume
only the documented API; stopping either cannot remove another owner's route.
This addresses Meridian Flow's parsing/port assumptions and Alchemy's API needs.

## 4. Trial Portless adoption without changing the app

Proposed CLI, not shipped:

```text
benzo dev --from portless
benzo migrate portless --dry-run
benzo migrate portless
```

Start with read-only inspection of documented Portless configuration and simple
package scripts. Report unsupported arbitrary wrappers. Never execute a wrapper
just to infer its behavior, or uninstall an existing proxy/CA. Preserve custom
flags and full origins; refuse an occupied route owned by another project.

Only then implement reversible migration of recognized package entries with an
exact before/after plan, backup and idempotence checks. Application source/config
stays untouched. Unknown wrapper logic remains explicit, with a suggested external
Benzo manifest. Do not promise a shell script transpiler.

Gate: state-in-url's eight-app startup and a representative upstream test subset
run without the fixed internal-port table, force flag or stale-route helper.
The migration leaves a clean reversible diff. Include a custom-script preservation
case inspired by Fabrica's overwritten WordPress config report.

## 5. Add HTTPS and diagnose trust boundaries

Keep unprivileged HTTP useful with no certificate/elevation setup. Add opt-in
HTTPS, user-supplied certificates and exact-origin validation. Never silently
change HTTPS443 to HTTP3000 and call it equivalent. Explain occupied ports,
privilege requirements and missing trust before launching expensive services.
Any CA installation must be an explicit action; no surprise system changes.

Extend doctor to test DNS, the actual listening gateway, runtime certificate trust
and a user's requested origin. Browser .localhost resolution does not prove OS
resolution. Provide supported client connection options without global hosts edits.
Container access needs a deliberate network/exposure adapter; loopback inside a
container points to that container, not the host. LAN exposure stays explicit.

Gate: Sokosumi's required HTTPS443 origins, Node/Go/Playwright trust, Secure cookies,
one occupied-port case and Docker host connectivity. Until then Sokosumi is not
a supported replacement. PagoPA's removal motivates measuring manual setup steps.

## 6. Validate auth without weakening it

Default remains pass-through. The opt-in OAuth relay preserves the existing
provider redirect URI for the currently tested query callback flow. Extend only
after reproducing a real failure with a local provider enforcing exact redirect
URI, state and PKCE checks. See [auth cases](auth-compatibility.md).

Test concurrent logins, logout isolation, multiple cookies, broad Domain cookies,
Secure cookies, static base URLs/trusted origins, absolute redirects, a second
callback port, expired/replayed/ambiguous state, gateway restart, compressed
authorization responses and form_post. Record app-policy rejection as a failed
drop-in case; never disable CSRF or rewrite application HTML to make a test pass.

People encounter missing state/PKCE cookies when the callback reaches a different
host, and invalid-origin errors when a new hostname conflicts with a pinned base
URL. Separate hostnames also do not isolate shared-domain cookies or database
sessions. Linked real reports and the distinction between tested cases and known
limits are in the auth document.

Gate: a real authenticated database-backed consumer completes login/action/logout
in two worktrees with an unchanged provider registration. Better Auth fixtures
alone cannot establish this. Arbitrary hardcoded origins may remain unsupported.

## 7. Integrate existing orchestration and optional state isolation

Support explicit service graphs and readiness dependencies first. Add narrow,
tested adapters for existing task runners/Compose metadata; preserve ordinary
backend prerequisites rather than requiring a second orchestration graph.
Keep shared, external and isolated state modes distinct. Shared Postgres/Redis
means shared data even when URLs and processes differ.

Optional adapters can provision per-worktree databases, migrations and supported
cache prefixes, with ownership receipts and explicit cleanup/retention policy.
Never mutate a shared database merely because a second worktree starts. Measure
resource use before adding queueing/capacity controls or idle suspension.

Gate: Documenso/Plane plus an Everr-style stack, migration cross-talk regression,
backend crash, teardown failure, orphan recovery and retained-data behavior.
Later validate LangWatch-style simulators and Everyfield-style bounded capacity.

## Completion criteria

Windows process-tree cleanup currently calls `taskkill.exe` through argv. This
is an explicit exception to a strict Node-APIs-only contract: Node has no Windows
job-object/process-tree termination API. Validate the helper on native Windows
before release. If external OS helpers are forbidden, limit cleanup guarantees
to cooperating children; do not silently claim arbitrary descendant cleanup.

For each advertised consumer, publish the pinned commit, tarball hash, tool/browser
versions, exact journeys, setup burden and unresolved cases. Require no adoption
patches, complete-origin parity for claimed migrations, owned-process/route cleanup,
and successful native-platform runs. Add restart/churn soak tests before claiming
long-running reliability. The current package does not yet satisfy every gate.
