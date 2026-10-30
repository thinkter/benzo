# Optional compatibility research

This directory holds experiments outside Benzo's supported product surface.
Run `npm run lab:clients` from the repository root to exercise the historical
Go TLS client and Python standard-library server fixtures (requires Go, Python
and OpenSSL). These fixtures are not shipped in the package or run by `npm test`.
They do not imply framework-specific adapters or a commitment to support new
stacks. Existing results remain in `compatibility/reports` with their original
commands and source hashes.
