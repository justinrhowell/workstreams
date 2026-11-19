# Testing

## ws (CLI, hooks, summarizer, MCP)

```bash
npm --prefix ws test
```

Uses `node:test`. Each test file points `WS_ROOT` at a fresh temp directory, so real data is never touched. The summarizer tests use a fake OpenAI-compatible server. The MCP test talks to `ws/mcp/server.mjs` over stdio. The setup tests use a fake `HOME`.

Notable suites:

- `state-correctness.test.mjs`: closed items and superseded decisions never show as current in any surface (resume prompts, start notes, mirror block, MCP, summarizer input).
- `capture.test.mjs`: how ended sessions are linked, skipped or sent to the inbox.
- `setup.test.mjs`: `ws setup` merges hooks without disturbing other settings, leaves compound hooks alone, reconciles MCP and the CLI link, uninstalls cleanly, and only ever calls the `claude`/`codex` on the env it's given (stub CLIs in tests).
- `board-service.test.mjs`: the Linux board service: the systemd unit is rendered with correct escaping and 127.0.0.1 binding, and install/uninstall make the right `systemctl --user` calls (a fake runner; the CLI check runs on Linux only, with a stub `systemctl`).
- `platform.test.mjs`: native Windows is refused by the CLI and MCP server while hooks still exit 0 (runs in the Windows CI job), WSL detection, and setup's WSL warnings.
- `hardening.test.mjs`: trash containment, CRLF files, prefix and newline validation, refusing damaged files, concurrent updates, double-accept, secret redaction, config validation, provider errors, verification rules, eval failure accounting, mirror markers.

## Summarizer quality

```bash
ws eval [--runs N] [--case NAME]
```

Scores the summarizer against your own sessions with known correct answers (`$WS_ROOT/eval`). It needs a configured model and your private cases, so it isn't part of CI. Run it before changing the summarizer prompt, the model or the validator.

## Board

```bash
npm test               # Jest, Node environment: route guards for reads and writes
npm run lint && npm run type-check && npm run build
```

The board's API routes are thin wrappers over `ws/lib`, which the ws suite covers. The Jest suite covers the write guards that keep other web pages from posting to the local board.
