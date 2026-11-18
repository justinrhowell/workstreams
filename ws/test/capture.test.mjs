import { test, before } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { mkTmp } from "./tmp.mjs"
import matter from "gray-matter"

const tmp = await mkTmp("ws-cap-")
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const { compose } = await import("../lib/compose.mjs")

const site = path.join(tmp, "acme", "site")
const shared = path.join(tmp, "shared")
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"

async function claudeTranscript(name, { turns = 2, edits = [], title = "Fix the header", day = "2026-11-17" } = {}) {
  const rows = [{ type: "ai-title", aiTitle: title }]
  for (let i = 0; i < turns; i++) rows.push({ type: "user", timestamp: `${day}T10:0${i}:00Z`, message: { role: "user", content: `prompt ${i}` } })
  rows.push({ type: "user", timestamp: `${day}T10:05:00Z`, message: { content: [{ type: "tool_result", content: "ok" }] } })
  for (const f of edits) rows.push({ type: "assistant", timestamp: `${day}T10:06:00Z`, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: f } }] } })
  const p = path.join(tmp, `${name}.jsonl`)
  await fs.writeFile(p, jl(...rows))
  return p
}

before(async () => {
  for (const d of [site, shared]) await fs.mkdir(d, { recursive: true })
  await store.createWorkstream("acme-site", { title: "Acme site", cwd: site })
  await store.createWorkstream("shared-a", { title: "Shared Alpha", cwd: shared })
  await store.createWorkstream("shared-b", { title: "Shared B", cwd: shared })
  await store.createWorkstream("acme-old", { title: "Acme old", cwd: site, status: "parked" })
})

test("matching: one live claimant links, two go to the inbox, WS_ID wins", async () => {
  const list = await store.listWorkstreams()
  assert.equal(cap.matchWorkstream(list, path.join(site, "src"), null).link, "acme-site")
  const two = cap.matchWorkstream(list, shared, null)
  assert.equal(two.link, null)
  assert.deepEqual(two.candidates.sort(), ["shared-a", "shared-b"])
  assert.equal(cap.matchWorkstream(list, shared, "shared-b").link, "shared-b")
  assert.equal(cap.matchWorkstream(list, tmp, null).link, null)
  assert.deepEqual(cap.suggest(list, { cwd: tmp, title: "lab results summary", files: [] }), []) // parent folder is not evidence
})

test("Claude session in a workstream folder becomes a log stub with title and files", async () => {
  const t = await claudeTranscript("c1", { edits: [path.join(site, "a.css")] })
  const r = await cap.captureSession({ tool: "claude", session_id: "aaaa1111-x", transcript_path: t, cwd: site })
  assert.equal(r.action, "linked")
  const { data, content } = matter(await fs.readFile(r.file, "utf-8"))
  assert.equal(data.session, "aaaa1111-x")
  assert.equal(data.title, "Fix the header")
  assert.equal(data.user_turns, 2)
  assert.equal(data.files_touched.length, 1)
  assert.match(content, /\(auto\) Fix the header/)
  const again = await cap.captureSession({ tool: "claude", session_id: "aaaa1111-x", transcript_path: t, cwd: site })
  assert.equal(again.action, "updated")
  assert.equal((await store.getWorkstream("acme-site")).logs.length, 1)
})

test("a manual `ws log` written during the session is adopted, not duplicated", async () => {
  await store.appendLog("acme-site", { summary: "Shipped the nav fix." })
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
  const t = path.join(tmp, "c2.jsonl")
  await fs.writeFile(t, jl(
    { type: "ai-title", aiTitle: "Fix the header" },
    { type: "user", timestamp: at(120_000), message: { content: "prompt 0" } },
    { type: "user", timestamp: at(60_000), message: { content: "prompt 1" } },
  ))
  const r = await cap.captureSession({ tool: "claude", session_id: "bbbb2222-y", transcript_path: t, cwd: site })
  assert.equal(r.action, "adopted")
  const logs = (await store.getWorkstream("acme-site")).logs
  assert.equal(logs.length, 2)
  const adopted = logs.find((l) => l.session === "bbbb2222-y")
  assert.equal(adopted.summary, "Shipped the nav fix.")
  assert.equal(adopted.source, "manual+hook")
})

