// Regression tests for the 2026-11 code review, part 2: parallel sessions adopting each
// other's notes, a dead hook's lock outlasting the hook timeouts, and one summarizer job
// starving the queue.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-review2-")
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const sum = await import("../lib/summarize.mjs")

const BIN = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))
const site = path.join(tmp, "site")
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"

// A small interactive Claude transcript; `tools` are extra tool_use blocks.
async function transcript(name, tools = []) {
  const file = path.join(tmp, `${name}.jsonl`)
  await fs.writeFile(file, jl(
    { type: "ai-title", aiTitle: name },
    { type: "user", timestamp: at(120_000), message: { content: "prompt 0" } },
    { type: "assistant", timestamp: at(90_000), message: { content: tools.map((input) => ({ type: "tool_use", ...input })) } },
    { type: "user", timestamp: at(60_000), message: { content: "prompt 1" } },
  ))
  return file
}
const end = async (session, file) => cap.captureSession({ tool: "claude", session_id: session, transcript_path: file, cwd: site })
const logsOf = async (id) => (await store.getWorkstream(id)).logs

let server, mode = "ok", calls = []
before(async () => {
  await fs.mkdir(site, { recursive: true })
  server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m" }] }))
      const user = JSON.parse(body).messages[1].content
      calls.push(user.includes("SLOW") ? "slow" : "fast")
      if (user.includes("SLOW")) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: "context too long" } })) }
      if (mode === "429") { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: "slow down" } })) }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Did it.", close: [], add: [] }) }, finish_reason: "stop" }] }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
})
after(() => server.close())

test("a session doesn't adopt notes another agent session wrote", async () => {
  await store.createWorkstream("par", { title: "Par", cwd: site })
  // Session B ran `ws log` through its shell tool; A did nothing with ws and ends first.
  await store.appendLog("par", { summary: "B shipped the footer.", via: "agent" })
  const a = await end("aaaa-par", await transcript("a"))
  assert.equal(a.action, "linked")
  assert.equal(a.notes, false) // A gets its own stub (and a summary draft), not B's notes
  const b = await end("bbbb-par", await transcript("b", [{ name: "Bash", input: { command: `ws log par "B shipped the footer."` } }]))
  assert.equal(b.action, "adopted")
  const mine = (await logsOf("par")).find((l) => l.session === "bbbb-par")
  assert.equal(mine.summary, "B shipped the footer.")
  await store.updateWorkstream("par", { status: "done" })
})

test("a session takes its own note even when another agent's note is older", async () => {
  await store.createWorkstream("own", { title: "Own", cwd: site })
  await store.appendLog("own", { summary: "Other session: cleaned the CSS.", via: "agent" })
  await new Promise((r) => setTimeout(r, 1100)) // manual log names are per second
  await store.appendLog("own", { summary: "Mine: wrote the launch email.", via: "agent" })
  const r = await end("cccc-own", await transcript("c", [{ name: "mcp__ws__ws_log", input: { id: "own", summary: "Mine: wrote the launch email." } }]))
  assert.equal(r.action, "adopted")
  const logs = await logsOf("own")
  assert.equal(logs.find((l) => l.session === "cccc-own").summary, "Mine: wrote the launch email.")
  assert.ok(logs.some((l) => !l.session && l.summary === "Other session: cleaned the CSS."))
  await store.updateWorkstream("own", { status: "done" })
})

test("a note typed in a terminal is still adopted by the session that ends", async () => {
  await store.createWorkstream("term", { title: "Term", cwd: site })
  await store.appendLog("term", { summary: "Typed it myself.", via: "terminal" })
  const r = await end("dddd-term", await transcript("d"))
  assert.equal(r.action, "adopted")
  await store.updateWorkstream("term", { status: "done" })
})

