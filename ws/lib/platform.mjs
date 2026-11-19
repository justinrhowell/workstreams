// Platform checks. ws runs on macOS and Linux, including Linux under WSL on Windows.
// Native Windows is not supported (POSIX hook commands, the ~/.local/bin symlink and
// "/"-based path checks); every entry point refuses it with this message rather than
// half-working. See docs/WINDOWS.md.
import os from "node:os"

export const WINDOWS_PROBLEM =
  "ws doesn't run on native Windows. Install it inside WSL and run Claude Code, Codex or Gemini CLI there too: see docs/WINDOWS.md in the ws repo."

export const platformProblem = (platform = process.platform) => (platform === "win32" ? WINDOWS_PROBLEM : null)

// Linux under WSL: WSL sets WSL_DISTRO_NAME; the kernel release names Microsoft either way.
export function isWsl(env = process.env, release = os.release(), platform = process.platform) {
  if (platform !== "linux") return false
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft/i.test(release)
}

// A Windows drive mounted into WSL (/mnt/c/...). Files there are slow from Linux, and a
// Windows node.exe found there can't run ws's hooks.
export const onWindowsDrive = (p) => /^\/mnt\/[a-z](\/|$)/i.test(String(p || ""))