test("ambiguous folder goes to the inbox with suggestions; tiny sessions are skipped", async () => {
  const t = await claudeTranscript("c3", { title: "Alpha data fix" })
  const r = await cap.captureSession({ tool: "claude", session_id: "cccc3333", transcript_path: t, cwd: shared })
  assert.equal(r.action, "inbox")
  assert.equal(r.suggestions[0], "shared-a")
  const tiny = await claudeTranscript("c4", { turns: 1 })
  assert.equal((await cap.captureSession({ tool: "claude", session_id: "dddd4444", transcript_path: tiny, cwd: tmp })).action, "skip")
  assert.equal((await cap.captureSession({ tool: "claude", session_id: "dddd4445", transcript_path: tiny, cwd: site })).action, "skip") // tiny, even in a workstream
  assert.equal((await cap.captureSession({ tool: "claude", session_id: "dddd4446", transcript_path: tiny, cwd: site, wsId: "acme-site" })).action, "linked") // unless ws go launched it
})

test("inbox assign moves the row into the workstream log; ignore --cwd suppresses the folder", async () => {
  let rows = await cap.listInbox()
  assert.equal(rows.length, 1)
  await cap.assignInbox(rows[0], "shared-a", "Fixed the shared data.")
  assert.equal((await cap.listInbox()).length, 0)
  assert.ok((await store.getWorkstream("shared-a")).logs.some((l) => l.session === "cccc3333" && l.summary === "Fixed the shared data."))

  const t = await claudeTranscript("c5")
  await cap.captureSession({ tool: "claude", session_id: "eeee5555", transcript_path: t, cwd: tmp })
  rows = await cap.listInbox()
  await cap.ignoreInbox(rows[0], { cwd: true })
  const again = await cap.captureSession({ tool: "claude", session_id: "ffff6666", transcript_path: t, cwd: await fs.mkdtemp(path.join(os.tmpdir(), "ws-other-")) })
  assert.equal(again.action, "inbox") // a different folder is not ignored
  const same = await cap.captureSession({ tool: "claude", session_id: "gggg7777", transcript_path: t, cwd: tmp })
  assert.equal(same.action, "skip")
})

test("Codex transcript: user turns, patch file paths, ws calls", async () => {
  const p = path.join(tmp, "codex.jsonl")
  await fs.writeFile(p, jl(
    { timestamp: "2026-11-17T09:00:00Z", type: "session_meta", payload: { id: "c0de", cwd: site } },
    { timestamp: "2026-11-17T09:00:01Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage" } } },
    { timestamp: "2026-11-17T09:00:02Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage" } } },
    { timestamp: "2026-11-17T09:00:03Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "tools.apply_patch(`*** Begin Patch\n*** Update File: src/app.ts\n@@\n*** Add File: src/new.ts\n`)" } },
    { timestamp: "2026-11-17T09:00:04Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "exec_command({cmd:'ws item close acme-site AS-1'})" } },
  ))
  const t = await cap.readTranscript("codex", p, "c0de")
  assert.equal(t.userTurns, 2)
  assert.deepEqual(t.files, ["src/app.ts", "src/new.ts"])
  assert.equal(t.wsCalls.length, 1)
  assert.equal(t.started, "2026-11-17T09:00:00Z")
})

test("start context: one workstream gets its open items, a shared folder lists candidates", async () => {
  await store.addItem("acme-site", "Fix the footer")
  const one = await cap.startContext({ cwd: site })
  assert.match(one, /workstream "acme-site"/)
  assert.match(one, /AS-1 Fix the footer/)
  assert.match(await cap.startContext({ cwd: shared }), /Several workstreams.*shared-a.*shared-b|Several workstreams.*shared-b.*shared-a/)
  assert.equal(await cap.startContext({ cwd: tmp }), "")
})

