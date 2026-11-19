// Platform support: native Windows is refused cleanly; WSL is detected and its pitfalls
// are warned about. The Windows-only tests run in CI on windows-latest.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-platform-")
process.env.WS_ROOT = path.join(tmp, "root")
const { platformProblem, isWsl, onWindowsDrive, WINDOWS_PROBLEM } = await import("../lib/platform.mjs")

const WS = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))
const MCP = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))
const win = process.platform === "win32"

test("platformProblem: only native Windows is refused", () => {
  assert.equal(platformProblem("win32"), WINDOWS_PROBLEM)
  assert.match(WINDOWS_PROBLEM, /WSL/)
  for (const p of ["darwin", "linux"]) assert.equal(platformProblem(p), null)
})

test("isWsl: WSL_DISTRO_NAME, WSL_INTEROP or a Microsoft kernel, on Linux only", () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "6.6.0", "linux"), true)
  assert.equal(isWsl({ WSL_INTEROP: "/run/WSL/1_interop" }, "6.6.0", "linux"), true)
  assert.equal(isWsl({}, "5.15.153.1-microsoft-standard-WSL2", "linux"), true)
  assert.equal(isWsl({}, "6.8.0-45-generic", "linux"), false)
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "24.0.0", "darwin"), false)
})

test("onWindowsDrive: /mnt/<letter>/… only", () => {
  assert.equal(onWindowsDrive("/mnt/c/Users/me/ws/bin/ws.mjs"), true)
  assert.equal(onWindowsDrive("/mnt/d"), true)
  assert.equal(onWindowsDrive("/mnt/data/ws"), false)
  assert.equal(onWindowsDrive("/home/me/ws"), false)
  assert.equal(onWindowsDrive(""), false)
})

test("wslWarnings: ws or its data on a Windows drive; nothing outside WSL", { skip: win && "POSIX only" }, async () => {
  const { wslWarnings } = await import("../lib/setup.mjs")
  const env = { PATH: process.env.PATH }
  assert.deepEqual(wslWarnings({ env, wsl: false, bin: "/mnt/c/ws/bin/ws.mjs", root: "/mnt/c/data" }), [])
  const w = wslWarnings({ env, wsl: true, bin: "/mnt/c/ws/bin/ws.mjs", root: "/mnt/c/data" })
  assert.equal(w.length, 2)
  assert.match(w[0], /ws is on a Windows drive/)
  assert.match(w[1], /data folder is on a Windows drive/)
  assert.deepEqual(wslWarnings({ env, wsl: true, bin: "/home/me/ws/bin/ws.mjs", root: "/home/me/.local/share/ws" }), [])
})

test("native Windows: commands exit 1 pointing at WSL; hooks still exit 0; the MCP server refuses", { skip: !win && "Windows only" }, () => {
  const env = { ...process.env, WS_ROOT: process.env.WS_ROOT }
  for (const argv of [["setup", "--dry-run"], ["ls"]]) {
    const r = spawnSync(process.execPath, [WS, ...argv], { env, encoding: "utf-8" })
    assert.equal(r.status, 1, `ws ${argv.join(" ")}`)
    assert.match(r.stderr, /native Windows.*WSL/s)
  }
  const h = spawnSync(process.execPath, [WS, "hook", "claude", "start"], { env, input: "{}", encoding: "utf-8" })
  assert.equal(h.status, 0)
  assert.equal(h.stdout, "", "a refused hook prints nothing a CLI could misread")
  const m = spawnSync(process.execPath, [MCP], { env, input: "", encoding: "utf-8" })
  assert.equal(m.status, 1)
  assert.match(m.stderr, /WSL/)
})
