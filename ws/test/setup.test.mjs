import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-setup-"))
process.env.WS_ROOT = path.join(tmp, "data root")
const store = await import("../lib/store.mjs")
const { mergeHooks, hookCommand, runSetup, settingsFile, BIN } = await import("../lib/setup.mjs")

test("defaultRoot: WS_ROOT, then XDG_DATA_HOME/ws, then ~/.local/share/ws", () => {
  assert.equal(store.defaultRoot({ WS_ROOT: "/x/y" }), "/x/y")
  assert.equal(store.defaultRoot({ XDG_DATA_HOME: "/data" }), "/data/ws")
  assert.equal(store.defaultRoot({ XDG_DATA_HOME: "relative" }), path.join(os.homedir(), ".local", "share", "ws"))
  assert.equal(store.defaultRoot({}), path.join(os.homedir(), ".local", "share", "ws"))
})

test("hookCommand quotes paths with spaces and pins WS_ROOT only for a non-default folder", () => {
  const home = "/home/u"
  const c = hookCommand("claude", "start", { wsPath: "/a b/ws", root: "/home/u/.local/share/ws", home })
  assert.equal(c, `"/a b/ws" hook claude start`)
  const pinned = hookCommand("codex", "end", { wsPath: "/bin/ws", root: "/my data", home })
  assert.equal(pinned, `WS_ROOT="/my data" /bin/ws hook codex end`)
})

test("mergeHooks adds ws entries and keeps everything else", () => {
  const before = {
    model: "x",
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "other-tool start" }] }] },
  }
  const { settings, changes } = mergeHooks(before, "claude", { wsPath: "/bin/ws", root: "/home/u/.local/share/ws", home: "/home/u" })
  assert.deepEqual(changes, ["added SessionStart", "added SessionEnd"])
  assert.equal(settings.model, "x")
  assert.equal(settings.hooks.SessionStart.length, 2)
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "other-tool start")
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, "/bin/ws hook claude end")
  assert.equal(before.hooks.SessionStart.length, 1, "input is not mutated")

  const again = mergeHooks(settings, "claude", { wsPath: "/bin/ws", root: "/home/u/.local/share/ws", home: "/home/u" })
  assert.deepEqual(again.changes, [], "second run is a no-op")
})

test("mergeHooks updates an existing ws hook in place (e.g. a hand-written one)", () => {
  const before = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: `"$HOME/.local/bin/ws" hook codex end`, timeout: 99 }] }] } }
  const { settings, changes } = mergeHooks(before, "codex", { wsPath: "/bin/ws", root: "/home/u/.local/share/ws", home: "/home/u" })
  assert.deepEqual(changes, ["added SessionStart", "updated SessionEnd"])
  assert.equal(settings.hooks.SessionEnd.length, 1)
  assert.deepEqual(settings.hooks.SessionEnd[0].hooks[0], { type: "command", command: "/bin/ws hook codex end", timeout: 3 })
})

test("runSetup creates the data folder, links the CLI and writes hooks under a fake HOME", async () => {
  const home = path.join(tmp, "home")
  await fs.mkdir(path.join(home, ".claude"), { recursive: true })
  await fs.writeFile(settingsFile("claude", home), JSON.stringify({ theme: "dark" }))
  const lines = []
  const env = { PATH: "/usr/bin", WS_ROOT: process.env.WS_ROOT }
  await runSetup({ tools: ["claude", "codex"], mcp: false, home, env, log: (s) => lines.push(s) })

  await fs.access(path.join(store.ROOT, "ws"))
  const link = path.join(home, ".local", "bin", "ws")
  assert.equal(await fs.realpath(link), await fs.realpath(BIN))
  assert.ok(lines.some((l) => l.includes("not on your PATH")))

  const claude = JSON.parse(await fs.readFile(settingsFile("claude", home), "utf-8"))
  assert.equal(claude.theme, "dark")
  assert.match(claude.hooks.SessionStart[0].hooks[0].command, /^WS_ROOT=".*data root" .*\/\.local\/bin\/ws hook claude start$/)
  await fs.access(settingsFile("claude", home) + ".bak-ws")
  const codex = JSON.parse(await fs.readFile(settingsFile("codex", home), "utf-8"))
  assert.match(codex.hooks.SessionEnd[0].hooks[0].command, /hook codex end$/)

  // Second run changes nothing.
  const again = []
  await runSetup({ tools: ["claude", "codex"], mcp: false, home, env, log: (s) => again.push(s) })
  assert.ok(again.some((l) => l.startsWith("claude hooks: up to date")))
  assert.ok(again.some((l) => l.startsWith("codex hooks: up to date")))
})

test("runSetup --dry-run writes nothing", async () => {
  const home = path.join(tmp, "home-dry")
  await runSetup({ tools: ["claude"], mcp: false, dryRun: true, home, env: { PATH: "" }, log: () => {} })
  await assert.rejects(fs.access(path.join(home, ".claude", "settings.json")))
  await assert.rejects(fs.access(path.join(home, ".local", "bin", "ws")))
})

test("a malformed config.json never breaks hooks or the CLI", async () => {
  const { spawnSync } = await import("node:child_process")
  const root = path.join(tmp, "bad-config")
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "config.json"), "{ not json")
  const env = { ...process.env, WS_ROOT: root, WS_NO_SPAWN: "1" }
  const hook = spawnSync(process.execPath, [BIN, "hook", "claude", "start"], { input: "{}", env, encoding: "utf-8" })
  assert.equal(hook.status, 0, hook.stderr)
  const ls = spawnSync(process.execPath, [BIN, "ls"], { env, encoding: "utf-8" })
  assert.equal(ls.status, 0, ls.stderr)
})