test("compose prefers the newest real summary and flags unsummarized sessions after it", async () => {
  const t = await claudeTranscript("c6", { title: "Late tweak", day: "2099-01-01" })
  const r = await cap.captureSession({ tool: "claude", session_id: "hhhh8888", transcript_path: t, cwd: site })
  assert.equal(r.action, "linked") // an ignored parent folder must not hide a workstream
  const { text } = await compose("acme-site")
  assert.match(text, /Last session \(.*\): Shipped the nav fix\./)
  assert.match(text, /no notes[\s\S]*"Late tweak"/)
})

test("hook start prints hookSpecificOutput JSON (Codex parses a leading '[' as JSON)", async () => {
  const { spawnSync } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const bin = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))
  const r = spawnSync(process.execPath, [bin, "hook", "codex", "start"], {
    input: JSON.stringify({ cwd: site, source: "startup" }), env: { ...process.env, WS_ROOT: process.env.WS_ROOT },
  })
  const errs = await fs.readFile(path.join(process.env.WS_ROOT, "hook-errors.log"), "utf-8").catch(() => "")
  assert.ok(r.stdout.length, `no output; stderr=${r.stderr} errors=${errs}`)
  const out = JSON.parse(r.stdout.toString())
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart")
  assert.match(out.hookSpecificOutput.additionalContext, /^\[ws\] This folder belongs to workstream "acme-site"/)
})

test("a resumed run's new manual log is adopted even when the session already has an entry", async () => {
  // Exact times relative to now (truncating the clock made this flaky near ten-minute marks).
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
  const t = path.join(tmp, "c7.jsonl")
  await fs.writeFile(t, jl(
    { type: "ai-title", aiTitle: "Resumable" },
    { type: "user", timestamp: at(120_000), message: { content: "first prompt" } },
    { type: "user", timestamp: at(60_000), message: { content: "second prompt" } },
    { type: "user", timestamp: at(30_000), message: { content: [{ type: "tool_result", content: "ok" }] } },
  ))
  assert.equal((await cap.captureSession({ tool: "claude", session_id: "rrrr9999", transcript_path: t, cwd: site })).action, "linked")
  await store.appendLog("acme-site", { summary: "Second run after resume." })
  const r = await cap.captureSession({ tool: "claude", session_id: "rrrr9999", transcript_path: t, cwd: site })
  assert.equal(r.action, "adopted")
  const mine = (await store.getWorkstream("acme-site")).logs.filter((l) => l.session === "rrrr9999")
  assert.equal(mine.length, 2)
  assert.ok(mine.some((l) => l.summary === "Second run after resume."))
})

test("one-prompt sessions that do real work or use the ws MCP tools are kept", async () => {
  const day = "2099-02-02"
  // Claude: one prompt, several Bash calls, one mcp__ws__ws_log; no WS_ID.
  const p = path.join(tmp, "mcp-claude.jsonl")
  await fs.writeFile(p, jl(
    { type: "user", timestamp: `${day}T10:00:00Z`, message: { content: "do the thing" } },
    { type: "assistant", timestamp: `${day}T10:01:00Z`, message: { content: [{ type: "tool_use", name: "Bash", input: { command: "make" } }] } },
    { type: "assistant", timestamp: `${day}T10:02:00Z`, message: { content: [{ type: "tool_use", name: "mcp__ws__ws_log", input: { id: "acme-site", summary: "x" } }] } },
  ))
  const t = await cap.readTranscript("claude", p, "mcpc")
  assert.equal(t.wsCalls.length, 1)
  assert.notEqual((await cap.captureSession({ tool: "claude", session_id: "mcpc0001", transcript_path: p, cwd: site })).action, "skip")

  // Codex: MCP calls are item_completed / McpToolCall with server "ws".
  const q = path.join(tmp, "mcp-codex.jsonl")
  await fs.writeFile(q, jl(
    { timestamp: `${day}T09:00:00Z`, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage" } } },
    { timestamp: `${day}T09:00:05Z`, type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "ws", tool: "ws_item_close", arguments: {} } } },
  ))
  assert.equal((await cap.readTranscript("codex", q, "mcpx")).wsCalls.length, 1)

  // Five tool calls in one prompt is real work, even without edits or ws calls.
  const r = path.join(tmp, "busy.jsonl")
  await fs.writeFile(r, jl(
    { type: "user", timestamp: `${day}T11:00:00Z`, message: { content: "investigate" } },
    ...Array.from({ length: 5 }, (_, i) => ({ type: "assistant", timestamp: `${day}T11:0${i + 1}:00Z`, message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } })),
  ))
  assert.equal((await cap.captureSession({ tool: "claude", session_id: "busy0001", transcript_path: r, cwd: site })).action, "linked")
})

