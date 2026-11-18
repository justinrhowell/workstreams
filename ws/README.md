# ws (CLI, hooks, MCP server)

The core of ws. It has no dependency on the board app in the parent folder.

```bash
npm ci
node bin/ws.mjs setup
ws help
```

See the [main README](../README.md), [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## Mirror block (opt-in)

`ws mirror <id> <doc>` adds a generated open-items block to the end of a project doc. After that, every item change rewrites only the text between its markers. The block is skipped if the doc changed in the last 2 minutes, in case a live session is editing it. It catches up on the next item change or session end.
