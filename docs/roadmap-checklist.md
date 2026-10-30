# Benzo roadmap checklist

Benzo's rule is simple: add worktree-aware routing without taking away the
project's normal command, localhost workflow, or a teammate's choice to use
Benzo. Every compatibility claim needs a real baseline, a real journey, and a
clean upstream checkout.

## Current foundation

- [x] Discover common single-server `dev` and `start` scripts.
- [x] Assign private ports and stable named `.localhost` origins.
- [x] Share one gateway across worktrees with collision-safe names.
- [x] Supervise processes, wait for readiness, capture logs, and clean up.
- [x] Preserve WebSocket, SSE, uploads, and early upstream error responses.
- [x] Run browser coverage for Vite, Next.js, HMR, and concurrent worktrees.
- [x] Keep auth callback affinity and loopback redirects on the named origin.
- [x] Keep ordinary localhost development available for non-Benzo teammates.
- [x] Keep project files and environment files untouched.

## Phase 1: make the contract dependable

- [x] Define and version the read-only live environment descriptor: project identity,
  service identity, origin, internal port, readiness, owner, and launcher lifetime.
  See [environment API](environment-api.md), including external lease control.
- [x] Add `benzo config --json` and `benzo explain` for launch-plan inspection,
  discovery, environment key names and redacted command/readiness fields.
- [x] Version manifests and validate raw container, command, environment, readiness
  and auth field types before normalization; report unknown fields without values.
- [x] Add effective-origin and field-provenance explanations, distinguishing
  requested names from allocated live names and unresolved placeholders.
  Launch plans now include origin templates, unresolved live values, and source
  labels for gateway, worktree, auth/backend modes, and service fields. Text
  explanations include inherited process keys, exclusions and override order;
  application dotenv/package-manager changes remain outside the inspection.
- [x] Add `benzo describe --json` and `getEnvironment()` as the versioned public
  contract alongside legacy status output, with restart identity and redaction tests.
- [x] Add `benzo exec --env KEY={services.web.origin} -- <command>` for clients
  consuming the live descriptor, with literal argv, cancellation and ownership tests.
- [x] Add explicit script selection and external manifest examples for projects
  whose root command is an orchestrator.
  See [integration choices](orchestrator-integration.md).
- [x] Remember an external manifest per user and canonical checkout with
  `benzo link --config <file>`; bare `benzo` uses it and `benzo unlink` reverses it.
- [ ] Add a clear bare-command audit to every compatibility report.
- [x] Add restart, interrupted-start, stale-route, foreign-owner, and churn tests.
  Optional `test:soak` alternates graceful stops and killed launchers, reuses
  ports/hostnames, and forces gateway loss. Overnight reliability remains open.

**Gate:** an external runner can consume the descriptor without scraping logs or
private state files, and stopping one owner cannot affect another owner.

## Phase 2: integrate existing orchestrators

- [x] Add `reserveEnvironment()` to reserve origins before external listener startup.
- [x] Add lease `attach()` for externally owned loopback listeners.
- [x] Add lease readiness/release operations bound to the authenticated connection.
  Tested collision isolation, readiness gating, cancellation and listener survival.
- [ ] Add a narrow Wireit/Turbo/recursive-workspace adapter that reads declared
  task metadata instead of executing arbitrary wrappers to guess behavior.
- [x] Add read-only Wireit graph inspection with explicit opaque/missing tasks,
  cycle and boundary checks, redaction and traversal limits. This does not yet
  launch or adapt the graph.
- [ ] Preserve dependency order, non-listening tasks, environment setup, and
  shutdown semantics from the existing orchestrator.
- [ ] Add a Sokosumi-style multi-service integration without replacing its own
  database, worker, or process manager.

**Gate:** a repository can keep its existing orchestrator authoritative while
Benzo supplies names, origins, routing, and lifecycle registration.

## Phase 3: complete origin virtualization safely

- [x] Rewrite absolute `Location` redirects that target Benzo's own loopback
  gateway back to the initiating named worktree.
- [x] Observe fixed OAuth callback state without changing provider URLs.
- [x] Cover single HTTP `Refresh` headers with explicit `delay; url=URL` syntax,
  using the same loopback-origin restrictions as `Location`.
