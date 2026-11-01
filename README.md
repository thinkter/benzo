# Benzo

## Run every branch at the same time

Normally, two copies of the same app both try to use `localhost:3000`. You have
to stop one before you can open the other.

Benzo gives each branch its own link:

```text
http://main.localhost:3000
http://payments.localhost:3000
http://payments-2.localhost:3000
```

Run both branches, open both links, and compare them side by side. Stop one
without stopping the other.

Login works normally too. Sign-in and sign-out stay on the branch you are using.
You do not need to change your Google/GitHub setup or edit the app just to try
another branch. See [auth compatibility](docs/auth-compatibility.md) if the app
has unusual auth rules.

Benzo is optional. You can use it in your own copy of the project while the rest
of the team keeps using `pnpm dev`. No shared script changes and no team
migration.

## Try it

Benzo is not published yet. Install it from this checkout:

```sh
pnpm add -D /absolute/path/to/benzo
pnpm exec benzo dev
```

Benzo starts the project’s normal `dev` command and prints your link. No app
changes are needed.

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

## Use it when you need it

Benzo does not edit source files, package scripts, environment files, or hosts
files. Install it globally and use it only when you want these links. Everyone
else can keep running `pnpm dev` as usual.

Unlike Portless, Benzo does not require the project or the whole team to migrate.
It is a tool one developer can turn on for one branch.

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
