# Configuration

Everything that is yours (workstreams, logs, settings, eval cases) lives in the data folder, `$WS_ROOT`. The repo holds only code. You can delete and re-clone the repo without losing anything.

## Data folder

| | |
|---|---|
| Default | `$XDG_DATA_HOME/ws` if `XDG_DATA_HOME` is set, else `~/.local/share/ws` |
| Override | `WS_ROOT=/absolute/path` (a relative path is refused: hooks run in each project's folder, so it would mean a different folder every time) |

Hooks and the MCP server don't read your shell profile. If you set `WS_ROOT`, run `ws setup` with it set, and setup will pin it into the hook commands and MCP registrations. The background board service always pins the folder it was installed with. Another option is to leave `WS_ROOT` unset and symlink `~/.local/share/ws` to the folder you want.

To keep the data in a synced or backed-up folder, point `WS_ROOT` there or symlink it. Two machines writing the same folder at the same moment is not supported: item IDs are allocated under a local lock.

## config.json

`$WS_ROOT/config.json` is optional. Every key is optional.

```json
{
  "llm": {
    "url": "http://127.0.0.1:8000/v1",
    "model": "my-model",
    "apiKeyEnv": "OPENAI_API_KEY",
    "timeoutMs": 180000,
    "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }
  },
  "board": {
    "port": 3311,
    "label": "ws.board"
  }
}
```

| Key | What it does |
|---|---|
| `llm.url` | Base URL of an OpenAI-compatible API (`…/v1`). Setting it turns the summarizer on. |
| `llm.model` | Model ID. If omitted, ws uses the first model listed at `/models`. |
| `llm.apiKeyEnv` | Name of the environment variable that holds the API key. The key itself never goes in this file. |
| `llm.timeoutMs` | Per-request timeout. Default 180000. |
| `llm.extraBody` | Extra fields merged into each chat-completions request, for server-specific options. The example turns thinking off on vLLM-served Qwen models. `null` removes a default field; `model` and `messages` can't be set. |
| `board.port` | Port for `ws board` and the background service. Default 3311. |
| `board.label` | launchd label for the background service (macOS). Default `ws.board`. Uninstall the service before changing it. |

**Privacy:** for each session that ended without notes, the summarizer sends `llm.url`:

- your prompts and the assistant's replies (clipped),
- each tool call's name and the first 140 characters of its main argument: shell commands, file paths, URLs, search patterns,
- the workstream's title, open items and active decisions.

Tool output is never sent. Common credential shapes, in the digest and in titles, items and decisions, (API keys, GitHub and Slack tokens, AWS keys, JWTs, `Bearer …`, `password=…`, `user:pass@` in URLs, private keys) are replaced with `[redacted]` before sending. That is a safety net, not a guarantee: a secret in an unusual format can still get through. If `llm.url` points at this machine (`localhost`, `127.0.0.1`), nothing leaves it. A self-hosted model on another machine (a home server, a GPU box on your network) receives the request over the network, so use `https` or a network you trust. A hosted API receives it as its provider's data. Leave `llm.url` unset to keep the summarizer off.

**Validation:** ws checks every value. A wrong type or an unsafe value is ignored, and commands print a one-line `config.json:` note saying what was ignored. A broken file never stops hooks.

**Hosted providers:** set `llm.model` (when `/models` lists more than one model on a non-local host, ws won't guess) and `llm.apiKeyEnv`. A refused key or a wrong URL keeps the job queued and says so (`ws summarize --drain`), instead of spending the job's retries. If your provider wants `max_completion_tokens`, use `"extraBody": {"max_tokens": null, "max_completion_tokens": 1500}`: `null` removes a default field. `extraBody` can't change the model or the messages.

## Environment variables

| Variable | Overrides | Notes |
|---|---|---|
| `WS_ROOT` | data folder | See above |
| `WS_LLM_URL` | `llm.url` | |
| `WS_LLM_MODEL` | `llm.model` | |
| `WS_LLM_API_KEY` | the key named by `llm.apiKeyEnv` | Sent as `Authorization: Bearer …` |
| `WS_BOARD_PORT` | `board.port` | |
| `WS_BOARD_LABEL` | `board.label` | |
| `WS_ID` | folder matching | Set by `ws go`. Forces a session onto that workstream |
| `WS_DEBUG` | | Hooks print what they decided to stderr |
| `WS_NO_SPAWN` | | Hooks don't start the background summarizer (used in tests) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code's settings and transcripts are; `ws setup` writes hooks there |
| `CODEX_HOME` | `~/.codex` | Same for Codex |
| `VISUAL`, `EDITOR` | | Editor for `ws go` (`VISUAL` first, then `EDITOR`, then `nano`); run through `sh`, so arguments and quoted paths work |

The summarizer runs as a detached process started by the hooks, so its API key variable must be visible to Claude Code or Codex, not just to your terminal.

## Other files in the data folder

| File | What it does |
|---|---|
| `ignore.txt` | One folder per line. Sessions there that no workstream claims are dropped instead of going to the inbox. `ws inbox ignore <n> --cwd` adds to it |
| `procedures/<name>.md` | Reusable instructions for a kind of work, with `{{vars}}`. Name one in a workstream's `procedure:` |
| `eval/cases/*.json`, `eval/floors.json` | Your summarizer eval cases and pass floors (format at the top of `ws/lib/eval.mjs`) |
| `hook-errors.log` | Hooks never fail a session. If one hits an error, it lands here |

## A workstream's settings

`ws new` writes `ws/<id>/WORKSTREAM.md`. Edit its frontmatter to point at your project's docs:

```yaml
---
id: site
title: Acme site rebuild
status: active            # active | waiting | parked | done (archive with `ws archive`)
waiting_on: "client: copy for the pricing page"
cwd: ~/code/acme-site     # sessions under this folder are linked to this workstream
tool: claude              # default for `ws go`: claude | codex
group: clients            # optional, for grouping on the board
prefix: AS                # item IDs: AS-1, AS-2, decisions AS-D1
procedure: site-qa        # optional: procedures/site-qa.md
vars: { env: staging }    # values for {{vars}} in the procedure and input
input: "Goal for this session:"
sources:                  # read-first docs for the resume prompt
  - path: ~/code/acme-site/STATUS.md
    section: "Feedback"   # optional: only the latest heading containing this text
  - path: ~/.claude/projects/<slug>/memory/client-rules.md
    role: memory          # Claude memory note: inlined for Codex, linked for Claude
---
```

`ws doctor <id>` checks that every path and section resolves. `ws prompt` refuses to build a prompt from a broken pointer rather than silently drop it.

## Uninstalling

```bash
ws board --uninstall            # first, on macOS, if you installed the background service
ws setup --uninstall            # then this (add --dry-run to preview); it removes the ws command
```

This removes ws's own hook entries (custom hooks are kept), the `ws` MCP registrations, and the `~/.local/bin/ws` link. Each settings file it changes is backed up first. Your data folder is left alone; delete it yourself if you want it gone.

## Setting up hooks by hand

`ws setup` does this for you. To do it yourself, add these entries.

Claude Code, in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "ws hook claude start", "timeout": 10 }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "ws hook claude end", "timeout": 20 }] }]
  }
}
```

Codex, in `~/.codex/hooks.json`: the same shape, with `ws hook codex start` (timeout 10) and `ws hook codex end` (timeout 3). Approve them once with `/hooks` in Codex.

Use an absolute path to `ws` if `~/.local/bin` isn't on the PATH those tools see.

MCP server:

```bash
claude mcp add --scope user ws -- node /path/to/workstreams/ws/mcp/server.mjs
codex mcp add ws -- node /path/to/workstreams/ws/mcp/server.mjs
```
