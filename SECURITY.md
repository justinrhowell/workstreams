# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.

## What ws protects, and what it doesn't

- **Your data stays local.** Workstreams are markdown files in your data folder. Nothing is sent anywhere unless you turn on the summarizer (`llm.url`) or sync (`sync.remote` / `sync.shares`). See "Privacy" in [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for exactly what it sends and what is redacted first.
- **The board is for this machine only.** It binds to 127.0.0.1 and has no login. It refuses cross-origin requests, DNS rebinding, and requests whose forwarded-for address isn't this machine (what a typical proxy or tunnel adds). Headers can be forged, so this is a tripwire, not authentication: a program that can reach the port can get in, so never expose it through a tunnel, proxy or `0.0.0.0`.
- **Sync trusts its remote.** With sync on, the data goes to the git remote you configure, and anything pushed there reaches every machine: open items, decisions and briefs from the remote end up in resume prompts and session-start notes. Use a remote only you (and machines you control) can write to. ws never runs code or takes settings from the remote: front matter must be plain YAML (code front matter like `---js` is refused, never evaluated); incoming symlinks, submodules, machine-local files (`config.json`, the queue) and rule changes in `.gitignore` / `.gitattributes` stop the sync before anything is merged; git runs with hooks off and symlinks checked out as plain files; and the merge driver is registered by ws in each clone's own git config, never taken from the repo. See [docs/SYNC.md](docs/SYNC.md).
- **Hooks never fail a session,** and `ws setup` only changes entries that are entirely ws's own (with backups).
- **Dependencies:** CI fails on any `npm audit` finding in runtime dependencies (`--omit=dev`). Build-only tools (Tailwind, ESLint, Jest) are excluded from that gate; they never run inside the board or the CLI.
