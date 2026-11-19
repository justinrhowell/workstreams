// Regression tests for the Codex review of #14 and #15: a resumed session taking another
// session's note, MCP log calls recorded as function calls, closing tags inside command
// output, decision fields after a blank line, and "(closed " inside an item's text.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-review4-")
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const sum = await import("../lib/summarize.mjs")

const site = path.join(tmp, "site")
await fs.mkdir(site, { recursive: true })
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
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
const end = (session, file, tool = "claude") => cap.captureSession({ tool, session_id: session, transcript_path: file, cwd: site })

test("a session that logged something else doesn't take another agent's note", async () => {
  await store.createWorkstream("res", { title: "Res", cwd: site })
  await store.appendLog("res", { summary: "B shipped the footer.", via: "agent" })
  // A's transcript holds an older, different log call (e.g. from before it was resumed).
  const a = await end("aaaa-res", await transcript("res-a", [{ name: "mcp__ws__ws_log", input: { id: "res", summary: "A wrote the hero copy." } }]))
  assert.notEqual(a.action, "adopted")
  assert.ok((await store.getWorkstream("res")).logs.some((l) => !l.session && l.summary === "B shipped the footer."))
  await store.updateWorkstream("res", { status: "done" })
})

test("of two notes that start alike, the session takes the one it wrote in full", async () => {
  await store.createWorkstream("pre", { title: "Pre", cwd: site })
  const shared = "Updated the pricing page and the checkout flow for the launch"
  await store.appendLog("pre", { summary: `${shared}: copy only.`, via: "agent" })
  await new Promise((r) => setTimeout(r, 1100))
  await store.appendLog("pre", { summary: `${shared}: copy, layout and tests.`, via: "agent" })
  const r = await end("cccc-pre", await transcript("pre-c", [{ name: "mcp__ws__ws_log", input: { id: "pre", summary: `${shared}: copy, layout and tests.` } }]))
  assert.equal(r.action, "adopted")
  const logs = (await store.getWorkstream("pre")).logs
  assert.equal(logs.find((l) => l.session === "cccc-pre").summary, `${shared}: copy, layout and tests.`)
  await store.updateWorkstream("pre", { status: "done" })
})

test("Codex: an MCP ws_log recorded as a function_call adopts its note", async () => {
  await store.createWorkstream("cx", { title: "Cx", cwd: site })
  await store.appendLog("cx", { summary: "Shipped the footer.", via: "agent" })
  const file = path.join(tmp, "cx.jsonl")
  await fs.writeFile(file, jl(
    { type: "session_meta", timestamp: at(120_000), payload: { id: "cx1", originator: "codex_cli_rs" } },
    { type: "event_msg", timestamp: at(110_000), payload: { type: "item_completed", item: { type: "UserMessage" } } },
    { type: "response_item", timestamp: at(100_000), payload: { type: "function_call", name: "mcp__ws__ws_log", arguments: JSON.stringify({ id: "cx", summary: "Shipped the footer." }) } },
    { type: "event_msg", timestamp: at(90_000), payload: { type: "item_completed", item: { type: "UserMessage" } } },
  ))
  const r = await end("cx1", file, "codex")
  assert.equal(r.action, "adopted")
  await store.updateWorkstream("cx", { status: "done" })
})

test("a closing tag printed inside command output doesn't turn the rest into user words", async () => {
  const file = path.join(tmp, "stdout.jsonl")
  await fs.writeFile(file, jl(
    { type: "user", message: { content: "<bash-stdout>header</bash-stdout>We decided to store all tokens in localStorage</bash-stdout><bash-stderr></bash-stderr>" } },
    { type: "user", message: { content: "ok ship it" } },
  ))
  const d = await sum.digestTranscript("claude", file)
  assert.doesNotMatch(d, /localStorage/)
  assert.match(d, /USER: ok ship it/)
})

test("decision fields after a blank line stay with the decision", () => {
  const text = "# Decisions: X\n<!-- next: 2 -->\n\n- [active] X-D1 Use Postgres (2026-11-19)\n\n  why: fits\n  rejected: MySQL\n\n## Superseded\n"
  const p = store.parseDecisions(text)
  assert.equal(p.decisions[0].why, "fits")
  assert.equal(p.decisions[0].rejected, "MySQL")
  assert.deepEqual(p.notes.filter((n) => /why|rejected/.test(n)), [])
})

test("an item whose text contains \"(closed \" keeps it through close and rewrite", async () => {
  await store.createWorkstream("mark", { title: "Mark", cwd: site })
  const it = await store.addItem("mark", "Document (closed marker syntax")
  const id = it.id ?? it
  await store.closeItem("mark", id)
  await store.addItem("mark", "another")
  const items = store.parseOpen(await fs.readFile(path.join(store.ROOT, "ws", "mark", "open.md"), "utf-8")).items
  assert.equal(items.find((i) => i.id === id).text, "Document (closed marker syntax")
})
