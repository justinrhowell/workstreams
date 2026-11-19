// The Linux board service: unit rendering and the systemctl calls. No systemd needed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTmp } from "./tmp.mjs"
import { renderUnit, systemdService, unitDir } from "../lib/board-service.mjs"

const tmp = await mkTmp("ws-board-svc-")
const BASE = { node: "/usr/bin/node", app: "/opt/ws", port: "3311", root: "/home/u/.local/share/ws", pathEnv: "/home/u/.local/bin:/usr/bin:/bin" }

// Parse a unit the way systemd would for the keys we use: Environment="K=V" and quoted ExecStart words.
function unquoteWords(line) {
  const words = []
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    words.push((m[1] ?? m[2]).replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$"))
  }
  return words
}
const field = (unit, key) => unit.split("\n").filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1))

test("renderUnit: 127.0.0.1 only, port from config, production build in .next-prod, WS_ROOT pinned", () => {
  const unit = renderUnit(BASE)
  const exec = unquoteWords(field(unit, "ExecStart")[0])
  assert.deepEqual(exec, ["/usr/bin/node", "/opt/ws/node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "3311"])
  const env = Object.fromEntries(field(unit, "Environment").map((l) => unquoteWords(l)[0].split(/=(.*)/s).slice(0, 2)))
  assert.deepEqual(env, { NEXT_DIST_DIR: ".next-prod", NODE_ENV: "production", PATH: BASE.pathEnv, WS_ROOT: BASE.root })
  assert.deepEqual(field(unit, "WorkingDirectory"), ["/opt/ws"])
  assert.deepEqual(field(unit, "Restart"), ["always"])
  assert.deepEqual(field(unit, "WantedBy"), ["default.target"])
  assert.ok(!/0\.0\.0\.0/.test(unit))
})

test("renderUnit escapes spaces, quotes, backslashes, % specifiers and $ for systemd", () => {
  const odd = { ...BASE, app: "/home/u/My Apps/ws 100%", root: '/data/"ws" $HOME\\x', node: "/opt/n o$de/node" }
  const unit = renderUnit(odd)
  assert.deepEqual(field(unit, "WorkingDirectory"), ["/home/u/My Apps/ws 100%%"])
  const exec = unquoteWords(field(unit, "ExecStart")[0])
  assert.equal(exec[0], "/opt/n o$de/node")
  assert.equal(exec[1], "/home/u/My Apps/ws 100%/node_modules/next/dist/bin/next")
  assert.ok(field(unit, "ExecStart")[0].includes("o$$de"), "$ is doubled in ExecStart")
  const root = field(unit, "Environment").map((l) => unquoteWords(l)[0]).find((v) => v.startsWith("WS_ROOT="))
  assert.equal(root, `WS_ROOT=${odd.root}`)
})

test("renderUnit refuses line breaks and bad ports", () => {
  assert.throws(() => renderUnit({ ...BASE, root: "/a\n[Service]\nExecStart=/bin/evil" }), /line break/)
  assert.throws(() => renderUnit({ ...BASE, port: "80; rm" }), /bad port/)
})

test("unitDir: XDG_CONFIG_HOME (absolute) or ~/.config", () => {
  assert.equal(unitDir({ HOME: "/h" }), "/h/.config/systemd/user")
  assert.equal(unitDir({ HOME: "/h", XDG_CONFIG_HOME: "/cfg" }), "/cfg/systemd/user")
  assert.equal(unitDir({ HOME: "/h", XDG_CONFIG_HOME: "rel" }), "/h/.config/systemd/user")
})

function fakeRun({ fail = [] } = {}) {
  const calls = []
  const run = (args) => {
    calls.push(args.join(" "))
    if (fail.some((f) => args.join(" ").startsWith(f))) return { status: 1, stderr: "boom" }
    if (args[0] === "show") return { status: 0, stdout: "4242\n" }
    return { status: 0, stdout: "" }
  }
  return { run, calls }
}

test("systemdService: install writes the unit, reloads, enables and (re)starts; uninstall reverses it", async () => {
  const env = { HOME: path.join(tmp, "home") }
  const { run, calls } = fakeRun()
  const svc = systemdService({ label: "ws.board", env, run })
  assert.equal(svc.file, path.join(env.HOME, ".config", "systemd", "user", "ws.board.service"))
  assert.equal(await svc.installed(), false)
  await svc.install(renderUnit(BASE))
  assert.equal(await svc.installed(), true)
  assert.match(await fs.readFile(svc.file, "utf-8"), /^ExecStart=/m)
  assert.deepEqual(calls, ["daemon-reload", "enable ws.board.service", "restart ws.board.service"])
  assert.equal(svc.pid(), 4242)
  svc.restart()
  await svc.uninstall()
  assert.equal(await svc.installed(), false)
  assert.deepEqual(calls.slice(3), ["show -p MainPID --value ws.board.service", "restart ws.board.service", "disable --now ws.board.service", "daemon-reload"])
  assert.equal(svc.log, "journalctl --user -u ws.board.service")
})

test("systemdService: a failing systemctl step is an error naming the command", async () => {
  const env = { HOME: path.join(tmp, "home-fail") }
  const svc = systemdService({ label: "ws.board", env, run: fakeRun({ fail: ["enable"] }).run })
  await assert.rejects(svc.install(renderUnit(BASE)), /systemctl --user enable ws\.board\.service failed: boom/)
})

test("ws board --uninstall/--status on Linux use systemctl --user from PATH", { skip: process.platform !== "linux" && "Linux only" }, async () => {
  const home = path.join(tmp, "home-cli")
  const bin = path.join(tmp, "stub-bin")
  const log = path.join(tmp, "systemctl-calls.txt")
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *"show -p MainPID"*) echo 99;; esac\nexit 0\n`, { mode: 0o755 })
  const unitFile = path.join(home, ".config", "systemd", "user", "ws.board.service")
  await fs.mkdir(path.dirname(unitFile), { recursive: true })
  await fs.writeFile(unitFile, renderUnit(BASE))
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, WS_ROOT: path.join(tmp, "root"), WS_BOARD_PORT: "39999", WS_BOARD_LABEL: "ws.board" }
  const ws = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))
  const st = spawnSync(process.execPath, [ws, "board", "--status"], { env, encoding: "utf-8" })
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /service: installed .*\(pid 99\)/)
  assert.match(st.stdout, /logs: journalctl --user -u ws\.board\.service/)
  const un = spawnSync(process.execPath, [ws, "board", "--uninstall"], { env, encoding: "utf-8" })
  assert.equal(un.status, 0, un.stderr)
  await assert.rejects(fs.access(unitFile))
  assert.match(await fs.readFile(log, "utf-8"), /^--user disable --now ws\.board\.service$/m)
})
