// Where Claude Code and Codex keep their settings and transcripts. Both honour an
// environment override; ws must read and write the same place the tools do.
import path from "node:path"
import os from "node:os"

const home = (env) => env.HOME || os.homedir()

export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home(env), ".claude")
}

export function codexDir(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home(env), ".codex")
}
