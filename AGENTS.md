# Benzo project principles

Benzo is additive, not coercive. It should make worktree-aware development
easy for the people who want it while preserving the project's normal command,
localhost URLs, environment, and workflow for everyone else. Never require the
whole team to adopt Benzo, edit application source or environment files, or
replace a working local development path just to provide better routing for one
developer.

Origin virtualization should be transparent and safe: keep users on the named
worktree when that can be done without weakening application security, preserve
external redirects and normal responses, and report unsupported cases clearly
instead of pretending compatibility.

Keep the product focused on named origins, safe proxying/auth, and listener
ownership. Task-graph inspection/execution, database provisioning, framework-
specific adapters and mutating migrations are out of scope. Explicit manifests
and SDK leases are the extension points. Optional research fixtures belong in
compatibility/lab and do not establish supported product features.