test("ws log records whether an agent's shell ran it", async () => {
  await store.createWorkstream("via", { title: "Via", cwd: site })
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE" && !k.startsWith("CODEX_")))
  spawnSync(process.execPath, [BIN, "log", "via", "from a terminal"], { env: clean })
  spawnSync(process.execPath, [BIN, "log", "via", "from claude"], { env: { ...clean, CLAUDECODE: "1" } })
  await new Promise((r) => setTimeout(r, 1100))
  spawnSync(process.execPath, [BIN, "log", "via", "from codex"], { env: { ...clean, CODEX_SANDBOX: "seatbelt" } })
  const via = Object.fromEntries((await logsOf("via")).map((l) => [l.summary, l.via]))
  assert.deepEqual(via, { "from a terminal": "terminal", "from claude": "agent", "from codex": "agent" })
  await store.updateWorkstream("via", { status: "done" })
})

test("a lock whose owner process died is taken over at once", async () => {
  const child = spawn(process.execPath, ["-e", ""])
  await new Promise((r) => child.on("exit", r))
  const file = path.join(tmp, "dead-target")
  await fs.mkdir(file + ".lock")
  await fs.writeFile(path.join(file + ".lock", "owner"), `${os.hostname()}/${child.pid} x`)
  const t0 = Date.now()
  assert.equal(await store.withLock(file, async () => "got it"), "got it")
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`)
})

test("a lock held by a live process (or another host) is still waited for", async () => {
  for (const owner of [`${os.hostname()}/${process.pid} x`, `other-host/999999 x`]) {
    const file = path.join(tmp, `live-target-${owner.length}`)
    await fs.mkdir(file + ".lock")
    await fs.writeFile(path.join(file + ".lock", "owner"), owner)
    let got = false
    const p = store.withLock(file, async () => { got = true })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(got, false, owner)
    await fs.rm(file + ".lock", { recursive: true })
    await p
    assert.equal(got, true)
  }
})

test("a job that keeps failing doesn't starve the jobs behind it", async () => {
  await fs.mkdir(store.ROOT, { recursive: true })
  await fs.writeFile(path.join(store.ROOT, "config.json"), JSON.stringify({ llm: { url: `http://127.0.0.1:${server.address().port}/v1`, model: "m" } }))
  await store.createWorkstream("q", { title: "Q", cwd: site })
  const slow = path.join(tmp, "slow.jsonl"), fast = path.join(tmp, "fast.jsonl")
  await fs.writeFile(slow, jl({ type: "user", timestamp: at(1000), message: { content: "SLOW " + "x".repeat(300) } }))
  await fs.writeFile(fast, jl({ type: "user", timestamp: at(1000), message: { content: "quick one " + "y".repeat(300) } }))
  // "a…" sorts first, so the failing job is always tried first.
  await sum.enqueue({ ws: "q", session: "aaaa-slow", tool: "claude", transcript: slow, log: await store.appendLog("q", { summary: "(auto)", session: "aaaa-slow", source: "hook" }) })
  await sum.enqueue({ ws: "q", session: "bbbb-fast", tool: "claude", transcript: fast, log: await store.appendLog("q", { summary: "(auto)", session: "bbbb-fast", source: "hook" }) })

  const r = await sum.drain()
  assert.deepEqual(calls, ["slow", "fast"], JSON.stringify(r))
  assert.equal((await sum.listProposals("q")).length, 1)
  const [job] = await sum.listQueue()
  assert.equal(job.session, "aaaa-slow")
  assert.equal(job.attempts, 0)
  assert.equal(job.transientFails, 1)

  for (let i = 0; i < 9; i++) await sum.drain()
  assert.equal((await sum.listQueue()).length, 0)
  assert.equal((await sum.listFailed()).length, 1) // gave up after 10 server errors
})

test("rate limiting still stops the drain without charging any job", async () => {
  calls = []
  mode = "429"
  const t = path.join(tmp, "rl.jsonl")
  await fs.writeFile(t, jl({ type: "user", timestamp: at(1000), message: { content: "rate limited " + "z".repeat(300) } }))
  for (const s of ["cccc-rl", "dddd-rl"]) {
    await sum.enqueue({ ws: "q", session: s, tool: "claude", transcript: t, log: await store.appendLog("q", { summary: "(auto)", session: s, source: "hook" }) })
  }
  await sum.drain()
  assert.equal(calls.length, 1)
  for (const j of await sum.listQueue()) assert.ok(!j.attempts && !j.transientFails, JSON.stringify(j))
  mode = "ok"
})
