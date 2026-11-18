# Testing

## ws (CLI, hooks, summarizer, MCP)

```bash
npm --prefix ws test
```

Uses `node:test`. Each test file points `WS_ROOT` at a fresh temp directory, so real data is never touched. The summarizer tests use a fake OpenAI-compatible server. The MCP test talks to `ws/mcp/server.mjs` over stdio. The setup tests use a fake `HOME`.

Notable suites:

- `state-correctness.test.mjs`: closed items and superseded decisions never show as current in any surface (resume prompts, start notes, mirror block, MCP, summarizer input).
- `capture.test.mjs`: how ended sessions are linked, skipped or sent to the inbox.
- `setup.test.mjs`: `ws setup` merges hooks without disturbing other settings, and a second run changes nothing.

## Summarizer quality

```bash
ws eval [--runs N] [--case NAME]
```

Scores the summarizer against your own sessions with known correct answers (`$WS_ROOT/eval`). It needs a configured model and your private cases, so it isn't part of CI. Run it before changing the summarizer prompt, the model or the validator.

## Board

```bash
npm test               # Jest, Node environment: route guards
npm run lint && npm run type-check && npm run build
```

The board's API routes are thin wrappers over `ws/lib`, which the ws suite covers. The Jest suite covers the write guards that keep other web pages from posting to the local board.