- [x] Cover standard auth JSON navigation URLs: bounded uncompressed
  `application/json` responses under the configured auth path with a top-level
  string `url`, including content-type parameters. Custom shapes and compressed
  bodies remain unsupported and are documented.
- [x] Cover observed OAuth `form_post` callbacks with strict method/state, body
  size/deadline and ownership checks, plus browser PKCE/cookie regressions.
- [x] Cover gateway restart, callback expiry, replay, and concurrent state.
- [x] Define cookie policy for host-only, `Secure`, and broad `Domain` cookies:
  preserve attributes; never weaken policy to hide a compatibility failure.
- [ ] Add diagnostics for hard-coded browser API origins and trusted-origin
  rejection.
- [ ] Never rewrite arbitrary JavaScript, HTML, opaque JSON, binary responses,
  CSP, integrity hashes, or external provider URLs by blind text replacement.

**Gate:** authenticated login, action, and logout work in two worktrees against
an unchanged provider registration, or the exact unsupported boundary is shown
by `benzo doctor`.

## Phase 4: HTTPS and non-Node consumers

- [x] Support opt-in HTTPS with user-supplied certificates, scheme-aware routing,
  hostname checks and conflict isolation. See [HTTPS limits](https.md).
- [ ] Validate certificate trust in browsers, Node, Go, and containers.
  Node and Go client-local trust/hostname verification pass; the Chromium fixture
  uses an SPKI exception. Full browser/container trust remains open.
- [ ] Keep HTTP useful and unprivileged; never silently call HTTP equivalent to
  HTTPS.
- [ ] Add Django/Uvicorn/Rails/compiled-server adapters only with real baselines.
  The optional Python standard-library server baseline passes through an external
  manifest association and bare launches; this is not automatic framework discovery.
- [ ] Document container host access and deliberate LAN exposure.

**Gate:** Sokosumi's required HTTPS origin and one non-Node consumer pass without
application edits or hidden CA installation.

## Phase 5: stateful stacks and capacity

- [ ] Keep shared, external, and isolated backend modes explicit.
- [ ] Add optional database/Redis/cache isolation adapters with ownership receipts.
- [ ] Add migration cross-talk, orphan cleanup, retained-data, and backend-crash
  tests.
- [ ] Add resource reporting and optional capacity limits only after measuring
  real stacks.

**Gate:** Documenso/Plane or an equivalent Docker-backed stack completes its
baseline and authenticated journey in two worktrees.

## Portless migration

- [x] Add a narrow literal Vite/Next wrapper recognizer for bare Benzo trials,
  with explicit origin limitations and real browser coverage. See
  [adapter contract](portless-adapter.md).

- [x] Implement read-only `benzo dev --from portless` inspection for selected
  literal root scripts, with unsupported configuration/wrapper diagnostics.
- [x] Add `benzo migrate portless --dry-run` with a deterministic no-edit HTTP
  trial plan. It does not claim origin-preserving migration or apply changes.
- [ ] Preserve unknown scripts, custom flags, full origins, and user config.
- [ ] Refuse TLS, tunnel, wildcard, arbitrary shell, and custom-wrapper cases
  rather than guessing.
- [ ] Add idempotence and rollback tests.
  Read-only report determinism and source/state preservation are tested; applied
  migration, backup and rollback remain unimplemented.

Migration is optional. Benzo must remain useful without rewriting a project or
forcing a team-wide switch.

## Release criteria

- [ ] Every advertised consumer has a pinned commit, tarball hash, exact journey,
  setup burden, platform, and unresolved limitations.
- [ ] Reports distinguish passed, failed, blocked, and not-run.
- [ ] No blocked prerequisite is counted as compatibility.
- [ ] Core tests pass on Linux, macOS, and native Windows.
- [ ] Browser tests pass on the advertised browser/runtime matrix.
- [ ] A real authenticated large app passes without an adoption patch.
- [ ] Restart/churn and cleanup soak tests pass before claiming long-running use.
- [ ] README claims match the reports; no universal drop-in promise is made from
  fixture tests alone.
