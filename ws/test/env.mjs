// Loaded before every test file (`npm test` runs node --import ./test/env.mjs --test), and
// inherited by every process a test starts. Tests must never reach the developer's own
// model endpoint, data or tool homes, whatever their shell exports:
// - the summarizer's env overrides would beat each test's fake endpoint in config.json;
// - CODEX_HOME / CLAUDE_CONFIG_DIR / GEMINI_CLI_HOME point at empty folders, so transcript
//   and title lookups never read real sessions (a test that needs one sets its own);
// - no detached drains are spawned.
import { mkdtempSync } from "node:fs"
import path from "node:path"
import os from "node:os"

for (const k of ["WS_LLM_URL", "WS_LLM_API_KEY", "WS_LLM_MODEL", "WS_ID", "WS_DEBUG", "WS_BOARD_PORT", "WS_BOARD_LABEL", "XDG_DATA_HOME"]) delete process.env[k]
process.env.WS_NO_SPAWN = "1"
const homes = mkdtempSync(path.join(/^(\/private)?\/tmp\/claude-/.test(os.tmpdir()) ? "/tmp" : os.tmpdir(), "ws-test-homes-"))
process.env.CODEX_HOME = path.join(homes, "codex")
process.env.CLAUDE_CONFIG_DIR = path.join(homes, "claude")
process.env.GEMINI_CLI_HOME = path.join(homes, "gemini")
