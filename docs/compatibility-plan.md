# Drop-in compatibility testing plan

This is a historical research plan, not a commitment to support every listed
stack. Current scope is defined by the [checklist](roadmap-checklist.md).

Status: the first implementation and trials are complete. See
[results](../compatibility/README.md) and the
[failure register](../compatibility/reports/failures.json) for demonstrated scope.
The remaining corpus, native-platform runs and soak tests below are still planned;
passing the current tests does not establish universal compatibility.

## Product contract

Benzo must run a project's existing development services in multiple Git worktrees
without requiring application changes. It must preserve the behavior of the
project's ordinary development command while adding named routing and supervision.

Allowed adoption surface:

- Install or externally invoke Benzo.
- Add a Benzo manifest, or keep that manifest outside the target checkout.
- Select existing development commands, working directories, supported launch
  flags, and per-launch environment overrides in that manifest.
- Use the project's existing documented local dependencies and setup.

Not allowed as a compatibility fix:

- Edit application source, framework configuration, auth configuration, CORS or
  trusted-origin lists, committed environment files, or existing package scripts.
- Patch dependencies, disable host/CSRF validation, weaken cookie security, or
  inject scripts into HTML to conceal a routing failure.
- Require privileged host-file changes or change an OAuth provider's callback URL.

Baseline setup is separate from Benzo adoption. If upstream normally requires a
database and local configuration, establish those first in disposable test
checkouts. Benzo must add no new application configuration requirement. Existing
documented environment knobs may be supplied per launch; record each override.
Never expose secrets in manifests or reports: use test-only values, redaction,
and environment key names rather than credential values.

Do not promise arbitrary hard-coded origins will work automatically. If the
application has no supported runtime knob and transparent routing cannot preserve
its behavior, report unsupported behavior with a specific diagnostic. A required
application edit remains a failed drop-in test.

## 1. Fix deterministic launcher defects first

These are findings from source inspection, not outcomes from OSS trials. Convert
each into a failing regression test before changing the implementation.

1. **Port handoff and readiness:** services currently spawn before reservations
   are released. Add a distinct ownership lease, release service listeners before
   spawn, await listener closure, and verify readiness before printing Ready.
2. **Environment compatibility:** blanket removal of AUTH/GOOGLE/secret variables
   and NODE_ENV can change or break the application. Preserve the environment
   expected by the original command; make filtering explicit per service. Never
   print or serialize inherited environment values.
3. **Registration protocol:** handle fragmented and multiple control messages;
   reject duplicate canonical worktree paths (the current Set contains objects,
   but the duplicate check searches for a string); validate ports and host labels.
   Bound message sizes and close rejected/failed leases.
4. **Shared gateway identity:** a matching config filename is insufficient.
   Validate protocol version, project identity and compatible backend/auth/gateway
   settings. Allow compatible worktrees and reject unrelated projects clearly.
5. **Supervision:** handle spawn errors, closed leases, interrupted startup,
   backend startup failure, and abrupt launcher termination. Stop the whole
   worktree when a required service or gateway dies, with a useful exit status.
6. **State and lifecycle:** persist stable preferred names separately from live
   state; make state writes atomic; avoid trusting stale PIDs; make stop contact
   the owning supervisor. Prevent idle shutdown from stopping a new lease and
   ensure active WebSockets cannot block cleanup indefinitely.
7. **Windows execution:** prove npm/pnpm/yarn launching on real Windows. Appending
   `.cmd` with shell:false is not sufficient evidence that Windows spawning works.
   Resolve supported JS entry points or implement safely quoted platform handling.
8. **Transparent routing:** validate request targets and hosts, contain malformed
   URL errors, scope optional auth routing to known hosts, preserve full relevant
   headers/cookies/body/redirect behavior, and test loopback IPv4 and IPv6.

## 2. Build an executable compatibility harness in Benzo

Keep harness code, project recipes, and reports in this repository. Clone targets
into a separate disposable cache; never modify OCS-27 or use its local config,
state, logs, process environment, or credentials. Use the packaged tarball rather
than imports into Benzo source so executable permissions, bin resolution, exports,
and package contents are tested too.

Each recipe pins repository URL, immutable commit, runtime/package-manager
versions, documented baseline setup, commands, required local dependencies,
externally stored Benzo config, launch overrides, and browser assertions. Inspect
the pinned upstream docs before executing installation scripts. Dependencies such
as databases are isolated fixtures, not additions to Benzo's core runtime.

The Node harness will:

1. Create two actual Git worktrees, plus an unrelated project's worktree.
2. Run the original command and record a functional baseline first.
3. Run the exact packaged Benzo build with the same setup and test data.
4. Execute identical user journeys at the named URL, through real DNS and browser
   behavior. Forced Host headers are useful protocol tests, not DNS acceptance.
5. Record timings, results, sanitized diagnostics and source/config hashes.
6. Stop processes and verify port release, route removal and surviving peers.
7. Clean up even after timeouts; preserve only sanitized reproducibility artifacts.

Browser automation should be scripted (for example with Playwright) and run in CI.
Use Chromium and Firefox for the main suite and WebKit on macOS. A gateway HTTP
200 alone does not count as a functioning application.

## 3. Use a staged real-project corpus

Initial candidates, to be pinned and checked for prerequisite cost before running:

