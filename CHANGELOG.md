# Changelog

All notable changes to ws. Versions follow [semantic versioning](https://semver.org); until 1.0, minor versions may change behaviour.

## Unreleased

### Added
- **Gemini CLI support** (#5): `ws hook gemini start|end`, a reader for Gemini's session files (the current append-only `.jsonl` log and the older single-object `.json`), summarizer digests, and `ws setup --gemini`, which writes the hooks (millisecond timeouts) and the `ws` MCP server into `~/.gemini/settings.json` in one write. Honours `GEMINI_CLI_HOME`. When Gemini leaves `transcript_path` empty, the session file is found by its id.
- **Board service on Linux** (#4): `ws board --install / --uninstall / --rebuild / --status` now work on Linux through a systemd user unit (`~/.config/systemd/user/<board.label>.service`). It runs the production build in `.next-prod`, binds to 127.0.0.1 on `board.port`, pins `WS_ROOT`, restarts on failure, and logs to the journal. Paths are escaped for systemd (spaces, quotes, `%`, `$`).

- **Search**: `ws find <words>` (also `ws search`), the `ws_find` MCP tool, and a search box on the board (press `/`). It covers workstream titles, open and closed items, decisions (including their why and rejected options), session logs (summaries and files touched) and the inbox. Every word must match one record; `"quoted phrases"` match exactly; an ID like `BG-3` finds that record first and doesn't match `BG-30`. Closed items and superseded decisions are labelled and ranked after current records; `--current` leaves them out. Filters: `--ws`, `--kind`, `--limit`, `--json`. On the board, the columns narrow to workstreams with a match.

### Changed
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
