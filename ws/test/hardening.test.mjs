// Regression tests for the public-release review: data safety, input validation,
// config handling and the summarizer's trust boundaries. One test per finding.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import http from "node:http"
import path from "node:path"
import os from "node:os"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-hard-"))
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
const store = await import("../lib/store.mjs")
const sum = await import("../lib/summarize.mjs")
const { validateConfig } = await import("../lib/config.mjs")
const { runEval } = await import("../lib/eval.mjs")

const proj = path.join(tmp, "proj")
let status = 200
let reply = null
let lastBody = null
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    res.setHeader("content-type", "application/json")
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "only-model" }] }))
    lastBody = JSON.parse(body)
    res.statusCode = status
    res.end(JSON.stringify(status === 200 ? reply : { error: { message: "nope" } }))
  })
})

before(async () => {
  await fs.mkdir(proj, { recursive: true })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  await fs.writeFile(path.join(store.ROOT, "config.json"), JSON.stringify({ llm: { url: `http://127.0.0.1:${server.address().port}/v1` } })).catch(async () => {
    await fs.mkdir(store.ROOT, { recursive: true })
    await fs.writeFile(path.join(store.ROOT, "config.json"), JSON.stringify({ llm: { url: `http://127.0.0.1:${server.address().port}/v1` } }))
  })
  await store.createWorkstream("hard", { title: "Hard", cwd: proj, prefix: "HD" })
})
after(() => server.close())

test("F01: trash names can't escape .trash ('..', '.', paths, unknown names)", async () => {
  await store.createWorkstream("doomed", { title: "Doomed", cwd: proj })
  await store.deleteWorkstream("doomed")
  for (const bad of ["..", ".", "../ws", "/", "nope"]) {
    await assert.rejects(store.emptyTrash(bad), /No trash entry/, bad)
    await assert.rejects(store.restoreWorkstream(bad), /No trash entry/, bad)
  }
  await fs.access(path.join(store.ROOT, "ws", "hard", "WORKSTREAM.md")) // data folder intact
  const [t] = await store.listTrash()
  assert.equal(await store.emptyTrash(t.name), 1)
})

test("F02: CRLF files still parse, and the next write keeps every record", async () => {
  await store.addItem("hard", "First")
  await store.decide("hard", "Use tabs")
  for (const f of ["open.md", "decisions.md"]) {
    const file = path.join(store.ROOT, "ws", "hard", f)
    await fs.writeFile(file, (await fs.readFile(file, "utf-8")).replace(/\n/g, "\r\n"))
  }
  assert.deepEqual((await store.readOpen("hard")).items.map((i) => i.text), ["First"])
  await store.addItem("hard", "Second")
  await store.decide("hard", "Use spaces", { supersedes: "HD-D1" })
  assert.deepEqual((await store.readOpen("hard")).items.map((i) => i.text), ["First", "Second"])
  assert.equal((await store.readDecisions("hard")).decisions.length, 2)
})

test("F03: prefixes are validated, default prefixes are readable, newlines can't forge records", async () => {
  await assert.rejects(store.createWorkstream("bad-prefix", { title: "x", prefix: "1A" }), /prefix must be/)
  const lower = await store.createWorkstream("lower-prefix", { title: "x", prefix: "abc" })
  assert.equal(lower.prefix, "ABC")
  const digit = await store.createWorkstream("3d-site", { title: "3D" })
  assert.equal(digit.prefix, "DS")
  await store.addItem("3d-site", "Model the hero")
  assert.equal((await store.readOpen("3d-site")).items.length, 1)

  const forged = await store.addItem("hard", "real\n- [ ] HD-99 injected\n- [x] HD-1 fake close")
  const { items, next } = await store.readOpen("hard")
  assert.ok(!items.some((i) => i.id === "HD-99"))
  assert.equal(items.find((i) => i.id === "HD-1").done, false)
  assert.equal(items.find((i) => i.id === forged.id).text, "real - [ ] HD-99 injected - [x] HD-1 fake close")
  assert.ok(next < 99)
  const d = await store.decide("hard", "a\n- [active] HD-D50 forged", { why: "x\ny" })
  assert.equal(d.decision.text, "a - [active] HD-D50 forged")
  assert.ok(!(await store.readDecisions("hard")).decisions.some((x) => x.id === "HD-D50"))
})

