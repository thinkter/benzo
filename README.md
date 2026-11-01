# Benzo

## One localhost for every worktree

Git worktrees let you keep several branches open at once. Local development
usually does not: every checkout wants the same port, callback URL, and browser
session.

Benzo gives every worktree its own named URL:

```text
http://main.localhost:3000
http://payments.localhost:3000
http://payments-2.localhost:3000
```

Start a branch, open its URL, and leave it running. Start another branch beside
it. Compare them without stopping servers, editing application code, or teaching
the whole team a new workflow.

Authentication comes along with it. For the usual localhost setup, sign-in,
sign-out, cookies, and supported local OAuth callbacks work out of the box and
stay on the worktree that started them. You do not need to add callback URLs at
the provider or change the application's auth setup just to try another branch.
[Auth compatibility](docs/auth-compatibility.md) covers the small set of
applications with hard-coded origin rules.

- Review a branch while your current work stays live.
- Compare two versions side by side.
- Keep each worktree on its own browser origin.
- Stop one worktree without taking down the others.
- Give tests the URL for the environment they are actually using.

## Try it

Benzo is not published yet. Install it from this checkout:

```sh
pnpm add -D /absolute/path/to/benzo
pnpm exec benzo dev
```

Benzo starts the project’s existing `dev` command and prints the worktree URL.
If the root package has no `dev` or `start`, it checks nested packages. One
candidate is selected automatically; several candidates are shown so you can
choose one.

Run a command directly when you prefer:

```sh
benzo dev -- node server.js
benzo dev -- python -m http.server {port}
```

Node.js 20.19 or newer is required.

## Daily use

```text
benzo status                      see what is running
benzo urls                        copy this worktree's URLs
benzo logs                        read the app output
benzo stop                        stop this worktree
benzo doctor                      check common origin and auth problems
```

Choose a checkout or name when you need to:

```sh
benzo dev --cwd ../payments --name payments
```

Names are kept stable when possible. If a name is already active, Benzo adds a
suffix. Additional services get subdomains such as `api.payments.localhost`.

## It fits around your project

Benzo is an optional layer around local development. It does not edit source
files, package scripts, environment files, or hosts files. A teammate can keep
using the normal project command while you use Benzo in another worktree.

This is per-developer adoption. You can install Benzo globally and use it only
when you want named worktree URLs. Everyone else can keep running `pnpm dev` as
usual. Portless-style adoption changes the project's shared command or config,
which makes the migration a team decision; Benzo does not require that.

Most projects need no configuration. For multiple services or an existing
orchestrator, use a manifest or the SDK. Benzo owns the named route; your
project remains responsible for its processes and dependencies.

See the [environment API](docs/environment-api.md) for live URLs, client
bindings, manifests, and externally owned listeners.

## More

- [Auth and origin compatibility](docs/auth-compatibility.md)
- [HTTPS](docs/https.md)
- [Portless adapter limits](docs/portless-adapter.md)
- [Compatibility trials](compatibility/README.md)
- [Project scope](docs/roadmap-checklist.md)

## Development

```sh
pnpm install
pnpm build
pnpm test
```

State and logs live in `~/.cache/benzo`; set `BENZO_HOME` to move them. Logs are
application output and may contain secrets.
