// Gemini CLI: transcript reading, capture, summarizer digest and `ws setup`.
// Fixtures are synthetic, shaped after Gemini's ChatRecordingService records.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-gemini-")
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
// Gemini's own home override: transcripts are looked up under $GEMINI_CLI_HOME/.gemini.
process.env.GEMINI_CLI_HOME = path.join(tmp, "gemini-home")
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const sum = await import("../lib/summarize.mjs")
const { loadGeminiSession, wsToolName } = await import("../lib/gemini.mjs")
const S = await import("../lib/setup.mjs")

const site = path.join(tmp, "acme", "site")
const SID = "5f1c2b7e-9a10-4c3d-8e2f-0123456789ab"
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
const at = (m) => `2026-11-18T10:${String(m).padStart(2, "0")}:00Z`

// A session that exercises every record kind: a message re-appended after its tool
// calls finished, a $patch for a tool result, a $rewindTo that drops a turn, and $set.
function jsonlSession({ sessionId = SID, kind } = {}) {
  const meta = { sessionId, projectHash: "abc", startTime: at(0), lastUpdated: at(0), ...(kind ? { kind } : {}) }
  // Gemini CLI's own setup message, sent as "user" (seen in a live 0.70 session): not a user turn.
  const u0 = { id: "u0", timestamp: at(0), type: "user", content: [{ text: "<session_context>\nThis is the Gemini CLI. Today's date is …\nDirectory Structure: …\n</session_context>" }] }
  const u1 = { id: "u1", timestamp: at(1), type: "user", content: [{ text: "Fix the header layout" }] }
  const g1 = { id: "g1", timestamp: at(2), type: "gemini", content: "", toolCalls: [{ id: "t1", name: "read_file", args: { file_path: "src/a.ts" }, status: "executing", timestamp: at(2) }] }
  const g1b = { ...g1, content: "Updated the header.", toolCalls: [
    { id: "t1", name: "read_file", args: { file_path: "src/a.ts" }, status: "success", timestamp: at(2) },
    { id: "t2", name: "replace", args: { file_path: path.join(site, "src/header.tsx"), old_string: "a", new_string: "b" }, status: "success", timestamp: at(3) },
    { id: "t3", name: "write_file", args: { file_path: path.join(site, "src/new.css"), content: "x" }, status: "success", timestamp: at(3) },
    { id: "t4", name: "run_shell_command", args: { command: "npm run build > build.log" }, status: "success", timestamp: at(3) },
    { id: "t5", name: "mcp_ws_ws_log", args: { id: "acme-site", summary: "Header fixed" }, status: "success", timestamp: at(4) },
  ] }
  const u2 = { id: "u2", timestamp: at(5), type: "user", content: "oops, ignore that" }
  const u3 = { id: "u3", timestamp: at(6), type: "user", content: [{ text: "Now check mobile" }] }
  const g3 = { id: "g3", timestamp: at(7), type: "gemini", content: [{ text: "thinking", thought: true }, { text: "Mobile looks right." }] }
  return jl(
    meta, u0, u1, g1,
    { $patch: { id: "g1", toolCalls: [{ id: "t1", result: [{ text: "file body" }] }] } },
    g1b, // same id again: last copy wins, counted once
    u2,
    { $rewindTo: "u2" }, // drops u2
    u3, g3,
    { id: "i1", timestamp: at(8), type: "info", content: "Saved." },
    { $set: { summary: "Header layout fix", lastUpdated: at(8) } },
  )
}

async function writeChat(name, text, project = "abc") {
  const dir = path.join(process.env.GEMINI_CLI_HOME, ".gemini", "tmp", project, "chats")
  await fs.mkdir(dir, { recursive: true })
  const p = path.join(dir, name)
  await fs.writeFile(p, text)
  return p
}

before(async () => {
  await fs.mkdir(site, { recursive: true })
  await store.createWorkstream("acme-site", { title: "Acme site", cwd: site })
})

test("loadGeminiSession folds re-appended messages, patches, rewinds and $set", () => {
  const { meta, messages } = loadGeminiSession(jsonlSession())
  assert.equal(meta.sessionId, SID)
  assert.equal(meta.summary, "Header layout fix")
  assert.deepEqual(messages.map((m) => m.id), ["u0", "u1", "g1", "u3", "g3", "i1"])
  assert.equal(messages[2].toolCalls.length, 5, "the later full copy of g1 wins")
})

test("loadGeminiSession reads the legacy single-object .json format", () => {
  const legacy = JSON.stringify({ sessionId: SID, startTime: at(0), lastUpdated: at(9), messages: [
    { id: "a", timestamp: at(1), type: "user", content: "hi" },
    { id: "b", timestamp: at(2), type: "gemini", content: "hello", toolCalls: [{ id: "t", name: "write_file", args: { file_path: "/x/y" } }] },
  ] }, null, 2)
  const { meta, messages } = loadGeminiSession(legacy)
  assert.equal(meta.lastUpdated, at(9))
  assert.equal(messages.length, 2)
})