- [Excalidraw](https://github.com/excalidraw/excalidraw): first real-app trial;
  exercise asset loading, client navigation, editing and HMR through named URLs.
- [Documenso](https://github.com/documenso/documenso): authenticated application
  workflows, redirects, forms, cookies, uploads and a database-backed baseline.
- [Cal.diy](https://github.com/calcom/cal.diy): larger scheduling monorepo;
  exercise workspace scripts, public/authenticated routes and origin-sensitive
  flows. The historical cal.com repository URL currently redirects here.
- [Plane](https://github.com/makeplane/plane): multi-service trial; exercise
  frontend/API routing, dependency ordering, background services and streaming
  where supported by its pinned version.
- [Directus](https://github.com/directus/directus): admin/API workflows,
  authentication, uploads and realtime subscriptions where supported.

These are proposed coverage roles, not verified compatibility claims. Check
licenses before labeling the corpus strictly open source; keep source-available
projects in a separately labeled corpus if their pinned license is restrictive.

Add official framework fixtures for Next.js, Vite/React, Nuxt, SvelteKit and a
custom Node server. Include an unmodified default Better Auth fixture and a local
test OAuth provider. These smaller fixtures make upstream failures reproducible;
they do not replace testing complex applications.

Run local login/session/logout journeys first. An OAuth case without a working
baseline or test provider is blocked, not passed. External paid integrations are
separate optional cases and must not determine basic local compatibility.

## 4. Required scenarios for every eligible project

- **Baseline parity:** same routes, assets, APIs, forms, upload/download behavior,
  errors and redirects as the ordinary development command.
- **Parallelism:** two worktrees make distinguishable responses; no cross-routing;
  a third colliding name receives a suffix; restarting restores the preferred name
  when available. Shared backend data is explicitly identified, not called isolated.
- **Live development:** edit a temporary test marker in a disposable worktree;
  confirm HMR/reload, recover from a syntax error, and prove the peer is unaffected.
  These are test stimuli restored after the case, never adoption patches.
- **Realtime:** actual WebSocket messages, HMR reconnect after restart, SSE and
  streamed responses; check Origin and Host behavior rather than just handshakes.
- **Auth:** default pass-through, CSRF/session/login/logout, callback state,
  multiple Set-Cookie headers, absolute redirects, and worktree cookie/session
  isolation including broad Domain cookies. Test the optional adapter separately
  with the original default auth configuration and fixed callback URL.
- **Dependencies:** shared backend starts once, survives the first owner leaving,
  stops after the final lease, and behaves predictably if it dies. External
  backends are never terminated by Benzo.
- **Failures:** occupied gateway/internal ports, simultaneous starts, missing
  command, slow readiness, child exit, gateway crash, cancellation during startup,
  stale state, duplicate launcher, and unknown or malformed hosts.
- **Cleanup:** Ctrl-C and benzo stop terminate descendants; stopping one worktree
  leaves peers and unrelated processes intact; abrupt exit does not strand leases
  or allow stale PID reuse to kill unrelated processes.
- **Drop-in audit:** source/config hashes and tracked/untracked diffs confirm no
  adoption edits. Report any required override, patch or unsupported behavior.

Run race-sensitive scenarios repeatedly and include an overnight soak with
restarts, file changes and WebSocket churn. Record memory/handle trends and leaked
listeners rather than assuming a successful short run establishes stability.

## 5. Record failures as actionable artifacts

Use a machine-readable report per project/commit/platform/package build plus a
human-readable summary generated from it. Scenario outcomes are passed, failed,
blocked, skipped, or not-run; only passed means demonstrated behavior.

Suggested record:

```json
{
  "case": "auth-session-two-worktrees",
  "repository": "https://github.com/example/project",
  "commit": "<immutable upstream SHA>",
  "benzoBuild": "<tarball SHA256>",
  "platform": "<OS/architecture/Node/package manager/browser versions>",
  "baseline": "passed",
  "result": "failed",
  "category": "auth-origin",
  "applicationChangesRequired": false,
  "expected": "Login stays on the named worktree origin",
  "actual": "Redirect leaves the worktree origin",
  "reproduction": "recipes/example.json + scenario identifier",
  "artifacts": ["sanitized-events.json", "failure.png"],
  "trackingIssue": "<local issue ID or URL>",
  "regressionTest": null
}
```

Distinguish Benzo defects, upstream baseline failures, missing prerequisites and
inherent compatibility limits. Do not turn flaky runs into passes by hiding
retries. Retain browser console/network failure metadata, exit codes, port lease
events and cleanup results. Redact headers, cookies, request bodies, database
connection strings and auth state before writing artifacts; keep traces/screenshots
containing session material out of published reports.

## 6. Fix and verify loop

For each Benzo failure:

1. Save the pinned failing recipe and sanitized reproduction.
2. Reduce it to the smallest automated failing regression test in Benzo.
3. Fix Benzo core, launch integration, manifest support or an explicitly opt-in
   gateway adapter. Prefer supported launch flags/environment knobs; do not patch
   application code or silently rewrite application content/security policies.
4. Run the regression, the original real-app case and an adjacent framework case.
5. Run the relevant full parallel/lifecycle suite before closing the issue.
6. Update the compatibility report with the tested build and residual limitations.

A workaround requiring application edits remains a failed drop-in case even if
the app becomes usable. Document unsupported cases instead of redefining success.

## 7. CI and release gates

- Every change: core protocol/process tests and lightweight framework fixtures.
- Scheduled/release runs: pinned complex-project corpus, with bounded time and
  isolated dependencies; refresh upstream pins in separate reviewed changes.
- Platform matrix: Linux, macOS and native Windows; minimum supported Node and
  current LTS. Run a representative real application on every platform and report
  the remaining project/platform cells as untested until executed.
- Release gate: no app adoption patches; all required scenarios pass on the
  advertised project/platform combinations; zero leaked owned processes/listeners;
  auth cases have real assertions; reports are reproducible and sanitized.

Execution order: core defects and packaging -> harness + first fixture ->
Excalidraw -> one authenticated database-backed app -> full multi-service corpus
-> native platform matrix -> soak and release report. Publish supported scope and
known failures; do not claim universal drop-in compatibility from six unit tests.
