# Benzo opportunity research — 2026-10-30

Historical research: suggestions below are not product commitments. The current
[scope checklist](roadmap-checklist.md) supersedes the broader expansion plan.

This extends the initial Portless comparison with public consumer repositories,
merged integration changes, and adjacent implementations. It is source research,
not a compatibility benchmark. Reported symptoms were not reproduced locally.
PR status was checked through GitHub's API. Some reports and descriptions are
agent-authored; inspected patches establish what changed, not that every claim
in a description is independently proven. Search results containing the ordinary
word “portless” or automated dependency updates were excluded from conclusions.

## Main finding

The recurring opportunity is a reusable worktree environment manager. Teams use
Vercel Portless for addressing, then build service wiring, trust handling,
supervision, data isolation, and test integration around it. Benzo can absorb
repeated integration work without trying to replace every existing task runner.

There is actual abandonment evidence, but not evidence of widespread abandonment.
An open issue is a lead, not a market-size estimate. A successful integration is
not automatically evidence that Portless malfunctioned.

## Consumer evidence

### PagoPA UI: setup friction caused removal

[Merged PR #49](https://github.com/pagopa/ui/pull/49) removes Portless from the
Storybook command and dependency list. Its description says privileged setup
blocked startup and sessions fell back to localhost:6006. The change knowingly
sacrifices concurrent worktree instances. The package.json patch confirms removal.

Opportunity: a useful default that needs neither elevation nor certificate
installation. HTTPS must remain explicit when required. Current Portless has an
unprivileged mode, so “no sudo” alone is not a lasting differentiator.

### Meridian Flow: brittle machine integration

[Merged PR #1168](https://github.com/haowjy/meridian-flow/pull/1168) repairs a parser
after Portless 0.15.12 added uptime to route-list output. The inspected patch
extends the regular expression. Existing routes appeared absent to their tools.

[Merged PR #1091](https://github.com/haowjy/meridian-flow/pull/1091) fixes assumptions
that the proxy always uses 443; route checks and SSR failed on a machine using 1355. The project reads Portless state to determine the actual port.

Opportunity: versioned JSON, an SDK, and one authoritative environment descriptor
containing the effective origins, readiness and identity. Do not make consumers
scrape terminal prose or private files. These are integration-contract failures,
not evidence that arbitrary output changes are upstream API regressions.

### LangWatch: a substantial environment manager around Portless

[Haven's README](https://github.com/langwatch/langwatch/blob/main/tools/thuishaven/README.md)
documents service supervision, databases, simulators, logs, worktree cleanup,
memory accounting and resource limits around Portless. This demonstrates demand
for functionality beyond URL allocation; it does not prove all teams need Haven's
scope.

[Open PR #9052](https://github.com/langwatch/langwatch/pull/9052) addresses failed Go
CLI requests after a rebuilt machine loses system certificate trust but retains
Portless state. The inspected patch constructs a process-local CA pool.

Opportunity: inspect actual trust per supported runtime, combine CA bundles,
offer a consistent command environment, and provide useful repair diagnostics.
Environment injection cannot control an arbitrary client's private TLS settings.

### Heartbeat / Alchemy: wrapping commands is insufficient

[Open issue #2671](https://github.com/alchemy-run/alchemy/issues/2671) asks how to
integrate Portless with an Alchemy-owned Vite server.
[Issue #2747](https://github.com/alchemy-run/alchemy/issues/2747) describes
Heartbeat's custom provider and patched Portless: competing CA settings, port 443
ownership, shell-based port acquisition, and in-process servers with no command
to wrap. This is a maintainer report; the private deployment was not inspected.

Opportunity: APIs to reserve identity, obtain origins before launch, register an
externally owned listener, and release a route with its owner's lifecycle. A CLI
wrapper alone cannot universally integrate framework-owned servers.

### Everr: explicit dependency isolation and supervision

[Merged PR #537](https://github.com/everr-labs/everr/pull/537) combines Process
Compose, Docker and Portless for App/Cloud development. It creates isolated
databases and ingestion paths and coordinates readiness and shutdown. The
configuration patches were inspected.

Opportunity: shared versus isolated dependencies, readiness-gated startup, and
the same service graph for normal development and verification. Integrate with
existing orchestration rather than forcing users to maintain a second graph.

### Cognitive Wealth: separate URLs did not isolate state

[Closed issue #137](https://github.com/m0t0r/cognitive-wealth/issues/137) describes
copied environment files still pointing at shared Postgres and Redis. The chosen
solution assigns databases and Redis prefixes per worktree. Migration changes,
session revocation and rate limits are identified as sources of interference.

Opportunity: explicit state-isolation adapters. Merely changing DATABASE_URL does
not create or migrate a database, and arbitrary Redis consumers may not support
prefixes. Do not describe named URLs as complete environment isolation.

### Everyfield: previews need capacity management

[Merged PR #360](https://github.com/SebastianGarces/everyfield/pull/360) adds a
shared preview-slot check, waiting when the configured limit is reached and
reclaiming qualifying orphan previews. This is evidence of demand for bounded
parallel development, not a measured Portless performance defect.

Opportunity: show per-environment resource use, reuse an existing healthy stack,
and optionally bound simultaneous stacks. Idle suspension needs explicit rules
for background jobs, active tests, connections and retained data.

### Fabrica Dev Kit: migration can damage user configuration

[Open PR #70](https://github.com/yeswework/fabrica-dev-kit/pull/70) fixes its own
Portless integration overwriting WordPress configuration. The proposed fix
preserves custom content and is idempotent. This is an integration-tool bug, not
a Portless core bug.

Opportunity: migrations must preserve unknown configuration, be reversible and
repeatable, and refuse unsupported rewrites instead of guessing.

## Earlier cases remain useful

- [Sokosumi wrapper](https://github.com/masumi-network/sokosumi/blob/main/scripts/local-env/portless-dev.mjs):
  service-origin injection, auth settings, checkout identity, proxy checks and
  process coordination. A strong full-stack compatibility target.
- [state-in-url wrapper](https://github.com/asmyshlyaev177/state-in-url/blob/master/scripts/portless.sh)
  and [development notes](https://github.com/asmyshlyaev177/state-in-url/blob/master/AGENTS.md):
  eight framework examples, fixed-port workaround for concurrent startup,
  agent-backgrounding accommodations and hardcoded E2E origins. A strong
  framework/process integration target.

## Reliability leads, not product differentiation by themselves

- [#382](https://github.com/vercel-labs/portless/issues/382): IDE stop reportedly
  corrupts shared route state. Test interrupted writes and unrelated route survival.
- [#521](https://github.com/vercel-labs/portless/issues/521): conflicting proxy
  starts reportedly overwrite ownership metadata. Test identity-aware stop.
- [#525](https://github.com/vercel-labs/portless/issues/525): early application
  rejection of uploads reportedly becomes proxy 502. Preserve upstream errors.
- [#414](https://github.com/vercel-labs/portless/issues/414): concurrent SSE/POST
  failures, without a deterministic reproducer. Treat as a hypothesis to investigate.
- [#372](https://github.com/vercel-labs/portless/issues/372): service hostname
  placement complicates cookies scoped to one worktree.
- [#408](https://github.com/vercel-labs/portless/issues/408): repeated helpers to
  provide peer-service URLs. Related work already exists in
  [PR #401](https://github.com/vercel-labs/portless/pull/401).

The older [HMR issue #281](https://github.com/vercel-labs/portless/issues/281) is
closed as fixed. It belongs in regression coverage, not a current deficiency claim.

## Adjacent implementations

[Berth](https://github.com/amiable-dev/berth) maintains port ownership and
reconciles it with listeners and containers; it can use Vercel Portless for aliases.
It also generates Compose overrides. This suggests that Benzo should explain
ownership and support existing Compose files without mandatory edits. Berth is
advisory, not a substitute for application supervision.

[runportless/portless](https://github.com/runportless/portless) is a different
project from Vercel's Portless. It documents environment discovery, local and
container services, managed dependencies, traffic inspection, replay and mocks.
It describes itself as alpha without a stable public release, targeting macOS
and systemd-based Linux. Benzo's broad environment-manager direction already has
competition; lightweight adoption and verified portability would matter.

## Recommended scope

First, ship the reusable integration layer: service identities and origins known
before startup, supported environment mappings, an SDK, versioned JSON, and
ownership-safe lifecycle operations. Add a useful unprivileged default and runtime
trust diagnostics. Validate against Sokosumi and state-in-url.

Second, add optional database/container adapters and resource awareness. Everr
and LangWatch are reference architectures rather than realistic first fixtures.
Do not turn every simple app into a managed database/container project.

Third, explore deeper auth callback adapters. They require independent validation
of state, PKCE, cookies and simultaneous flows; they are not a prerequisite for
delivering the more tractable integration improvements above.

## Migration design proposal — not implemented

Offer `benzo dev --from portless` as a trial, followed by
`benzo migrate portless --dry-run` and `benzo migrate portless` for adoption.

Recognize package scripts, root and package-level Portless config, names, script
selection, fixed ports and proxy-disabled tasks. Preserve the entire origin
(scheme, host, port) where supported. List unsupported TLS, tunnels, wildcard or
custom wrappers before any mutation. Never execute a discovered wrapper merely
to learn what it does.

The migration must not blindly rewrite arbitrary JavaScript or shell, uninstall
the shared proxy, remove a trusted CA, kill unrelated projects, or silently change
callbacks and cookie scope. Keep changes reviewable and rollbackable. Repeating
the migration must not duplicate script wrappers or erase custom settings.

An alternative first release is Benzo owning lifecycle and dependency wiring
while optionally using the existing Portless proxy. This lowers switching cost
but retains upstream routing limitations and creates a version-compatibility
obligation. It should be an explicit backend choice, not an invisible dependency.

Success should mean a measured reduction in project-specific launch code and
successful concurrent workflows, not merely successful config conversion.
