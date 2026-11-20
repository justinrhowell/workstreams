// Regression tests for the Nov 2026 end-to-end review: a bad inbox file, notes logged in
// the same second, `ws set` validation, multi-item close, MCP env kept on setup, `ws go`
// with a tool it can't launch, and hooks that don't read every log.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-robust-")
const ROOT = path.join(tmp, "root")
process.env.WS_ROOT = ROOT
process.env.WS_NO_SPAWN = "1"
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const S = await import("../lib/setup.mjs")

const BIN = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))
const ws = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf-8", env: { ...process.env, HOME: tmp, WS_ROOT: ROOT, NO_COLOR: "1" } })

const site = path.join(tmp, "site")
await fs.mkdir(site, { recursive: true })
await store.createWorkstream("site", { title: "Site", cwd: site, prefix: "ST" })

test("one malformed inbox file is skipped and reported, not fatal", async () => {
  await fs.mkdir(path.join(ROOT, "inbox"), { recursive: true })
  await fs.writeFile(path.join(ROOT, "inbox", "2026-11-20_claude_bad.md"), "---\nsession: [unclosed\n---\n")
  await fs.writeFile(path.join(ROOT, "inbox", "2026-11-20_claude_good.md"), "---\nsession: good-1\ntool: claude\n---\n")
  const broken = []
  const rows = await cap.listInbox({ broken })
  assert.deepEqual(rows.map((r) => r.session), ["good-1"])
  assert.equal(broken.length, 1)
  assert.match(broken[0].id, /bad\.md/)
  const r = ws("ls")
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /bad\.md/)
  await fs.rm(path.join(ROOT, "inbox"), { recursive: true })
})

test("notes logged in the same second all land in separate files", async () => {
  const files = await Promise.all(Array.from({ length: 6 }, (_, i) => store.appendLog("site", { summary: `note ${i}` })))
  assert.equal(new Set(files).size, 6)
  const logs = await store.listLogs("site")
  for (let i = 0; i < 6; i++) assert.ok(logs.some((l) => l.summary === `note ${i}`), `note ${i}`)
})

test("ws set refuses unknown statuses, unknown tools and structured keys", async () => {
  for (const [arg, msg] of [["status=actve", /status must be one of/], ["tool=cursor", /tool must be one of/], ["sources=notes.md", /edit it in WORKSTREAM\.md/], ["vars=x", /edit it in WORKSTREAM\.md/], ["id=other", /edit it in WORKSTREAM\.md/]]) {
    const r = ws("set", "site", arg)
    assert.notEqual(r.status, 0, arg)
    assert.match(r.stderr, msg, arg)
  }
  const w = await store.getWorkstream("site")
  assert.equal(w.status, "active")
  assert.equal(ws("set", "site", "status=waiting").status, 0)
  assert.equal((await store.getWorkstream("site")).status, "waiting")
  await store.updateWorkstream("site", { status: "active" })
})

test("closing several items is all or nothing", async () => {
  const a = await store.addItem("site", "first")
  const b = await store.addItem("site", "second")
  await assert.rejects(store.closeItems("site", [a.id, "ST-999"]), /ST-999 not found.*nothing was closed/)
  assert.equal((await store.readOpen("site")).items.find((i) => i.id === a.id).done, false)
  const closed = await store.closeItems("site", [a.id, b.id], { note: "done" })
  assert.deepEqual(closed.map((i) => i.id), [a.id, b.id])
  await assert.rejects(store.closeItem("site", a.id), /already closed/)
})

test("setup keeps other env vars on an existing Gemini ws entry", () => {
  const cur = { mcpServers: { ws: { command: "/old/node", args: ["/old/ws/mcp/server.mjs"], env: { WS_ROOT: "/old", FOO: "1" } } } }
  const pinned = S.mergeGeminiMcp(cur, { root: "/d", pin: true, command: "node" }).settings.mcpServers.ws
  assert.deepEqual(pinned.env, { FOO: "1", WS_ROOT: "/d" })
  const unpinned = S.mergeGeminiMcp(cur, { root: "/d", pin: false, command: "node" }).settings.mcpServers.ws
  assert.deepEqual(unpinned.env, { FOO: "1" })
})

test("ws go launches each tool with its own flags and refuses unknown tools", async () => {
  const { launchArgv } = await import("../lib/compose.mjs")
  assert.deepEqual(launchArgv("claude", "P", { title: "T" }), ["-n", "T", "P"])
  assert.deepEqual(launchArgv("claude", "P", { resumeId: "s1" }), ["--resume", "s1", "P"])
  assert.deepEqual(launchArgv("codex", "P"), ["P"])
  assert.deepEqual(launchArgv("codex", "P", { resumeId: "s1" }), ["resume", "s1", "P"])
  assert.deepEqual(launchArgv("gemini", "P", { title: "T" }), ["-i", "P"])
  assert.deepEqual(launchArgv("gemini", "P", { resumeId: "s1" }), ["--resume", "s1", "-i", "P"])
  assert.throws(() => launchArgv("cursor", "P"), /can't launch cursor/)
  let r = ws("go", "site", "--tool", "cursor")
  assert.match(r.stderr, /--tool must be one of/)
  r = ws("new", "x-tool", "--title", "X", "--cwd", site, "--tool", "cursor")
  assert.match(r.stderr, /--tool must be one of/)
})

test("hooks list workstreams without reading their logs", async () => {
  const list = await store.listWorkstreams({ logs: false })
  const w = list.find((x) => x.id === "site")
  assert.deepEqual(w.logs, [])
  assert.equal(cap.matchWorkstream(list, site).link, "site")
})

test("setup re-adds the Claude/Codex ws server with the user's other env vars", () => {
  const keep = { WS_ROOT: "/old", FOO: "1" }
  const claude = S.mcpAddCommand("claude", "/d", true, process.env, keep)
  assert.deepEqual(claude.filter((a, i) => claude[i - 1] === "-e"), ["FOO=1", "WS_ROOT=/d"])
  const codex = S.mcpAddCommand("codex", "/d", false, process.env, keep)
  assert.deepEqual(codex.filter((a, i) => codex[i - 1] === "--env"), ["FOO=1"])
})

test("ws board without the board's dependencies says to run npm ci", async () => {
  const app = path.dirname(path.dirname(path.dirname(BIN)))
  try { await fs.access(path.join(app, "node_modules", "next", "package.json")); return } catch {} // deps installed: nothing to check
  const r = ws("board", "--dev", "--no-open")
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /npm --prefix .* ci/)
})
