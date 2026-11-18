# Architecture

`ws` keeps the state of long-running work (a **workstream**) that spans many Claude Code and Codex sessions. From that state it builds a fresh resume prompt whenever a session starts.

## Each fact has one owner

The same "what's still open" list tends to drift across memory notes, status docs and pasted prompts. `ws` gives each kind of fact exactly one owner; everything else links to it or shows a generated copy.

| Fact | Owner |
|---|---|
| Open items (what's left, who it's waiting on) | `open.md` in the workstream, with stable IDs |
| Decisions (what was settled, why, what was rejected) | `decisions.md`, IDs like `AB-D2`, superseded rather than edited |
| What each session did | `log/`, one file per session, append-only |
| How this kind of work is done | `procedures/*.md`, with `{{vars}}` |
| Narrative and decisions | The project's own status doc, which ws points to |
| Rules about people and process | Claude memory notes, which ws points to (and inlines for Codex) |

## Storage

```
$WS_ROOT (default $XDG_DATA_HOME/ws or ~/.local/share/ws; never inside this repo)
├── ws/<id>/WORKSTREAM.md   frontmatter: title, status, waiting_on, cwd, sources, procedure, vars, input
├── ws/<id>/open.md         "- [ ] AB-3 text @waiting:Name"; written only through ws/lib, under a lock
├── ws/<id>/decisions.md    "- [active] AB-D2 text (date)" + why / rejected / evidence; superseded, never edited
├── ws/<id>/log/*.md        one per session: session id, tool, times, files touched, summary
├── eval/                   private summarizer eval: cases, transcript copies, floors, reports
├── .trash/<id>__<time>/    deleted workstreams with their drafts and queued jobs; `ws trash restore`
├── procedures/*.md
├── inbox/                  sessions that ended outside any workstream
├── queue/, proposals/      summarizer work and its drafts
├── config.json             optional settings: summarizer model, board port (docs/CONFIGURATION.md)
└── ignore.txt              folders whose unclaimed sessions are dropped
```

## Components

```mermaid
graph LR
  CLI[ws CLI] --> LIB[ws/lib]
  HOOKS[SessionStart / SessionEnd hooks<br/>Claude Code + Codex] --> LIB
  MCP[ws MCP server] --> LIB
  BOARD[Board: Next app, 127.0.0.1] --> LIB
  LIB --> FS[(WS_ROOT markdown)]
  LIB -. detached drain .-> LLM[OpenAI-compatible model<br/>local or hosted, optional]
```

All writers go through `ws/lib`. That way item IDs are allocated once, the `open.md` lock is always taken, and the opt-in mirror block stays in sync.

- **`store.mjs`** handles workstreams, open items (lock, IDs that are never reused), logs, the mirror block, and staleness. Staleness counts from the newest session end, not from file edits.
- **`compose.mjs`** builds the resume prompt: read-first sources, the input slot, the procedure, open items, the last real session summary, and recent sessions without notes. It inlines Claude memory notes when the target is Codex, and fails loudly when a path or section doesn't resolve.
- **`capture.mjs`** runs from the hooks.
  - **Matching:** a session links to a workstream when `WS_ID` is set, or when exactly one active workstream has the longest matching cwd prefix. Everything else goes to the inbox, with ranked suggestions.
  - **Filtering:** tiny sessions (one prompt, few tool calls, no edits, no ws calls) are skipped. A `ws log` written during the session is adopted rather than duplicated.
  - **Start note:** returned as `hookSpecificOutput.additionalContext`, and it defers to the user.
- **`summarize.mjs`** drafts proposals for sessions that ended without notes. The hook only enqueues; a detached `ws summarize --drain` does the work.
  - **Model input:** a digest of the session (prompts, assistant text, tool names; no tool output), sent in JSON mode. Server-specific fields (for example turning thinking off on vLLM) come from `llm.extraBody` in config. The reply must finish with `stop`.
  - **Validation:** a close must quote the session verbatim, must not copy the item text, and must share words with the item. Closes that fail become *unverified* suggestions, off by default. New items that restate open ones are dropped.
  - **Failures:** endpoint outages never use up a job's attempts.
  - **Review:** proposals apply only through `ws review accept` or the board. Accepting never overwrites notes someone wrote.

## Quality gates

- **State correctness** (`ws/test/state-correctness.test.mjs`): once an item is closed or a decision superseded, it must not appear as current in any surface. That covers the resume prompt (Claude, Codex, inline), the session-start note, the mirror block, the MCP `ws_show` and `ws_compose`, and the summarizer's input. The test was checked by deliberately breaking the filters.
- **Summarizer eval** (`ws eval`): scores proposals on your own real sessions with known correct closes, kept in `$WS_ROOT/eval` (your data, never in this repo), and fails below the floors (defaults: verified precision 100%, recall 50%, no false verified closes; override them in `eval/floors.json`). Run it before changing the prompt, model or validator. The case format is documented at the top of `ws/lib/eval.mjs`.

## Recall

- `ws go <id>` opens the composed prompt in `$EDITOR` with the cursor on the input slot. On save it launches `claude -n "<title>"` or `codex` in the workstream's cwd with `WS_ID` set. `--resume` reuses a session from the last 12 hours.
- `ws prompt <id>` copies the prompt for desktop or web apps.
- The MCP tools (`ws_show`, `ws_compose`, `ws_item_*`, `ws_log`, …) give both CLIs a native way to read and write.
- A "park" or handoff skill in your agent setup can call the same MCP tools to record what a session changed before you switch away.

## Board

The board is the Next app at `/`. Its API routes import `ws/lib` directly.

- **Network:** it binds to `127.0.0.1`. Writes need JSON, a local `Host` and a same-origin `Origin`, so other sites can't post to it and DNS rebinding is blocked.

## Platforms

- **macOS:** everything, including `ws board --install` (a launchd agent).
- **Linux:** everything except the background board service; run `ws board` in a terminal instead. Clipboard copy uses `wl-copy`, `xclip` or `xsel`.
- **Windows:** untested. WSL should behave like Linux.

## History

`ws` grew out of GoPrompt, a markdown prompt library. The prompt library was removed when ws was published; only the board's Next.js shell remains from it.
