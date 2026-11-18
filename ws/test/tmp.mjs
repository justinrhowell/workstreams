// Temp folders for tests. ws deliberately ignores paths inside Claude Code scratch folders
// (/private/tmp/claude-*), so tests run from such a session use /tmp instead.
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

export function mkTmp(prefix) {
  const base = /^(\/private)?\/tmp\/claude-/.test(os.tmpdir()) ? "/tmp" : os.tmpdir()
  return fs.mkdtemp(path.join(base, prefix))
}