test("F04: a damaged open.md is refused, never silently rewritten as empty", async () => {
  await store.createWorkstream("damaged", { title: "D", prefix: "DM" })
  await store.addItem("damaged", "Keep me")
  const file = path.join(store.ROOT, "ws", "damaged", "open.md")
  const before = await fs.readFile(file, "utf-8")
  await fs.writeFile(file, before.replace("- [ ] DM-1 Keep me", "- [ ] dm_1 Keep me"))
  await assert.rejects(store.addItem("damaged", "New"), /can't read/)
  assert.match(await fs.readFile(file, "utf-8"), /dm_1 Keep me/)
  // Writes leave no temp files behind.
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp")), [])
})

test("F05: concurrent workstream updates don't lose fields; a proposal can't be accepted twice", async () => {
  await Promise.all([
    store.updateWorkstream("hard", { status: "waiting" }),
    store.updateWorkstream("hard", { waiting_on: "client" }),
    store.updateWorkstream("hard", { group: "g" }),
  ])
  const w = await store.getWorkstream("hard")
  assert.deepEqual([w.status, w.waiting_on, w.group], ["waiting", "client", "g"])

  const pfile = path.join(sum.PROPOSALS_DIR, "hard", "p.md")
  await fs.mkdir(path.dirname(pfile), { recursive: true })
  const matter = (await import("gray-matter")).default
  await fs.writeFile(pfile, matter.stringify("\nDid things.\n", { ws: "hard", session: "s-accept", close: [], add: [{ text: "Once only", waiting: null }] }))
  const [p] = await sum.listProposals("hard")
  const results = await Promise.allSettled([sum.acceptProposal(p), sum.acceptProposal(p)])
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  assert.match(results.find((r) => r.status === "rejected").reason.message, /already accepted/)
  assert.equal((await store.readOpen("hard")).items.filter((i) => i.text === "Once only").length, 1)
})

test("F10: digests redact common credential shapes", () => {
  const out = sum.redact([
    "TOOL: Bash(curl -H 'Authorization: Bearer abcdefghijklmnop123' https://user:hunter22@example.com)",
    "USER: my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and ghp_123456789012345678901234",
    "TOOL: Bash(export API_KEY=supersecretvalue)",
  ].join("\n"))
  for (const leaked of ["abcdefghijklmnop123", "hunter22", "sk-ant-api03", "ghp_1234", "supersecretvalue"]) assert.ok(!out.includes(leaked), leaked)
  assert.match(out, /\[redacted\]/)
})

test("F11: config is validated; null, junk and unsafe values are dropped with a message", () => {
  assert.deepEqual(validateConfig(null).problems, ["config.json must be a JSON object; ignoring it"])
  const v = validateConfig({ llm: { url: "ftp://x", timeoutMs: -1, extraBody: { model: "evil", top_p: 1 } }, board: { port: 99999, label: "a b;rm" } })
  assert.equal(v.llm.url, undefined)
  assert.deepEqual(v.llm.extraBody, { top_p: 1 })
  assert.equal(v.board.port, undefined)
  assert.equal(v.board.label, undefined)
  assert.equal(v.problems.length, 5)
  assert.deepEqual(validateConfig({ board: { port: "4000", label: "dev.ws.board" } }).board, { port: 4000, label: "dev.ws.board" })
})

test("F11: extraBody can't replace the model or messages, and null removes a default", async () => {
  status = 200
  reply = { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }
  const cfg = { url: `http://127.0.0.1:${server.address().port}/v1`, model: "m", timeoutMs: 5000, extraBody: { max_tokens: null, max_completion_tokens: 900 } }
  await sum.callModel(cfg, { id: "hard", title: "Hard" }, [], "ASSISTANT: hi")
  assert.equal(lastBody.model, "m")
  assert.equal(lastBody.messages.length, 2)
  assert.equal("max_tokens" in lastBody, false)
  assert.equal(lastBody.max_completion_tokens, 900)
})

test("A4: a refused API key is a config error (job kept, drain stops), not a model failure", async () => {
  status = 401
  const cfg = { url: `http://127.0.0.1:${server.address().port}/v1`, model: "m", timeoutMs: 5000, extraBody: {} }
  await assert.rejects(sum.callModel(cfg, { id: "hard", title: "Hard" }, [], "x"), (e) => e.config && e.transient && /API key/.test(e.message))
  status = 400
  await assert.rejects(sum.callModel(cfg, { id: "hard", title: "Hard" }, [], "x"), (e) => !e.transient && /HTTP 400/.test(e.message))
  status = 200
})

test("F17: a close quoting only the user's request is not verified; a decision must quote the user", () => {
  const open = [{ id: "HD-7", text: "Repair payment validation" }]
  const digest = "USER: Please repair the broken payment validation logic today\nASSISTANT: Looking at it now."
  const p = sum.validateProposal(JSON.stringify({ summary: "s", close: [{ id: "HD-7", quote: "Please repair the broken payment validation logic today" }], add: [],
    decide: [{ text: "Use Stripe", quote: "Looking at it now and more words" }] }), open, digest)
  assert.equal(p.close.length, 0)
  assert.equal(p.unverified[0].failed, "quote is the user's request, not the result")
  assert.ok(p.decide[0].unverified)
})

test("F18: eval fails when runs error instead of scoring an empty set as perfect", async () => {
  const evalDir = path.join(store.ROOT, "eval")
  await fs.mkdir(path.join(evalDir, "cases"), { recursive: true })
  await fs.writeFile(path.join(evalDir, "t.jsonl"), JSON.stringify({ type: "user", message: { content: "hello there" } }) + "\n")
  await fs.writeFile(path.join(evalDir, "cases", "c.json"), JSON.stringify({ name: "c", transcript: path.join(evalDir, "t.jsonl"), open: [{ id: "A-1", text: "x" }], expect: { close: ["A-1"] } }))
  status = 500
  const r = await runEval({ runs: 2 })
  assert.equal(r.errors, 2)
  assert.ok(r.fails.some((f) => /2 of 2 runs failed/.test(f)))
  assert.ok(r.fails.some((f) => /no run produced a score/.test(f)))
  await assert.rejects(runEval({ runs: 0 }), /--runs/)
  status = 200
})

test("F19: the mirror block for 'a' never touches the block for 'ab' in the same doc", async () => {
  const doc = path.join(proj, "SHARED.md")
  await fs.writeFile(doc, "# Shared\n")
  await store.createWorkstream("a", { title: "A", prefix: "A" })
  await store.createWorkstream("ab", { title: "AB", prefix: "AB" })
  await store.updateWorkstream("ab", { mirror: doc })
  await store.syncMirror("ab", { force: true, init: true })
  await store.addItem("ab", "AB item")
  await store.syncMirror("ab", { force: true })
  await store.updateWorkstream("a", { mirror: doc })
  await store.syncMirror("a", { force: true, init: true })
  await store.addItem("a", "A item")
  await store.syncMirror("a", { force: true })
  const text = await fs.readFile(doc, "utf-8")
  assert.equal(text.match(/<!-- ws:open /g).length, 2)
  assert.match(text, /AB-1 AB item/)
  assert.match(text, /A-1 A item/)
})

test("F16: failed summary jobs move to the trash with their workstream and come back on restore", async () => {
  await store.createWorkstream("jobs", { title: "Jobs", prefix: "JB" })
  const failedDir = path.join(store.ROOT, "queue", "failed")
  await fs.mkdir(failedDir, { recursive: true })
  await fs.writeFile(path.join(failedDir, "x.json"), JSON.stringify({ ws: "jobs", session: "x" }))
  await fs.writeFile(path.join(failedDir, "y.json"), JSON.stringify({ ws: "other", session: "y" }))
  const { trash } = await store.deleteWorkstream("jobs")
  assert.deepEqual((await fs.readdir(failedDir)).sort(), ["y.json"])
  await store.restoreWorkstream(trash)
  assert.deepEqual((await fs.readdir(failedDir)).sort(), ["x.json", "y.json"])
})