test("loadGeminiSession: $patch removeIds and a legacy $set messages checkpoint", () => {
  const text = jl(
    { sessionId: SID, projectHash: "p", startTime: at(0) },
    { id: "a", timestamp: at(1), type: "user", content: "one" },
    { $set: { messages: [{ id: "c", timestamp: at(2), type: "user", content: "two" }, { id: "d", timestamp: at(3), type: "user", content: "three" }] } },
    { $patch: { removeIds: ["c"] } },
  )
  assert.deepEqual(loadGeminiSession(text).messages.map((m) => m.id), ["d"])
})

test("wsToolName recognises current and older MCP tool names, nothing else", () => {
  assert.equal(wsToolName("mcp_ws_ws_log"), "ws_log")
  assert.equal(wsToolName("ws__ws_item_close"), "ws_item_close")
  assert.equal(wsToolName("mcp_other_ws_log"), null)
  assert.equal(wsToolName("write_file"), null)
})

test("readTranscript(gemini): turns, tool calls, files, ws calls and title, each counted once", async () => {
  const p = await writeChat("session-2026-11-18T10-00-5f1c2b7e.jsonl", jsonlSession())
  const t = await cap.readTranscript("gemini", p, SID)
  assert.equal(t.userTurns, 2, "u1 and u3; u2 was rewound")
  assert.equal(t.toolCalls, 5)
  assert.equal(t.title, "Header layout fix")
  assert.equal(t.started, at(0))
  assert.equal(t.ended, at(8))
  assert.ok(t.files.includes(path.join(site, "src/header.tsx")))
  assert.ok(t.files.includes(path.join(site, "src/new.css")))
  assert.ok(t.files.includes("build.log"), "shell redirect")
  assert.deepEqual(t.wsCalls, ["ws_log"])
  assert.equal(t.logCalls.length, 1)
  assert.equal(t.interactive, true, "Gemini records no non-interactive marker")
})

test("captureSession(gemini) links a session in a workstream folder", async () => {
  const p = await writeChat("session-link.jsonl", jsonlSession({ sessionId: "11112222-aaaa" }))
  const r = await cap.captureSession({ tool: "gemini", session_id: "11112222-aaaa", transcript_path: p, cwd: site })
  assert.equal(r.action, "linked")
  const log = await fs.readFile(r.file, "utf-8")
  assert.match(log, /tool: gemini/)
  assert.match(log, /Header layout fix/)
})

test("captureSession(gemini) finds the transcript by session id when transcript_path is empty", async () => {
  const id = "33334444-bbbb-cccc"
  // The file name carries only part of the id; the first record decides.
  await writeChat("session-2026-11-18T11-00-33334444.jsonl", jsonlSession({ sessionId: id }), "other-project")
  await writeChat("session-2026-11-18T11-00-decoy.jsonl", jsonlSession({ sessionId: "33334444-zzzz" }), "other-project")
  assert.match(await sum.findTranscript("gemini", id), /33334444\.jsonl$/)
  const r = await cap.captureSession({ tool: "gemini", session_id: id, transcript_path: "", cwd: site })
  assert.equal(r.action, "linked")
  assert.match(await fs.readFile(r.file, "utf-8"), /other-project\/chats\/session-[^\n]*33334444\.jsonl/)
})

test("captureSession(gemini) skips subagent sessions", async () => {
  const p = await writeChat("session-sub.jsonl", jsonlSession({ sessionId: "5555-sub", kind: "subagent" }))
  const r = await cap.captureSession({ tool: "gemini", session_id: "5555-sub", transcript_path: p, cwd: site })
  assert.equal(r.action, "skip")
})

test("digestTranscript(gemini): user and assistant text, tool hints; no thoughts or tool output", async () => {
  const p = await writeChat("session-digest.jsonl", jsonlSession())
  const d = await sum.digestTranscript("gemini", p)
  const lines = d.split("\n")
  assert.equal(lines[0], "USER: Fix the header layout")
  assert.ok(lines.includes("ASSISTANT: Updated the header."))
  assert.ok(lines.includes("ASSISTANT: Mobile looks right."))
  assert.ok(lines.some((l) => l.startsWith("TOOL: replace(") && l.includes("header.tsx")))
  assert.ok(lines.some((l) => l === "TOOL: run_shell_command(npm run build > build.log)"))
  assert.ok(!d.includes("oops"), "rewound turn is gone")
  assert.ok(!d.includes("thinking"), "thought parts are not assistant text")
  assert.ok(!d.includes("file body"), "tool output is never included")
  assert.ok(!d.includes("session_context") && !d.includes("Directory Structure"), "Gemini's setup message isn't a user turn")
})

