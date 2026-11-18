# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.

## What ws protects, and what it doesn't

- **Your data stays local.** Workstreams are markdown files in your data folder. Nothing is sent anywhere unless you turn on the summarizer (`llm.url`). See "Privacy" in [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for exactly what it sends and what is redacted first.
- **The board is for this machine only.** It binds to 127.0.0.1 and has no login. It refuses cross-origin requests, DNS rebinding and requests relayed by a proxy. It can't authenticate a local program that forges headers, so never expose it through a tunnel, proxy or `0.0.0.0`.
- **Hooks never fail a session,** and `ws setup` only changes entries that are entirely ws's own (with backups).
- **Dependencies:** CI fails on any `npm audit` finding in runtime dependencies (`--omit=dev`). Build-only tools (Tailwind, ESLint, Jest) are excluded from that gate; they never run inside the board or the CLI.
