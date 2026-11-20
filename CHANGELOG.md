# Changelog

All notable changes to ws. Versions follow [semantic versioning](https://semver.org); until 1.0, minor versions may change behaviour.

## Unreleased

### Added
- **`ws go --gemini`** (or `tool: gemini`): launches Gemini CLI with the resume prompt (`gemini -i`), and `--resume` continues the last Gemini session by id. Checked against a live Gemini CLI 0.70 session, which also confirmed the start note, the `ws` MCP tools and session logging.

### Fixed
- Gemini CLI's own `<session_context>` setup message is no longer counted as a user turn or sent to the summarizer as the user's words.

## 0.2.0 — 2026-11-20

Search, Gemini CLI support (preview), a Linux board service, WSL-only Windows, Node 22+, and fixes from an end-to-end review: input validation, safer resume prompts, broader and faster secret redaction, and board error states.

### Added
- **Gemini CLI support, preview** (#5): tested against recorded Gemini session files, not yet a live session; `ws go` can't launch Gemini yet (use `ws prompt --tool gemini`). `ws hook gemini start|end`, a reader for Gemini's session files (the current append-only `.jsonl` log and the older single-object `.json`), summarizer digests, and `ws setup --gemini`, which writes the hooks (millisecond timeouts) and the `ws` MCP server into `~/.gemini/settings.json` in one write. Honours `GEMINI_CLI_HOME`. When Gemini leaves `transcript_path` empty, the session file is found by its id.
- **Board service on Linux** (#4): `ws board --install / --uninstall / --rebuild / --status` now work on Linux through a systemd user unit (`~/.config/systemd/user/<board.label>.service`). It runs the production build in `.next-prod`, binds to 127.0.0.1 on `board.port`, pins `WS_ROOT`, restarts on failure, and logs to the journal. Paths are escaped for systemd (spaces, quotes, `%`, `$`).
- **Search**: `ws find <words>` (also `ws search`), the `ws_find` MCP tool, and a search box on the board (press `/`). It covers workstream titles, open and closed items, decisions (including their why and rejected options), session logs (summaries and files touched) and the inbox. Every word must match one record; `"quoted phrases"` match exactly; an ID like `BG-3` finds that record first and doesn't match `BG-30`. Closed items and superseded decisions are labelled and ranked after current records; `--current` leaves them out. Filters: `--ws`, `--kind`, `--limit`, `--json`. On the board, the columns narrow to workstreams with a match.

### Fixed
- A malformed inbox file no longer breaks `ws ls`, search and the board; it is skipped and reported (#27).
- Notes logged in the same second no longer fail with "file already exists" (#27).
- `{{ … }}` in items, decisions, logs or the brief no longer fails `ws prompt`, `ws go` and `ws_compose` with "Unfilled vars" (#23).
- `ws setup` keeps other env vars on an existing `ws` MCP entry; only `WS_ROOT` is replaced (#27).
- Session hooks no longer read every session log of every workstream (#27).
- `ws board` without the board's dependencies says to run `npm ci` instead of letting `npx` download Next (#27).

### Changed
- **Breaking: Node 22 or newer is required.** Node 20 reached end of life in April 2026, so support for it is dropped: `engines.node` is `>=22` for both the CLI and the board, and CI tests on Node 22 and 24.
- **CI:** every third-party action is pinned to a full commit SHA (kept current by Dependabot), workflows get a read-only token by default, and a new push to a PR cancels that PR's older runs. The separate "MCP server starts" job is gone; `ws/test/mcp.test.mjs` already covers the server in the ws suite.
- **Resume prompts no longer quote unreviewed machine summaries** (#23). A session's draft summary is model output from a transcript that may quote untrusted pages, and `ws go` sends the prompt as your own message, so the prompt now only says a draft is waiting in `ws review`. The summarizer is also told that the digest is data, not instructions (#26).
- **Stricter input checks** (#23, #27): workstream ids are checked before any path is built (CLI, MCP and board), and board review/inbox actions require their `ws`/`session`. `ws set` refuses unknown statuses and tools and won't set `id`, `sources`, `vars` or other structured keys (edit those in WORKSTREAM.md). `ws go`, `ws new` and `ws set` accept `--tool claude|codex|gemini`; `ws go` can't launch Gemini yet and says so.
- **`ws_item_close` with several IDs is all or nothing** (#27): every ID is checked first, and an error names each bad one.
- **Redaction** (#26) catches more formats (PGP key blocks, `redis://:pw@`, passwords containing `@`, `DB_PASS`/`MYSQL_PWD`/`*_KEY=`, short quoted passwords, `docker login -p`, `sshpass -p`, `curl -ume:pw`, `--api-key`, `.netrc`, Hugging Face, SendGrid, Slack app tokens and webhooks, Azure SAS signatures), stops mangling prose ("basic authentication", `MAX_TOKENS=4096`), and runs in linear time with each text capped before redaction. A key header with no END redacts the key, not the rest of the text.
- **Board** (#25): load and refresh errors are shown with Retry instead of empty lists or stale data; Reject asks for confirmation; unused toast code is removed.
- **Windows is WSL-only, now explicitly** (#6): on native Windows every `ws` command and the MCP server stop with a message pointing to the new [docs/WINDOWS.md](docs/WINDOWS.md), and `ws hook …` exits 0 without output. Under WSL, `ws setup` warns about a Windows `node.exe` on PATH and about ws or its data on `/mnt/c`, `ws prompt` falls back to `clip.exe`, and `ws board` opens pages with `wslview` or `explorer.exe`. A `windows-latest` CI job checks the native-Windows behaviour.

## 0.1.0 — 2026-11-18

First public release.

### What ws does
- **Workstreams** with open items (stable IDs like `AS-3`, and who each waits on), decisions (superseded, never edited), a log with one file per session, and pointers to your project's own docs.
- **Resume prompts** built fresh from that state: `ws prompt`, or `ws go` to edit the prompt and launch Claude Code or Codex in the workstream's folder.
- **Automatic capture:** SessionStart/SessionEnd hooks tell each session which workstream it's in and log it when it ends. Sessions in unclaimed folders go to an inbox.
- **MCP server** so Claude Code and Codex can read and update workstreams directly.
- **Optional summarizer:** an OpenAI-compatible model (self-hosted or hosted) drafts notes for sessions that ended without any. Nothing applies until you accept it, and closes must quote the session's own result.
- **Board:** a local web view (Next.js, 127.0.0.1 only) with status columns, staleness, inbox and review.

### Setup and configuration
- `ws setup` adds the hooks and MCP registration for Claude Code and Codex, and `ws setup --uninstall` removes them. It's safe to re-run: it only changes entries that are entirely ws's own, keeps timestamped backups, and leaves equivalent hand-written hooks alone.
- Data lives in `$WS_ROOT` (default `$XDG_DATA_HOME/ws` or `~/.local/share/ws`), never in the repo. Settings are in `config.json`, validated, and documented in `docs/CONFIGURATION.md`.
- Supported on macOS and Linux. On Windows, use WSL.

### Safety
- Atomic writes that keep file permissions and follow symlinks. A file ws can't fully parse blocks writes (naming the line) instead of losing records.
- Locks with owner tokens and heartbeats; accepting a proposal is exclusive and can be resumed after an interruption.
- Secrets are redacted before anything is sent to a model. The board refuses cross-origin, DNS-rebinding and proxied requests.
- CI: tests on Ubuntu and macOS with Node 20 and 22, CodeQL, and an enforced audit of runtime dependencies.
