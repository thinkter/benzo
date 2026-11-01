# Auth across worktrees: tested cases and known failures

These are real problems developers encounter when running multiple local copies.
The linked issue reports describe those failure classes; they are not evidence
that their reporters used Benzo or Git worktrees. Reproduction status below refers
to Benzo's own tests.

## Cookie and callback host mismatch

An Auth.js user [reports subdomain sessions being sent to
localhost](https://github.com/nextauthjs/next-auth/issues/10915). Its [state-cookie
missing discussion](https://github.com/nextauthjs/next-auth/discussions/7491) also
contains reports about callback/domain mismatch. The official [error
reference](https://next-auth.js.org/errors#oauth_callback_error) identifies missing
PKCE verifier or invalid state as callback failure causes.

Different ports on localhost do not provide cookie isolation. Separate hostnames
help for host-only cookies, but cookies scoped to a shared parent domain can still
cross worktree boundaries. Benzo does not strip Domain attributes or silently change
an application's intended session policy.

Tested: a real Chromium context completes three Better Auth sign-ins (ordinary
baseline plus two simultaneous named worktrees), with one unchanged provider
callback, opaque state, validated S256 PKCE, host-only session cookies and logout
isolation. One worktree signing out leaves the other's session valid. The local
provider rejects any changed redirect_uri. This uses a test-only provider; it is
not a claim about Google, GitHub or every enterprise provider.

## Trusted origins, CSRF and pinned base URLs

Better Auth's [security documentation](https://github.com/better-auth/better-auth/blob/main/docs/content/docs/reference/security.mdx)
explains trusted origins and the precedence of static base URLs over forwarded
headers. A [trustedOrigins issue report](https://github.com/better-auth/better-auth/issues/6798)
shows developers hitting invalid-origin and callback validation failures.

Tested: default request-derived Better Auth origins support sign-up, session lookup
and sign-out behind named routes without gateway-specific app configuration.
A request from an unrelated origin remains rejected. An unchanged app pinning
baseURL to `http://localhost:3000` rejects the named worktree origin with 403. That
is a **known compatibility failure**, not a passing login test. The regression
passes only because it verifies that Benzo does not bypass that rejection.

The relay solves callback routing, not an application's trusted-origin policy.
A hard-coded frontend API URL can also send requests outside the named gateway.
Benzo cannot universally fix that while preserving the application and its checks.
`benzo doctor` describes this limit. Per-application detection of the exact auth
failure has not yet been implemented; doctor does not inspect credentials/config.

## Fixed localhost callback relay

Benzo leaves existing provider registration intact when its callback already
points to the gateway's localhost scheme and port. It observes state from a
Location header or an uncompressed JSON authorization response under `/api/auth/`.
The JSON adapter accepts the standard top-level `{ "url": "..." }` envelope and
normal content-type parameters while preserving authorization response bytes.
The matching callback is redirected once to the named origin so the browser
sends that worktree's state/PKCE cookies. A bounded NextAuth-style sign-out
envelope is also translated when its `url` points at this gateway's fixed
localhost origin. Code and state are not modified or stored on disk, and the
provider's original redirect_uri is used by the app's token exchange.

Tested at protocol level: opaque states for simultaneous sign-ins, different
worktrees, JSON response byte preservation, unknown states, replay rejection,
correct callback path, duplicate-state ambiguity, and expiry. Missing/stale state
returns an actionable failure, never a guess at the last active worktree.

Observed `response_mode=form_post` authorization requests also support POST
callbacks using the [standard form encoding](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html).
Benzo reads at most 64 KiB of UTF-8 `application/x-www-form-urlencoded`
data within five seconds, requires exactly one nonempty state field, and checks
the observed method, path, expiry and route owner. A 307 asks the browser to resend
its original POST bytes to the named worktree; Benzo does not reconstruct the form
or turn it into a GET. Any query string on a form callback is rejected, including
static callback query parameters; this bounded adapter supports query-free
form-post callback URIs only. Mixed query/body parameters, duplicate state, malformed encoding,
compressed bodies and unsupported content types fail without consuming valid
pending state. Other response modes such as `form_post.jwt` remain unsupported.

A Chromium/local-provider fixture verifies concurrent form submissions to two
worktrees, exact callback URI, unchanged encoded form bytes, state cookies, PKCE
exchange and host-only Secure session cookies. It uses a custom fixture client
and a scoped test-certificate exception, not a claim of Auth.js/Google/enterprise
provider compatibility or browser CA trust. Cross-site form POSTs require an
application cookie policy that permits them, typically `SameSite=None; Secure`.
An explicit `SameSite=Lax` fixture correctly fails with a missing state cookie;
Benzo does not weaken its attributes or bypass the application's rejection.
Origin/CSRF policy can also reject redirected POSTs and remains unchanged.

Known limits: authorization URLs hidden in compressed
bodies or custom response shapes, a fixed callback on another port, applications
that require every callback request host to equal their static baseURL, and
in-memory mappings lost when the gateway restarts. Start sign-in again after a
gateway restart. The adapter does not grant new origins access to an auth server.

## Other cases to keep visible

HTTP `Refresh` redirects using `delay; url=URL` (optionally quoted) follow the
same translation policy as `Location`: only absolute URLs matching this gateway's
scheme and loopback port become the requesting worktree's origin. Delay, quoting,
body bytes and cookies are preserved. External, opposite-scheme, credential-bearing,
relative and unsupported forms pass through. Duplicate Refresh fields are not
translated. This is a bounded subset of the [HTML refresh processing
rules](https://html.spec.whatwg.org/multipage/semantics.html#attr-meta-http-equiv-refresh),
not an HTML meta-tag rewrite. Refresh authorization responses are not currently
observed for OAuth callback affinity.

- Broad Domain cookies may share sessions despite distinct hostnames.
- Secure cookies and HTTPS-only flows need a correctly trusted local HTTPS setup;
  Benzo supports [opt-in HTTPS](https.md) using user-supplied certificates. It does
  not weaken cookie flags or install a CA. HTTP remains the default.
- External providers may enforce their own exact origins, redirect URIs and client
  policies. Those remain in force.
- Shared backend data stays shared; worktree URL isolation is not database isolation.
- Separate databases/migrations, static asset origins, CORS, absolute redirects,
  service workers and cache namespaces can also cause cross-worktree surprises.
- Existing default pass-through does not rewrite authorization response bodies,
  external redirect targets, Origin headers, CSRF checks or provider
  configuration. The bounded sign-out envelope is the exception: only its
  top-level local `url` is translated so the browser remains on the initiating
  named worktree.

Re-run `pnpm test` and `pnpm test:browser` after auth changes. Add a failing fixture
for a new report, fix it inside Benzo where transparent behavior is possible, then
rerun the affected real application. Mark cases requiring application edits as
unsupported rather than suggesting they are seamless.