test("E2E: a workstream named through a symlinked folder claims sessions reported by real path", async () => {
  const real = path.join(tmp, "real-proj")
  const link = path.join(tmp, "link-proj")
  await fs.mkdir(path.join(real, "sub"), { recursive: true })
  await fs.symlink(real, link)
  await store.createWorkstream("via-link", { title: "Via link", cwd: link })
  const list = await store.listWorkstreams()
  const realCwd = await fs.realpath(path.join(real, "sub"))
  assert.equal(cap.matchWorkstream(list, realCwd, null).link, "via-link")
  assert.equal(cap.matchWorkstream(list, path.join(link, "sub"), null).link, "via-link")
  await store.updateWorkstream("via-link", { status: "done" })
})

// ------------------------------------------------------------ e2e follow-ups

const write = async (name, ...rows) => { const p = path.join(tmp, `${name}.jsonl`); await fs.writeFile(p, jl(...rows)); return p }

test("scripted runs (codex exec, claude -p) outside any workstream folder skip the inbox", async () => {
  const nowhere = await mkTmp("ws-nowhere-") // not on the ignore list an earlier test writes
  const tools = Array.from({ length: 6 }, () => ({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "ls" } }))
  const exec = await write("exec1", { type: "session_meta", payload: { originator: "codex_exec", source: "exec", cwd: nowhere } }, ...tools)
  assert.equal((await cap.captureSession({ tool: "codex", session_id: "exec-1", transcript_path: exec, cwd: nowhere })).why, "non-interactive run outside a workstream folder")
  const sdk = await write("sdk1", ...Array.from({ length: 3 }, (_, i) => ({ type: "user", entrypoint: "sdk-cli", message: { content: `p${i}` } })),
    { type: "assistant", entrypoint: "sdk-cli", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(nowhere, "x") } }] } })
  assert.equal((await cap.captureSession({ tool: "claude", session_id: "sdk-1", transcript_path: sdk, cwd: nowhere })).why, "non-interactive run outside a workstream folder")
  // Inside a workstream's folder a scripted run is still logged.
  const inSite = await cap.captureSession({ tool: "codex", session_id: "exec-2", transcript_path: exec, cwd: site })
  assert.equal(inSite.action, "linked")
})

test("in a workstream's folder, a one-prompt session that used a tool is logged; a toolless one isn't", async () => {
  const did = await write("did1", { type: "user", message: { content: "make hello.txt" } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hello > hello.txt 2>&1 && cat hello.txt > /dev/null" } }] } })
  const r = await cap.captureSession({ tool: "claude", session_id: "did-1", transcript_path: did, cwd: site })
  assert.equal(r.action, "linked")
  const { data } = matter(await fs.readFile(r.file, "utf-8"))
  assert.deepEqual(data.files_touched, [store.tildify(path.join(site, "hello.txt"))]) // shell write found; /dev/null and 2>&1 ignored
  const idle = await write("idle1", { type: "user", message: { content: "what's open?" } }, { type: "assistant", message: { content: [{ type: "text", text: "ET-3" }] } })
  assert.equal((await cap.captureSession({ tool: "claude", session_id: "idle-1", transcript_path: idle, cwd: site })).why, "too small")
})

test("long close notes are clipped in open.md", async () => {
  const it = await store.addItem("acme-site", "Clip me")
  const closed = await store.closeItem("acme-site", it.id, { note: "x".repeat(400) })
  assert.ok(closed.closed.length < 200)
  assert.match(closed.closed, /…$/)
})
