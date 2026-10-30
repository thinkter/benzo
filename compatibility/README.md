# Compatibility trials

Results are scoped to the exact scenarios, upstream commits, package tarball and
platform in `reports/*.json`. A blocked or not-run case is never a pass.

Run from the Benzo root:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm test
pnpm test:browser
pnpm test:clients                # optional Go + Python fixtures; needs go, python3, openssl
pnpm test:soak                   # optional Unix lifecycle stress; 8 cycles by default
pnpm test:compat                  # all pinned OSS recipes
pnpm test:compat excalidraw       # one recipe
pnpm test:compat state-in-url     # 8 consumer examples + pinned Portless
pnpm test:compat sokosumi         # explicit HTTPS/backend blockers
pnpm test:compat --require-pass state-in-url # blocked/partial fail the gate
```

The harness packs Benzo, installs the tarball into `.compat/install`, and invokes
that installed CLI. It clones pinned upstream projects into the ignored `.compat`
cache, establishes the original-command baseline, then creates real Git worktrees
and runs the browser journeys. It does not add Benzo files to upstream projects or
read `.env.local`, `.dev`, or credentials. Test-only dependencies and browser
binaries are required. Commands can take several minutes on first install.

The new consumer suite compares original commands, the Portless version locked
by the upstream commit, and the installed Benzo package. Each Benzo case starts
two actual Git worktrees concurrently and checks internal ports, numeric name
suffixes, application interactions and peer survival. Router journeys assert URL
serialization, reload and history; React asserts component synchronization and
CSS HMR isolation. Cleanup probes service/gateway port release. Git status audits
tracked and untracked files; ignored dependencies/build output are excluded.

`BENZO_COMPAT_APPS` may select comma-separated state-in-url examples (for example
`react,remix2`); omitted apps are recorded as not-run, so this cannot establish an
eight-app pass. The test compares the complete Portless/Benzo origin at an
unprivileged test port. It does not run the root Wireit graph or the upstream E2E
suite that embeds port 1355. Those remain replacement gates in the
[roadmap](../docs/replacement-roadmap.md). Assertions are adapted from upstream;
the entire upstream test suite has not passed through Benzo.

Reports record per-scenario timings/results, exact commit/tool/browser versions,
package hash, setup burden and a scoped replacement verdict. They are updated as
scenarios finish; `execution: running` or `interrupted` is incomplete evidence.
The manual consumer CI workflow runs strict Excalidraw/state-in-url lanes and
uploads sanitized reports even on failure. It has not been run remotely here.

Two completed failing runs are retained: `state-in-url-linux-first-completed.json`
records an Astro baseline startup synchronization failure;
`state-in-url-linux-astro-port-failure.json` records the actual Benzo duplicate-port
defect (BENZO-017). Fixes are followed by fresh runs, without automatic scenario
retries or rewriting the earlier failed outcomes.

An older scoped Linux run recorded 32 passing state-in-url checks; that report is
preserved as `state-in-url-linux-before-audit.json`. The latest
`state-in-url-linux.json` is interrupted and marks replacement `not-established`,
after baseline/form-state and framework build problems. It does not establish a
fresh eight-example pass. Root Wireit orchestration remains unsupported by bare
automatic discovery. Sokosumi's authenticated baseline remains blocked. Benzo
now has opt-in HTTPS, but its required HTTPS443 journey has not been executed.

Excalidraw passed drawing in the browser at the baseline and two named worktrees,
name collision suffixing, WebSocket-backed CSS HMR, worktree isolation, and stopping
one worktree while the other remains usable. The temporary CSS edit is a test
stimulus; it is restored, and all three source diffs must be clean.

Documenso and Plane currently report blocked because Docker is absent on this
host. Their dev scripts use orchestrators; zero-config discovery explicitly reports
unsupported instead of guessing service relationships. Neither project's full
baseline, login or functional journey has been established here. Journey execution
for them remains to be implemented after a baseline is available. Other proposed
projects in the plan have not been run.

The browser fixture suite additionally covers Vite and Next.js interaction/HMR,
and Better Auth OAuth with one fixed callback, a real local provider enforcing
redirect_uri and S256 PKCE, and worktree session/logout isolation. These are small
fixtures, not substitutes for authenticated large-project trials.

`test:clients` is an optional local fixture suite, separate from packaged OSS
consumer trials. Go uses a client-local CA pool and loopback dialer to verify TLS
trust and hostname rejection without bypassing verification; this does not prove
OS DNS or global trust setup. Python's standard-library HTTP server is run first
directly, then in two isolated directories with one external manifest and a
per-checkout `benzo link`. Subsequent launches invoke bare Benzo. The suite checks
name collisions, private ports, live content, peer survival and cleanup while
restoring the fixture content. This demonstrates explicit non-Node integration,
not automatic Python/Django/Uvicorn discovery or a packaged production app.

`test:soak` alternates graceful stops and killed launchers while one peer and an
unrelated listener stay live. It reuses the same hostname/private port, rejects
old query-mode OAuth affinity, then forcibly kills its own gateway and verifies
launcher cleanup and fresh startup. `BENZO_SOAK_CYCLES=64 pnpm test:soak` extends
the run; accepted cycle counts are 2–1000. This is a bounded fixture stress test,
not an overnight soak or a stateful-stack verdict. The signal-injection harness
is skipped on Windows; native Windows cleanup remains a separate evidence gap.
The [recorded Linux run](reports/lifecycle-churn-linux.json) completed 64 cycles
and the forced gateway restart. It does not close the overnight-soak release gate.

`reports/failures.json` tracks findings, fixes, regression coverage and remaining
limits. Raw process output stays in `.compat/commands.log`; it is not published in
reports. `services.log` and `assertions.log` also remain private in that cache.
Logs/traces may contain credentials in arbitrary projects, so reviewed
reports must contain only sanitized metadata. The current harness does not produce
browser traces or cookie dumps. A failed command reports its executable and exit
code; detailed raw output stays local.

Linux/x64 core, lifecycle and auth tests passed on Node 20.19 and 26.10 (29 tests
each). The three browser tests and packaged OSS trial ran on Node 26.10. See
[local validation](reports/local-validation.json). CI is configured to run core
tests on Linux, macOS and native Windows with Node 20/22/24 and browser tests with
Node 24; adding a workflow is not evidence those platforms passed. Firefox/WebKit,
external OAuth providers, overnight soak and complex backend journeys remain
untested.
