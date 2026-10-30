# Benzo roadmap checklist

Benzo stays small and additive: it gives existing development servers stable
worktree origins without editing applications, environment files, or team
workflows.

## Supported core

- [x] Discover or explicitly launch one or more existing development services.
- [x] Allocate private ports and stable named `.localhost` origins.
- [x] Share a gateway safely across worktrees and clean up ownership on failure.
- [x] Preserve HTTP bodies, uploads, streaming, WebSockets, cookies and normal
      redirects.
- [x] Relay bounded OAuth query and `form_post` callbacks with owner affinity.
- [x] Observe standard auth JSON `{ "url": "..." }` responses without rewriting
      response bytes.
- [x] Support opt-in HTTPS using user-supplied certificates.
- [x] Expose a redacted launch plan, live descriptor, SDK leases and `exec`.
- [x] Preserve ordinary localhost development for teammates who do not use Benzo.

## Small optional tools

- [x] `benzo config`, `explain`, `doctor`, `describe`, `link` and `unlink`.
- [x] Read-only literal Portless inspection and HTTP trial planning.
- [x] Explicit external manifests for multi-service apps and process managers.

## Deliberate non-goals

- [x] Benzo does not execute Wireit, Turbo, Nx, Compose, or workspace graphs.
- [x] Benzo does not own dependency ordering, background workers, databases,
      Redis, migrations, or application-specific state isolation.
- [x] Benzo does not ship Django/Uvicorn/Rails/compiled-server adapters.
- [x] Benzo does not rewrite JavaScript, HTML, opaque JSON, CSP, integrity
      metadata, arbitrary shell scripts, or application source.
- [x] Portless migration is read-only planning only; package rewriting,
      certificate migration, tunnels, and rollback are out of scope.

## Evidence still needed

- [ ] Trusted browser/container HTTPS and native Windows/macOS validation.
- [ ] Privileged port 443 and Sokosumi's authenticated journey.
- [ ] A refreshed packaged large-app authenticated acceptance run.
- [ ] Longer soak testing beyond the bounded Linux lifecycle stress run.
- [ ] Compatibility reports for any consumer we explicitly advertise.

The supported contract is intentionally narrower than universal Portless
replacement. When an application needs an orchestrator or stateful stack, it
remains authoritative and integrates through an explicit manifest or SDK lease.
