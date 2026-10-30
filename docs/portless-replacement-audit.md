# Portless replacement audit

Historical research: suggestions below are not product commitments. The current
[scope checklist](roadmap-checklist.md) supersedes the broader expansion plan.

This audit distinguishes a working proxy from replacement of an existing
development workflow. Research source: `portless-opportunities-research.md`.
Execution evidence: `../compatibility/reports/`, pinned recipe commits, and the
packaged CLI for the recorded OSS trials. Later fixture evidence identifies
working-tree source separately. No upstream application files were
changed to make a compatibility result pass.

## Bare command results

The current CLI was actually invoked without arguments in the pinned roots of
state-in-url, Sokosumi, Documenso and Plane. All four exited with code 1 before
launch, rejecting the root orchestrator. See `bare-cli-audit.json`.

This is a Benzo automatic-discovery limitation, independent of whether those
projects have a working database or Docker installation. It is safer than
guessing, but is not a successful drop-in replacement.

The existing state-in-url harness selects individual example directories and
passes `dev --cwd ... --name ... --gateway-port ...`. It does not run the root
project graph or exercise its Portless shell wrapper through bare Benzo. Its
successful lanes prove individual app compatibility, not whole-repository
replacement. Excalidraw likewise provides browser/lifecycle evidence with
explicit harness configuration, not a bare-command acceptance gate.

## Executed projects

- Excalidraw: fresh packaged trial passed drawing, two worktrees, HMR,
  collision handling and peer survival. This is a useful large-app control,
  not evidence of replacing an installed Portless integration.
- state-in-url: fresh original/Portless/Benzo trials across eight examples.
  Consult the current report for per-lane outcomes. Next.js 14's original
  baseline failed a form-state assertion before the proxy comparisons; its
  replacement result cannot be established. The preceding report is preserved
  separately as `state-in-url-linux-before-audit.json`.
- Sokosumi: no authenticated baseline established. Its wrapper requires trusted
  HTTPS on 443. Benzo now supports user-supplied TLS certificates, but trusted
  browser HTTPS on 443 and this authenticated journey remain unverified.
- Documenso and Plane: Docker is unavailable here. No authenticated functional
  journey was run. Separately, both bare root commands reject orchestration.

## Other research consumers: source inspection, not executed journeys

- [PagoPA UI PR 49](https://github.com/pagopa/ui/pull/49/files): the removed
  Portless wrapper surrounded a Storybook launcher that honors PORT. This is a
  good explicit-command/selected-script integration candidate. Do not call it
  verified without installing and exercising Storybook. The script is named
  `storybook`, which bare Benzo does not select by default.
- [Meridian Flow PR 1168](https://github.com/haowjy/meridian-flow/pull/1168/files):
  tools parse Portless's route-list prose. Benzo's status JSON does not make
  those consumers compatible automatically. Benzo now provides a versioned live descriptor; those consumers still need
  an integration change and validation rather than impersonated terminal output.
- [LangWatch Haven](https://github.com/langwatch/langwatch/blob/main/tools/thuishaven/README.md):
  owns multiple service lanes, simulators, database operations and lifecycle.
  Preserve that orchestrator and integrate routing through an ownership-aware
  API. It also explicitly retains plain `pnpm dev`; optional adoption is not
  unique to Benzo and Portless does not universally force team-wide adoption.
- [Everr PR 537](https://github.com/everr-labs/everr/pull/537/files): container
  configuration and dependency isolation exceed proxy routing. Existing
  Compose/process orchestration should remain authoritative.
- [Fabrica PR 70](https://github.com/yeswework/fabrica-dev-kit/pull/70/files):
  WordPress integration recognizes a Portless-specific forwarded-hop header
  and registers aliases for existing services. Standard forwarding alone is
  not proof of compatibility; external-listener registration and an explicit
  adapter need validation. Never rewrite user configuration automatically.

Heartbeat/Alchemy, Cognitive Wealth and Everyfield remain research leads rather
than newly executed consumer tests. Their in-process listeners, data isolation
and capacity management requirements are not implemented by named URLs alone.

## Recommended implementation order

1. **A supported integration API.** Reserve a worktree/service identity and its
   public origin before launch; attach an externally owned listener; release
   only that owner's route. Existing orchestrators retain process ownership.
   Export a versioned descriptor including scheme, host, port, readiness and
   identity. These primitives now exist through `getEnvironment()` and
   `reserveEnvironment()`; consumer-specific integration remains unverified.
2. **Keep orchestrators external.** Use explicit manifests or the listener SDK
   when a project owns dependency order, workers, or multiple services. Benzo
   does not inspect or execute Wireit/Turbo/workspace graphs and never evaluates
   arbitrary shell/JavaScript to guess behavior.
3. **Per-user fallback configuration.** Existing external JSON manifests,
   explicit commands, script selection, environment placeholders and health
   checks already provide an escape hatch without app edits. `benzo link
   --config <file>` now persists an external association, allowing bare `benzo`;
   `benzo unlink` reverses it. External listener ownership is supported through
   leases; dependency graphs and non-listening workers still need integration.
4. **Explicit HTTPS and trust support.** Preserve the complete requested origin
   and provider callback, with deliberate certificate setup. Do not label an
   HTTP substitute as HTTPS parity. User-supplied TLS is implemented; trusted
   browser/container and privileged-port acceptance gates remain open.
5. **Stronger acceptance gates.** Separate bare-root, selected-app, configured
   integration and unsupported outcomes. Require original baseline, interaction,
   authentication where applicable, concurrent worktrees, shutdown and a clean
   application diff. Tests which expect rejection are not compatibility passes.

## Remaining origin limitations

The current gateway rewrites local absolute Location headers and observes OAuth
state in supported redirects/JSON, and translates bounded HTTP Refresh headers. It does not rewrite JavaScript, HTML, cookies
or JSON navigation URLs. NextAuth-style JSON sign-out URLs, compressed auth
responses and custom origin checks need their own evidence. Bounded observed
`form_post` callbacks now have fixture/browser coverage, including PKCE and
cookie-policy checks; arbitrary signed response modes remain unsupported.
ExamCooker's user-confirmed successful flow does not establish those cases.

The product promise should remain additive: no environment-file inspection,
application rewrites, forced team adoption, or replacement of working task
runners. Separate developers can keep localhost workflows. On the same machine,
an unrelated listener and Benzo cannot both own the same loopback address/port;
that constraint must be reported rather than hidden by terminating its owner.
