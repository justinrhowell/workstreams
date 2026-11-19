# Contributing

Thanks for helping. Bug reports, fixes and new integrations are all welcome.

## Setup

```bash
git clone https://github.com/justinrhowell/workstreams.git && cd workstreams
npm --prefix ws ci     # CLI, hooks, MCP server
npm ci                 # board (only needed for board work)
```

To develop against throwaway data, set `WS_ROOT` to a temp folder:

```bash
export WS_ROOT="$(mktemp -d)"
node ws/bin/ws.mjs new demo --title Demo --cwd "$PWD"
node ws/bin/ws.mjs prompt demo --no-copy
npm run dev            # board on 127.0.0.1:3311, reading the same WS_ROOT
```

## Before you open a PR

```bash
npm --prefix ws test   # node:test suite for the CLI, hooks, summarizer and MCP server
npm run lint && npm run type-check && npm test && npm run build   # if you touched the board
```

CI runs all of these on Node 20 and 22, and the ws suite on both Ubuntu and macOS.

## Ground rules

These come from the design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Please keep them:

- **All writes go through `ws/lib`.** The CLI, MCP server and board never write workstream files directly. That keeps IDs unique and the `open.md` lock honoured.
- **Hooks never break a session.** `ws hook …` always exits 0 and logs failures to `$WS_ROOT/hook-errors.log`. Anything slow runs detached.
- **Fail loudly on broken pointers.** A resume prompt is never built from a missing file or section.
- **Closed means closed.** A closed item or superseded decision must not appear as current anywhere. `ws/test/state-correctness.test.mjs` guards this. Extend it when you add a new place that shows items.
- **The model proposes; the person accepts.** Summarizer output never applies without review.
- **No user data in the repo.** Tests use temp `WS_ROOT`s and a fake model server. Don't commit real transcripts, eval cases or workstreams.
- **Tests never touch your real setup.** Anything that runs `claude` or `codex` takes an `env` and passes it to the child process; tests give it a fake `HOME` and a `PATH` with stub CLIs (see `ws/test/setup.test.mjs`).
- **Writes are atomic and refuse damage.** Use `writeFileAtomic`; never treat an unreadable file as empty.

## Good first contributions

- Hook support for other agent CLIs that have session start/end hooks (`ws/lib/gemini.mjs` and `ws/test/gemini.test.mjs` show what one takes)
- Windows testing and fixes
- Board accessibility and keyboard navigation

## Commits and PRs

Keep PRs focused. Describe what changed and how you tested it. Conventional commit prefixes (`feat(ws):`, `fix(board):`) are used in the history but aren't required.

By contributing, you agree your contributions are licensed under the MIT License.
