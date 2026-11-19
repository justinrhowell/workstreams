// Search: what matches, how results are ranked and marked, and the CLI/MCP surfaces.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-search-")
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
const { search, parseQuery, snippet, formatResult } = await import("../lib/search.mjs")

await store.createWorkstream("site", { title: "Acme website relaunch", cwd: tmp, prefix: "AC", group: "clients" })
await store.createWorkstream("infra", { title: "Home lab", cwd: tmp, prefix: "HL" })
await store.addItem("site", "Move hosting off Vercel to S3")
for (let n = 2; n <= 10; n++) await store.addItem("site", `Filler item ${n}`)
await store.addItem("site", "Ask the client for the logo files", { waiting: "client" })
const oldPick = (await store.addItem("site", "Pick a font for headings")).id
await store.closeItem("site", oldPick, { note: "chose Inter" })
const oldDec = (await store.decide("site", "Host on Vercel")).decision.id
await store.decide("site", "Host on S3 with CloudFront", { why: "cheaper than Vercel at this traffic", supersedes: oldDec })
await store.appendLog("site", { tool: "claude", summary: "Wrote the deploy workflow for S3; Vercel project kept until DNS moves.", files_touched: ["~/acme/deploy.yml"] })
await store.appendLog("infra", { tool: "codex", title: "NAS snapshots", summary: "Pruned old btrfs snapshots." })
await fs.mkdir(path.join(process.env.WS_ROOT, "inbox"), { recursive: true })
await fs.writeFile(path.join(process.env.WS_ROOT, "inbox", "2026-11-19_claude_abc.md"),
  "---\nsession: abc\ntool: claude\ncwd: ~/scratch\ntitle: Printer driver hunt\nended: '2026-11-19T10:00:00.000Z'\n---\n\nPrinter driver hunt\n")

const ids = (r) => r.results.map((x) => `${x.kind}:${x.id}`)

test("parseQuery: words and quoted phrases, lowercased", () => {
  assert.deepEqual(parseQuery('Vercel  "Host on" s3'), ["vercel", "host on", "s3"])
  assert.deepEqual(parseQuery('  ""  '), [])
})

test("every word must match within one record; workstream, items, decisions, logs and the inbox are all searched", async () => {
  const r = await search("vercel")
  const kinds = new Set(r.results.map((x) => x.kind))
  for (const k of ["item", "decision", "log"]) assert.ok(kinds.has(k), `no ${k} result`)
  assert.equal((await search("vercel logo")).total, 0)
  assert.deepEqual(ids(await search("printer")), ["inbox:2026-11-19_claude_abc"])
  assert.deepEqual(ids(await search("acme clients")), ["workstream:site"])
  assert.deepEqual(ids(await search("deploy.yml")).map((s) => s.split(":")[0]), ["log"], "files touched are searched")
  assert.deepEqual(ids(await search("cheaper")), ["decision:AC-D2"], "a decision's why is searched")
})

test("closed items and superseded decisions are found but marked and ranked after current ones", async () => {
  const r = await search("vercel", { kinds: ["decision"] })
  assert.deepEqual(r.results.map((x) => [x.id, x.state]), [["AC-D2", "active"], ["AC-D1", "superseded"]])
  const lines = r.results.map(formatResult)
  assert.match(lines[1], /^\[superseded decision → AC-D2\] site · AC-D1 Host on Vercel$/)
  const closed = (await search("font")).results[0]
  assert.equal(closed.state, "closed")
  assert.match(formatResult(closed), /^\[closed item \d{4}-\d{2}-\d{2}\] site · AC-12 Pick a font/)
  assert.deepEqual(ids(await search("font", { current: true })), [])
  assert.deepEqual(ids(await search("vercel", { kinds: "decisions", current: true })), ["decision:AC-D2"])
})

test("an ID finds that record first, and AC-1 doesn't match AC-10", async () => {
  const r = await search("ac-1")
  assert.equal(ids(r)[0], "item:AC-1")
  assert.ok(!ids(r).includes("item:AC-10"))
  assert.equal(ids(await search("AC-10"))[0], "item:AC-10")
  assert.equal(ids(await search("AC-D1"))[0], "decision:AC-D1")
})

test("filters: ws, kinds, limit; bad input is an error", async () => {
  assert.ok((await search("snapshots", { ws: "infra" })).results.every((x) => x.ws === "infra"))
  assert.equal((await search("printer", { ws: "site" })).total, 0, "the inbox isn't part of one workstream")
  const lim = await search("item", { limit: 2 })
  assert.equal(lim.results.length, 2)
  assert.ok(lim.total > 2)
  await assert.rejects(search("x", { ws: "nope" }), /No workstream "nope"/)
  await assert.rejects(search("x", { kinds: ["bogus"] }), /unknown kind bogus/)
  await assert.rejects(search("   "), /empty search/)
})

test("snippet centres on the match and marks cuts", () => {
  const long = "a".repeat(300) + " needle " + "b".repeat(300)
  const s = snippet(long, ["needle"])
  assert.ok(s.startsWith("…") && s.endsWith("…") && s.includes("needle") && s.length < 170)
  assert.equal(snippet("short text", ["x"]), "short text")
})

test("a session without a title shows its matching text; a titled one shows the title", async () => {
  const [untitled] = (await search("dns moves")).results
  assert.equal(untitled.kind, "log")
  assert.match(untitled.text, /DNS moves/)
  const [titled] = (await search("btrfs")).results
  assert.equal(titled.text, "NAS snapshots")
  assert.match(titled.snippet, /btrfs/)
})

const ws = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [ws, ...args], { env: { ...process.env, WS_ROOT: process.env.WS_ROOT }, encoding: "utf-8" })

test("ws find prints tagged lines, --json gives the records, bad options fail", () => {
  const r = cli("find", "vercel", "--kind", "decision")
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^\[decision \d{4}-\d{2}-\d{2}\] site · AC-D2 Host on S3 with CloudFront$/m)
  assert.match(r.stdout, /^\[superseded decision → AC-D2\] site · AC-D1 Host on Vercel$/m)
  const j = JSON.parse(cli("find", "printer", "--json").stdout)
  assert.equal(j.total, 1)
  assert.equal(j.results[0].kind, "inbox")
  assert.match(cli("find", "zzzz").stdout, /No matches for "zzzz"/)
  assert.equal(cli("find", "x", "--limit", "0").status, 1)
  assert.equal(cli("find", "x", "--bogus").status, 1)
  assert.equal(cli("find").status, 1)
})

test("MCP ws_find", async () => {
  const client = new Client({ name: "t", version: "0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))], env: { ...process.env } }))
  after(() => client.close())
  const call = async (args) => (await client.callTool({ name: "ws_find", arguments: args })).content[0].text
  const t = await call({ query: "vercel", kinds: ["decision"] })
  assert.match(t, /^2 matches for "vercel":\n\[decision [\d-]+\] site · AC-D2 Host on S3 with CloudFront\n    cheaper than Vercel at this traffic\n\[superseded decision → AC-D2\] site · AC-D1 Host on Vercel$/)
  assert.match(await call({ query: "font", current: true }), /No matches/)
  assert.match(await call({ query: "item", limit: 1 }), /more; raise limit/)
})
