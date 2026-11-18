# ws

Workstream state for people who run many Claude Code and Codex sessions on the same piece of work.

A long piece of work (a client site, a migration, a research thread) spans dozens of sessions. What's still open tends to drift across memory notes, status docs and hand-written resume prompts. `ws` gives each workstream one place for:

- **open items** with stable IDs (`AB-3`), and who each is waiting on
- **decisions**, with the reasons and the rejected options, superseded rather than edited
- **a session log**, one file per session, filled in automatically by hooks
- **pointers** to the project's own docs, which ws reads rather than copies

From those it builds a fresh resume prompt whenever you start a session. Everything is plain markdown on your machine. Nothing is sent anywhere unless you turn on the optional summarizer.

## Quick start

Requires Node 20+, and Claude Code and/or Codex.

```bash
git clone https://github.com/justinrhowell/workstreams.git && cd workstreams
npm --prefix ws ci
node ws/bin/ws.mjs setup        # data folder, `ws` on PATH, hooks + MCP for Claude Code and Codex
```

`ws setup` is safe to re-run. It backs up any settings file it changes (`*.bak-ws`) and leaves your other hooks alone. Use `--dry-run` to see what it would do, or `--claude` / `--codex` to set up only one tool. Codex asks you to approve new hooks once: run `/hooks` in Codex.

Then create a workstream for a project folder and start working:

```bash
ws new site --title "Acme site rebuild" --cwd ~/code/acme-site
ws item add site "Fix the nav on mobile" --waiting "client: final copy"
ws go site            # edit the resume prompt, then launch Claude Code in that folder
```

Sessions that start in `~/code/acme-site` are told which workstream they're in and what's open. When they end, they're logged against it. Sessions in folders no workstream claims go to `ws inbox`.

## The board (optional)

```bash
npm ci                # once, from the repo root
ws board              # http://127.0.0.1:3311
```

A local web view of every workstream: columns by status, staleness, the inbox, summarizer proposals, and per-workstream detail. It binds to 127.0.0.1 and refuses cross-origin writes. On macOS, `ws board --install` keeps it running in the background.

## Parts

| Part | Where | What it does |
|---|---|---|
| CLI | `ws/bin/ws.mjs` | `setup`, `new`, `go`, `prompt`, `item`, `decide`, `log`, `inbox`, `review`, `stale`, `doctor`, `board`, … (`ws help`) |
| Hooks | `ws hook claude\|codex start\|end` | Start: tell the session what's open. End: log it, or put it in the inbox |
| MCP server | `ws/mcp/server.mjs` | `ws_list`, `ws_show`, `ws_compose`, `ws_item_*`, `ws_decide`, `ws_log`, `ws_set_status`, `ws_inbox` |
| Summarizer | `ws/lib/summarize.mjs` | Optional. Drafts notes for sessions that ended without any, using any OpenAI-compatible model. Nothing applies until you accept it |
| Board | Next.js app in this folder | Local web view (above) |

## Configuration

Your data lives in `$WS_ROOT`, which defaults to `$XDG_DATA_HOME/ws` or `~/.local/share/ws`. It is never inside this repo. Optional settings go in `$WS_ROOT/config.json`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for every setting and environment variable.

## Platforms

macOS and Linux. The background board service (`ws board --install`) is macOS-only for now. Windows is untested; WSL should work like Linux.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works, and the rules it keeps
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): settings, environment variables, manual hook setup
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup and how to send changes
- [TESTING.md](TESTING.md): the test suites

MIT licensed.