test("ws hook gemini start prints JSON-only stdout with additionalContext", () => {
  const bin = path.join(path.dirname(S.BIN), "ws.mjs")
  const r = spawnSync(process.execPath, [bin, "hook", "gemini", "start"], {
    env: { ...process.env, WS_ROOT: process.env.WS_ROOT },
    input: JSON.stringify({ session_id: "x", transcript_path: "", cwd: site, hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf-8",
  })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.match(out.hookSpecificOutput.additionalContext, /workstream "acme-site"/)
})

// ------------------------------------------------------------------ setup

async function fakeHome(name) {
  const home = path.join(tmp, name)
  await fs.mkdir(home, { recursive: true })
  // GEMINI_CLI_HOME is cleared so the fake HOME decides; no gemini on PATH.
  return { home, env: { HOME: home, PATH: "/usr/bin:/bin", WS_ROOT: process.env.WS_ROOT } }
}

test("settingsFile(gemini) follows HOME, or GEMINI_CLI_HOME when set", () => {
  assert.equal(S.settingsFile("gemini", { HOME: "/h" }), "/h/.gemini/settings.json")
  assert.equal(S.settingsFile("gemini", { HOME: "/h", GEMINI_CLI_HOME: "/g" }), "/g/.gemini/settings.json")
})

test("mergeHooks(gemini) uses millisecond timeouts", () => {
  const { settings } = S.mergeHooks({}, "gemini", { wsPath: "/bin/ws", root: "/home/u/.local/share/ws", home: "/home/u" })
  const start = settings.hooks.SessionStart[0].hooks[0]
  const end = settings.hooks.SessionEnd[0].hooks[0]
  assert.equal(start.command, "/bin/ws hook gemini start")
  assert.equal(end.command, "/bin/ws hook gemini end")
  assert.ok(start.timeout >= 1000 && end.timeout >= 1000, "Gemini counts milliseconds")
})

test("mergeGeminiMcp: adds, keeps user keys, leaves a foreign 'ws' alone, removes only ours", () => {
  const MCP = S.MCP
  const add = S.mergeGeminiMcp({ mcpServers: { other: { command: "x" } } }, { root: "/d", pin: true, command: "node" })
  assert.deepEqual(add.changes, ["added MCP server ws"])
  assert.deepEqual(add.settings.mcpServers.ws, { command: "node", args: [MCP], env: { WS_ROOT: "/d" } })
  assert.equal(add.settings.mcpServers.other.command, "x")
  assert.deepEqual(S.mergeGeminiMcp(add.settings, { root: "/d", pin: true, command: "node" }).changes, [])

  const custom = { mcpServers: { ws: { command: "/old/node", args: ["/old/ws/mcp/server.mjs"], env: { WS_ROOT: "/d" }, trust: true } } }
  const upd = S.mergeGeminiMcp(custom, { root: "/d", pin: false, command: "node" })
  assert.deepEqual(upd.settings.mcpServers.ws, { command: "node", args: [MCP], trust: true }, "unpinned: env dropped, trust kept")

  const foreign = { mcpServers: { ws: { command: "python", args: ["other.py"] } } }
  assert.deepEqual(S.mergeGeminiMcp(foreign, { root: "/d", pin: false, command: "node" }).changes, [])
  assert.deepEqual(S.removeGeminiMcp(foreign).changes, [])
  const gone = S.removeGeminiMcp(add.settings)
  assert.deepEqual(gone.changes, ["removed MCP server ws"])
  assert.equal(gone.settings.mcpServers.ws, undefined)
  assert.equal(gone.settings.mcpServers.other.command, "x")
})

test("runSetup/runUninstall(gemini): hooks and MCP in one write, one backup; never runs a gemini CLI", async () => {
  const { home, env } = await fakeHome("home-gem")
  const file = S.settingsFile("gemini", env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ theme: "Dracula", mcpServers: { other: { command: "x" } } }))
  const lines = []
  const r = await S.runSetup({ tools: ["gemini"], link: false, env, log: (s) => lines.push(s) })
  assert.deepEqual(r.problems, [])
  const s = JSON.parse(await fs.readFile(file, "utf-8"))
  assert.equal(s.theme, "Dracula")
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /hook gemini start$/)
  assert.ok(s.mcpServers.ws.args[0].endsWith(path.join("ws", "mcp", "server.mjs")))
  assert.equal(s.mcpServers.ws.env.WS_ROOT, process.env.WS_ROOT, "non-default data folder is pinned")
  assert.equal((await fs.readdir(path.dirname(file))).filter((f) => f.startsWith("settings.json.bak-ws-")).length, 1, "one write, one backup")
  assert.ok(!lines.some((l) => /gemini MCP: `gemini` not found/.test(l)), "no CLI needed")

  const again = []
  await S.runSetup({ tools: ["gemini"], link: false, env, log: (x) => again.push(x) })
  assert.ok(again.some((l) => l.startsWith("gemini hooks + MCP: up to date")))

  await S.runUninstall({ tools: ["gemini"], env, log: () => {} })
  const after = JSON.parse(await fs.readFile(file, "utf-8"))
  assert.equal(after.hooks, undefined)
  assert.deepEqual(after.mcpServers, { other: { command: "x" } })
  assert.equal(after.theme, "Dracula")
  assert.ok(home)
})

test("detectTools finds Gemini by its folder and honours --gemini", async () => {
  const { home, env } = await fakeHome("home-detect")
  assert.deepEqual(await S.detectTools({ env }), [])
  await fs.mkdir(path.join(home, ".gemini"), { recursive: true })
  assert.deepEqual(await S.detectTools({ env }), ["gemini"])
  assert.deepEqual(await S.detectTools({ gemini: true, env }), ["gemini"])
})
