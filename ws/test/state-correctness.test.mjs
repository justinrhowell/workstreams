// State correctness: once an item is closed or a decision superseded, it must not
// reach a model or a person as current through ANY surface. Invalidated records
// tend to leak through secondary paths, so every surface is checked.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-state-"))
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
const { compose } = await import("../lib/compose.mjs")
const cap = await import("../lib/capture.mjs")
const sum = await import("../lib/summarize.mjs")

const site = path.join(tmp, "site")
const memDir = path.join(tmp, "mem")
const DEAD_ITEM = "ZOMBIE-ITEM-TEXT"
const DEAD_DEC = "ZOMBIE-DECISION-TEXT"
let closedId, supersededId, client

before(async () => {
  await fs.mkdir(site, { recursive: true })
  await fs.mkdir(memDir, { recursive: true })
  await fs.writeFile(path.join(memDir, "note.md"), "---\nname: n\n---\nA memory note.\n")
  await fs.writeFile(path.join(site, "STATUS.md"), "# Status\n\nNarrative.\n")
  await store.createWorkstream("st", { title: "State test", cwd: site, prefix: "ST" })
  await store.updateWorkstream("st", { sources: [{ path: path.join(memDir, "note.md"), role: "memory" }], mirror: path.join(site, "STATUS.md") })
  closedId = (await store.addItem("st", `${DEAD_ITEM} should vanish`)).id
  await store.addItem("st", "Live item stays")
  supersededId = (await store.decide("st", `${DEAD_DEC} old choice`)).decision.id
  await store.decide("st", "Live decision stays", { supersedes: supersededId })
  await store.closeItem("st", closedId)
  // Make the mirror doc old enough to be rewritten, then sync it.
  const old = new Date(Date.now() - 10 * 60_000)
  await fs.utimes(path.join(site, "STATUS.md"), old, old)
  await store.syncMirror("st", { init: true })

  client = new Client({ name: "t", version: "0" })
  const server = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env } }))
})
after(() => client?.close())

const clean = (label, text) => {
  assert.doesNotMatch(text, new RegExp(DEAD_ITEM), `${label} leaked a closed item`)
  assert.doesNotMatch(text, new RegExp(DEAD_DEC), `${label} leaked a superseded decision`)
  assert.match(text, /Live item stays/, `${label} lost the live item`)
}

test("resume prompt (claude, codex, inline)", async () => {
  for (const opts of [{ tool: "claude" }, { tool: "codex" }, { tool: "claude", inline: true }]) {
    const { text } = await compose("st", opts)
    clean(`compose ${JSON.stringify(opts)}`, text)
    assert.match(text, /Live decision stays/)
  }
})

test("session-start note", async () => {
  const note = await cap.startContext({ cwd: site })
  clean("start note", note)
})

test("mirror block in the project doc", async () => {
  const doc = await fs.readFile(path.join(site, "STATUS.md"), "utf-8")
  const block = doc.slice(doc.indexOf("<!-- ws:open"), doc.indexOf("<!-- /ws:open -->"))
  clean("mirror", block)
})

test("MCP ws_show and ws_compose", async () => {
  const show = (await client.callTool({ name: "ws_show", arguments: { id: "st" } })).content[0].text
  // ws_show lists closed items under "Recently closed" by design; the open list must not.
  const openPart = show.split("Recently closed:")[0]
  clean("ws_show (open part)", openPart)
  assert.doesNotMatch(show, new RegExp(DEAD_DEC), "ws_show leaked a superseded decision")
  const comp = (await client.callTool({ name: "ws_compose", arguments: { id: "st" } })).content[0].text
  clean("ws_compose", comp)
})

test("summarizer input and validation", async () => {
  const open = (await store.readOpen("st")).items.filter((i) => !i.done)
  const decided = (await store.readDecisions("st")).decisions.filter((d) => d.active)
  clean("summarizer open-items input", open.map((i) => i.text).join("\n") + "\nLive item stays")
  assert.ok(!decided.some((d) => d.text.includes(DEAD_DEC)), "summarizer decided-input leaked a superseded decision")
  // A proposal can't re-close an already closed item.
  const p = sum.validateProposal(JSON.stringify({ summary: "x", close: [{ id: closedId, quote: "q q q q q", why: "w" }] }), open, "q q q q q")
  assert.equal(p.close.length + p.unverified.length, 0)
})
