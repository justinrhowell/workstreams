// The board's background service on Linux: a systemd user unit (`systemctl --user`).
// macOS uses launchd (in bin/ws.mjs). Rendering is pure and every systemctl call goes
// through an injected runner, so tests never need systemd.
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

export const unitDir = (env = process.env) =>
  path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(env.HOME || os.homedir(), ".config"), "systemd", "user")

export const unitName = (label) => `${label}.service`

// systemd expands %-specifiers everywhere and $VAR in ExecStart, so both are escaped.
// Values are double-quoted, with C-style escapes for \ and ".
const pct = (s) => String(s).replace(/%/g, "%%")
const quoted = (s) => `"${pct(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const execArg = (s) => quoted(s).replace(/\$/g, "$$$$")
const noNewline = (s) => {
  if (/[\n\r]/.test(String(s))) throw new Error(`a path with a line break can't go in a systemd unit: ${JSON.stringify(s)}`)
  return s
}

// { node, app, port, root, path } -> unit file text. Binds to 127.0.0.1 only.
export function renderUnit({ node, app, port, root, pathEnv, dist = ".next-prod" }) {
  for (const v of [node, app, root, pathEnv]) noNewline(v)
  if (!/^\d+$/.test(String(port))) throw new Error(`bad port: ${port}`)
  const next = path.join(app, "node_modules", "next", "dist", "bin", "next")
  const env = { NEXT_DIST_DIR: dist, NODE_ENV: "production", PATH: pathEnv, WS_ROOT: root }
  return [
    "[Unit]",
    `Description=ws board (http://127.0.0.1:${port})`,
    "",
    "[Service]",
    "Type=simple",
    // WorkingDirectory takes the rest of the line as the path (no quote parsing).
    `WorkingDirectory=${pct(app)}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}`),
    `ExecStart=${[node, next, "start", "-H", "127.0.0.1", "-p", String(port)].map(execArg).join(" ")}`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

const defaultRun = (args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf-8" })

// The commands `ws board` needs, for one unit. `run(args)` returns spawnSync-like results.
export function systemdService({ label, env = process.env, run = defaultRun }) {
  const name = unitName(label)
  const file = path.join(unitDir(env), name)
  const ok = (args) => {
    const r = run(args)
    if (r.error || r.status !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${(r.stderr || r.error?.message || r.status || "").toString().trim()}`)
    return r
  }
  return {
    name, file,
    log: `journalctl --user -u ${name}`,
    available() {
      const r = run(["--version"])
      return !r.error && r.status === 0
    },
    async installed() { return fs.access(file).then(() => true, () => false) },
    async install(text) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
      ok(["daemon-reload"])
      ok(["enable", name])
      // restart, not start: picks up a changed unit or a rebuilt app if it was running.
      ok(["restart", name])
    },
    async uninstall() {
      run(["disable", "--now", name]) // fine if it was already stopped or disabled
      await fs.rm(file, { force: true })
      ok(["daemon-reload"])
    },
    restart() { ok(["restart", name]) },
    start() { ok(["start", name]) },
    pid() {
      const r = run(["show", "-p", "MainPID", "--value", name])
      const pid = Number(String(r.stdout || "").trim())
      return r.status === 0 && pid > 0 ? pid : null
    },
  }
}
