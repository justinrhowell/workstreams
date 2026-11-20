import { test, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-mcp-"))
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
await store.createWorkstream("demo", { title: "Demo work", cwd: tmp, prefix: "DM" })

const serverPath = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))
const client = new Client({ name: "test", version: "0" })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, WS_ROOT: process.env.WS_ROOT } }))
after(() => client.close())

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError }
}

test("lists the expected tools", async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "ws_compose", "ws_decide", "ws_find", "ws_inbox", "ws_item_add", "ws_item_close", "ws_item_edit", "ws_list", "ws_log", "ws_set_status", "ws_show",
  ])
})

test("item lifecycle, log and status round-trip through the files", async () => {
  assert.match((await call("ws_item_add", { id: "demo", text: "Write the intro", waiting: "Reviewer" })).text, /Added DM-1/)
  await call("ws_item_add", { id: "demo", text: "Pick a font" })
  assert.match((await call("ws_item_close", { id: "demo", items: ["DM-2"], note: "Inter" })).text, /Closed DM-2/)
  assert.match((await call("ws_log", { id: "demo", summary: "Drafted the outline.", tool: "codex", closed: ["DM-2"] })).text, /Logged/)
  await call("ws_set_status", { id: "demo", status: "waiting", waiting_on: "Reviewer" })

  const show = (await call("ws_show", { id: "demo" })).text
  assert.match(show, /\[waiting\], waiting on Reviewer/)
  assert.match(show, /- DM-1 Write the intro \(waiting on Reviewer\)/)
  assert.match(show, /Recently closed:\n- DM-2 Pick a font/)
  assert.match(show, /codex: Drafted the outline\./)

  const w = await store.getWorkstream("demo")
  assert.equal(w.status, "waiting")
  assert.equal((await store.readOpen("demo")).items.find((i) => i.id === "DM-2").done, true)

  assert.match((await call("ws_compose", { id: "demo", tool: "codex" })).text, /^Continuing Demo work\.[\s\S]*DM-1/)
  // Gemini CLI is a supported target here too, not only through `ws prompt`.
  const gem = await call("ws_compose", { id: "demo", tool: "gemini" })
  assert.equal(gem.isError, false, gem.text)
  assert.match(gem.text, /--tool gemini/)
  assert.match((await call("ws_list")).text, /demo \[waiting\] Demo work: 1 open; waiting on Reviewer/)
})

test("errors come back as tool errors, not crashes", async () => {
  const r = await call("ws_item_close", { id: "demo", items: ["DM-99"] })
  assert.equal(r.isError, true)
  assert.match(r.text, /DM-99 not found/)
  assert.equal((await call("ws_show", { id: "nope" })).isError, true)
})
