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
