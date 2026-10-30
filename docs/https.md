# Opt-in HTTPS

HTTP remains the default. To use HTTPS, supply your own PEM certificate chain
and unencrypted private key in an external manifest:

```json
{
  "schemaVersion": 1,
  "gateway": {
    "port": 8443,
    "tls": {
      "certFile": "/path/to/development-cert.pem",
      "keyFile": "/path/to/development-key.pem"
    }
  },
  "services": [
    { "name": "web", "command": "npm", "args": ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "{port}"] }
  ]
}
```

This example assumes a Next.js script. Select the appropriate standalone command
for your project. Run `benzo --config /path/to/manifest.json --name feature`, or
[associate the manifest](orchestrator-integration.md) for future bare launches.
Relative certificate/key paths resolve against the selected checkout, not the
manifest directory. Port 8443 is an example; existing occupied ports are never
taken over. Privileged ports still require the host's normal permissions.

Benzo checks that the PEM pair loads, matches, and is currently valid before
starting the gateway. It checks certificate hostname coverage before registering
the worktree. Include every allocated service name, including collision suffixes:
`feature.localhost`, `api.feature.localhost`, and so on. A `*.localhost` certificate
does not cover `api.feature.localhost`. Include `localhost` (or the appropriate
loopback IP SAN) if an existing OAuth registration uses that fixed callback host.

The gateway uses TLS 1.2 or newer, advertises HTTPS origins in descriptors, and
forwards HTTP/WebSocket traffic to private loopback listeners with
`X-Forwarded-Proto: https`. Upstreams remain HTTP. Secure cookie flags are preserved.
Local `Location`/supported `Refresh` redirects and observed OAuth callbacks keep
the HTTPS scheme. Opposite-scheme redirects are left unchanged. An HTTPS gateway
does not also listen for plain HTTP on the same port or add a second callback
port; an existing HTTP-only callback on that port cannot work through it.

Launchers sharing one gateway port must request the same transport and certificate
chain. A mismatch fails without replacing the existing gateway. To rotate a
certificate, stop the launchers using that gateway and restart, or use a different
gateway port. Certificates are loaded at startup; there is no hot reload.
Certificate/key material travels to the gateway through a private pipe, not argv
or persistent Benzo state. Config/describe output exposes whether TLS is enabled,
not PEM contents or key paths. The authenticated control channel remains a
separate loopback TCP listener.

## Client trust and evidence

Benzo does not generate certificates, install a CA, alter trust stores, disable
client certificate verification, or edit hosts files. Configure your browser and
each client runtime to trust the certificate's issuer and resolve its names.
For example, Node clients can use an explicit `ca` option or their normal
`NODE_EXTRA_CA_CERTS` setup. Go and container trust must be configured separately.
See Node's [TLS configuration](https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions).

Tests verify Node connections with certificate verification enabled, rejection
without trust or with a hostname mismatch, HTTPS callback routing, redirects,
encrypted WebSocket forwarding, key redaction, and launcher conflict isolation.
A Chromium fixture exercises Secure host-only cookies, Refresh navigation and
WSS with a test-certificate SPKI exception. That exception is test-only and is
**not evidence of system/browser CA trust**. The optional `test:clients` suite
also verifies Go HTTPS with an explicit root pool and hostname verification:
trust succeeds, missing trust and wrong hostnames fail. It uses a client-local
loopback dialer while retaining the named URL/SNI, so it does not establish OS DNS
resolution. Real trusted-browser setup, containers, privileged port 443, and Sokosumi's authenticated workflow remain
unverified. HTTPS transport alone does not establish full Portless parity.

The TLS test fixtures create ephemeral certificates with `openssl` on PATH.
The shipped runtime needs no OpenSSL CLI: Node loads user-supplied files.
