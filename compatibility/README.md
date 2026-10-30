# Compatibility trials

Results are scoped to the exact scenarios, upstream commits, package tarball and
platform in `reports/*.json`. A blocked or not-run case is never a pass.

Run from the Benzo root:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm test
pnpm test:browser
pnpm test:compat                  # all pinned OSS recipes
pnpm test:compat excalidraw       # one recipe
```

The harness packs Benzo, installs the tarball into `.compat/install`, and invokes
that installed CLI. It clones pinned upstream projects into the ignored `.compat`
cache, establishes the original-command baseline, then creates real Git worktrees
and runs the browser journeys. It does not add Benzo files to upstream projects or
read `.env.local`, `.dev`, or credentials. Test-only dependencies and browser
binaries are required. Commands can take several minutes on first install.

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

`reports/failures.json` tracks findings, fixes, regression coverage and remaining
limits. Raw process output stays in `.compat/commands.log`; it is not published in
reports. Logs/traces may contain credentials in arbitrary projects, so reviewed
reports must contain only sanitized metadata. The current harness does not produce
browser traces or cookie dumps. A failed command reports its executable and exit
code; detailed raw output stays local.

Linux/x64 core, lifecycle and auth tests passed on Node 20.19 and 26.10 (25 tests
each). The three browser tests and packaged OSS trial ran on Node 26.10. See
[local validation](reports/local-validation.json). CI is configured to run core
tests on Linux, macOS and native Windows with Node 20/22/24 and browser tests with
Node 24; adding a workflow is not evidence those platforms passed. Firefox/WebKit,
external OAuth providers, overnight soak and complex backend journeys remain
untested.
