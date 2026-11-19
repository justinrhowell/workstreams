// Where Claude Code, Codex and Gemini CLI keep their settings and transcripts. Each honours an
// environment override; ws must read and write the same place the tools do.
import path from "node:path"
import os from "node:os"

const home = (env) => env.HOME || os.homedir()

export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home(env), ".claude")
}

// Gemini CLI treats GEMINI_CLI_HOME as the home folder and keeps .gemini inside it.
export function geminiDir(env = process.env) {
  return path.join(env.GEMINI_CLI_HOME ? path.resolve(env.GEMINI_CLI_HOME) : home(env), ".gemini")
}

export function codexDir(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home(env), ".codex")
}
