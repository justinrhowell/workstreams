import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import http from "node:http"
import path from "node:path"
import os from "node:os"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-sum-"))
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
const store = await import("../lib/store.mjs")
const sum = await import("../lib/summarize.mjs")
const cap = await import("../lib/capture.mjs")
const { compose } = await import("../lib/compose.mjs")

// Fake OpenAI-compatible endpoint; each test sets `reply`.
let reply = null
let lastBody = null
let lastAuth = null
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    res.setHeader("content-type", "application/json")
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fake-model" }] }))
    lastBody = JSON.parse(body)
    lastAuth = req.headers.authorization || null
    res.end(JSON.stringify(reply))
  })
})
const ok = (content, finish = "stop") => ({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finish }] })

const site = path.join(tmp, "site")
let transcript

before(async () => {
  process.env.WS_TEST_LLM_KEY = "test-key"
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  await fs.mkdir(store.ROOT, { recursive: true })
  await fs.writeFile(path.join(store.ROOT, "config.json"), JSON.stringify({ llm: { url: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "WS_TEST_LLM_KEY", extraBody: { chat_template_kwargs: { enable_thinking: false } } } }))
  await fs.mkdir(site, { recursive: true })
  await store.createWorkstream("site", { title: "Site", cwd: site, prefix: "ST" })
  await store.addItem("site", "Fix the nav")
  await store.addItem("site", "Compress images")
  transcript = path.join(tmp, "t.jsonl")
  const rows = [
    { type: "ai-title", aiTitle: "Nav fix" },
    { type: "user", timestamp: "2099-01-01T10:00:00Z", message: { content: "fix the nav overlap please " + "x".repeat(200) } },
    { type: "assistant", timestamp: "2099-01-01T10:01:00Z", message: { content: [{ type: "text", text: "Fixed z-index in nav.css and verified with a screenshot." }, { type: "tool_use", name: "Edit", input: { file_path: path.join(site, "nav.css") } }] } },
    { type: "user", timestamp: "2099-01-01T10:02:00Z", message: { content: [{ type: "tool_result", content: "SECRET TOOL OUTPUT" }] } },
    { type: "user", timestamp: "2099-01-01T10:03:00Z", message: { content: "great, images later" } },
  ]
  await fs.writeFile(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
})
after(() => server.close())

test("digest keeps prompts, prose and tool names but not tool output", async () => {
  const d = await sum.digestTranscript("claude", transcript)
  assert.match(d, /USER: fix the nav overlap/)
  assert.match(d, /ASSISTANT: Fixed z-index/)
  assert.match(d, /TOOL: Edit\(.*nav\.css\)/)
  assert.doesNotMatch(d, /SECRET TOOL OUTPUT/)
})

test("validation drops unknown or closed IDs, empty evidence and junk", () => {
  const open = [{ id: "ST-1" }, { id: "ST-2" }]
  const p = sum.validateProposal(JSON.stringify({
    summary: "Fixed the nav.",
    close: [{ id: "st-1", evidence: "screenshot" }, { id: "ST-9", evidence: "x" }, { id: "ST-2", evidence: "" }],
    add: [{ text: "Ship images", waiting: "" }, { text: "" }, "nonsense"],
  }), open)
  assert.deepEqual(p.close, [{ id: "ST-1", evidence: "screenshot" }])
  assert.deepEqual(p.add, [{ text: "Ship images", waiting: null }])
  assert.throws(() => sum.validateProposal("not json", open), /not JSON/)
  assert.throws(() => sum.validateProposal('{"summary":""}', open), /empty summary/)
})

test("with a digest, closes need a real quote about that item; restated items are dropped", () => {
  const open = [{ id: "BA-1", text: "Generator david.html card() still draws the old frame" }, { id: "BA-2", text: "The chef-led tastings tag shape has not been refined" }]
  const digest = "ASSISTANT: Rebuilt the barrel frame with true offsets and verified with measurements at 400%.\nASSISTANT: Updated david.html card() to draw the new frame and re-rendered all posts."
  const p = sum.validateProposal(JSON.stringify({
    summary: "Rebuilt the frame.",
    close: [
      { id: "BA-2", quote: "Rebuilt the barrel frame with true offsets", why: "shape refined" }, // wrong item
      { id: "BA-1", quote: "this text is not in the transcript at all", why: "frame" }, // invented quote
      { id: "BA-1", quote: "Updated david.html card() to draw the new frame", why: "generator fixed" },
    ],
    add: [{ text: "Update david.html card() to use the new frame" }, { text: "Re-export the Drive editables" }],
  }), open, digest)
  assert.deepEqual(p.close.map((c) => c.id), ["BA-1"])
  assert.deepEqual(p.unverified.map((u) => [u.id, u.failed]), [["BA-2", "quote is about something else"], ["BA-1", "quote not found in the session"]])
  assert.deepEqual(p.add.map((a) => a.text), ["Re-export the Drive editables"])
})

test("a hook-only session is queued; drain writes a proposal and leaves open.md alone", async () => {
  const r = await cap.captureSession({ tool: "claude", session_id: "sess-aaaa-1111-2222-333344445555", transcript_path: transcript, cwd: site })
  assert.equal(r.action, "linked")
  assert.equal((await sum.listQueue()).length, 1)

  reply = ok({ summary: "Fixed the nav overlap in nav.css. Images deferred.", close: [{ id: "ST-1", quote: "Fixed z-index in nav.css and verified with a screenshot", why: "nav fixed" }], add: [{ text: "Write release notes", waiting: null }] })
  const res = await sum.drain()
  assert.deepEqual([res.done, res.failed], [1, 0])
  assert.equal(lastBody.model, "fake-model")
  assert.equal(lastBody.chat_template_kwargs.enable_thinking, false) // from llm.extraBody
  assert.equal(lastAuth, "Bearer test-key") // from the env var named by llm.apiKeyEnv
  assert.equal((await sum.listQueue()).length, 0)

  const props = await sum.listProposals()
  assert.equal(props.length, 1)
  assert.equal((await store.readOpen("site")).items.filter((i) => i.done).length, 0) // nothing applied yet

  const { text } = await compose("site")
  assert.match(text, /Unreviewed machine summary: Fixed the nav overlap/)
  assert.doesNotMatch(text, /Last session \(.*\): Fixed the nav overlap/)
})

test("accept applies items and rewrites the session's own stub", async () => {
  const [p] = await sum.listProposals()
  const r = await sum.acceptProposal(p)
  assert.deepEqual(r.closed, ["ST-1"])
  assert.equal(r.added.length, 1)
  const w = await store.getWorkstream("site")
  const log = w.logs.find((l) => l.session === p.session)
  assert.equal(log.summary, "Fixed the nav overlap in nav.css. Images deferred.")
  assert.equal(log.source, "hook+model")
  assert.equal((await sum.listProposals()).length, 0)
  const { text } = await compose("site")
  assert.match(text, /Last session \(.*\): Fixed the nav overlap/)
})

test("a quote copied from the item text is unverified, and applies only when the reviewer ticks it", async () => {
  const open = [{ id: "ST-9", text: "Create notes.txt with three bullet ideas for a launch email" }]
  const digest = "USER: Create notes.txt with three bullet ideas for a launch email\nASSISTANT: I created notes.txt and read it back."
  const p = sum.validateProposal(JSON.stringify({ summary: "Made notes.", close: [{ id: "ST-9", quote: "Create notes.txt with three bullet ideas for a launch email", why: "file created" }], add: [] }), open, digest)
  assert.equal(p.close.length, 0)
  assert.deepEqual(p.unverified.map((u) => u.failed), ["quote is the user's request, not the result"])
})

test("accepting never overwrites notes someone wrote", async () => {
  const file = await store.appendLog("site", { summary: "Hand-written notes.", session: "sess-dddd-1111-2222-333344447777" })
  const pfile = path.join(sum.PROPOSALS_DIR, "site", "x.md")
  await fs.mkdir(path.dirname(pfile), { recursive: true })
  const matter = (await import("gray-matter")).default
  await fs.writeFile(pfile, matter.stringify("\nModel text.\n", { ws: "site", session: "sess-dddd-1111-2222-333344447777", log: file, close: [], add: [] }))
  const [p] = (await sum.listProposals("site")).filter((x) => x.session.startsWith("sess-dddd"))
  const r = await sum.acceptProposal(p)
  assert.match(r.skipped.join(), /already has notes/)
  assert.match(await fs.readFile(file, "utf-8"), /Hand-written notes\./)
})

test("a truncated or failed model reply keeps the job queued for retry", async () => {
  await sum.enqueue({ ws: "site", session: "sess-bbbb-1111-2222-333344446666", tool: "claude", transcript, log: null })
  reply = ok("{\"summary\": \"half", "length")
  let res = await sum.drain()
  assert.deepEqual([res.done, res.failed], [0, 1])
  let [job] = await sum.listQueue()
  assert.equal(job.attempts, 1)
  assert.match(job.lastError, /finish_reason length/)
  reply = { error: { message: "model loading" } }
  res = await sum.drain()
  ;[job] = await sum.listQueue()
  assert.equal(job.attempts, 1) // endpoint trouble doesn't count against the job
  reply = ok({ summary: "Done.", close: [], add: [] })
  res = await sum.drain()
  assert.equal(res.done, 1)
})

test("an unreachable endpoint leaves the queue and attempts untouched", async () => {
  await sum.enqueue({ ws: "site", session: "sess-eeee-1111-2222-333344448888", tool: "claude", transcript, log: null })
  const cfgFile = path.join(store.ROOT, "config.json")
  const saved = await fs.readFile(cfgFile, "utf-8")
  await fs.writeFile(cfgFile, JSON.stringify({ llm: { url: "http://127.0.0.1:9/v1" } }))
  for (let i = 0; i < 6; i++) {
    const r = await sum.drain()
    assert.match(r.note, /unreachable/)
  }
  await fs.writeFile(cfgFile, saved)
  const [job] = (await sum.listQueue()).filter((j) => j.session.startsWith("sess-eeee"))
  assert.equal(job.attempts, 0)
  assert.equal((await sum.listFailed()).length, 0)
  // A "model loading" reply is transient too: no attempt charged.
  reply = { error: { message: "model loading" } }
  await sum.drain()
  assert.equal((await sum.listQueue()).find((j) => j.session.startsWith("sess-eeee")).attempts, 0)
  reply = ok({ summary: "Done.", close: [], add: [] })
  await sum.drain()
})

test("unverified closes apply only when confirmed by ID", async () => {
  const id = (await store.addItem("site", "Write the launch email")).id
  const file = await store.appendLog("site", { summary: "(auto) Untitled", session: "sess-ffff-1", source: "hook" })
  const pfile = path.join(sum.PROPOSALS_DIR, "site", "u.md")
  const matter = (await import("gray-matter")).default
  const mk = () => fs.writeFile(pfile, matter.stringify("\nWrote it.\n", { ws: "site", session: "sess-ffff-1", log: file, close: [], add: [], unverified: [{ id, evidence: "wrote email", failed: "quote copies the item text" }] }))
  await mk()
  let [p] = (await sum.listProposals("site")).filter((x) => x.session === "sess-ffff-1")
  await sum.acceptProposal(p)
  assert.equal((await store.readOpen("site")).items.find((i) => i.id === id).done, false)
  await mk()
  ;[p] = (await sum.listProposals("site")).filter((x) => x.session === "sess-ffff-1")
  const r = await sum.acceptProposal(p, { unverified: [id] })
  assert.deepEqual(r.closed, [id])
  assert.match((await store.readOpen("site")).items.find((i) => i.id === id).closed, /reviewer confirmed/)
})

test("sessions that logged their own notes are not queued", async () => {
  await store.appendLog("site", { summary: "I did it myself." })
  const before = (await sum.listQueue()).length
  const t2 = path.join(tmp, "t2.jsonl")
  const now = new Date(Date.now() - 30_000).toISOString()
  await fs.writeFile(t2, [
    { type: "user", timestamp: now, message: { content: "a" } },
    { type: "user", timestamp: now, message: { content: "b" } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n")
  const r = await cap.captureSession({ tool: "claude", session_id: "sess-cccc-1", transcript_path: t2, cwd: site })
  assert.equal(r.action, "adopted")
  assert.equal((await sum.listQueue()).length, before)
})

test("staleness counts from the newest session end, not file edits", async () => {
  await store.createWorkstream("old", { title: "Old", cwd: path.join(tmp, "old") })
  await store.appendLog("old", { summary: "long ago", ended: "2020-01-01T00:00:00Z" })
  await store.updateWorkstream("old", { status: "active" }) // touching the file must not reset it
  const w = await store.getWorkstream("old")
  assert.equal(new Date(w.lastActivity).toISOString(), "2020-01-01T00:00:00.000Z")
})

test("eval scoring: false verified closes and recall are counted per case", async () => {
  const ev = await import("../lib/eval.mjs")
  const c = { expect: { close: ["A-1", "A-2"] } }
  const r1 = ev.scoreRun(c, { close: [{ id: "A-1" }, { id: "A-3" }], unverified: [{ id: "A-2" }] })
  assert.deepEqual([r1.tpVerified, r1.fpVerified, r1.tpUnverified], [1, ["A-3"], 1])
  const m = ev.aggregate([r1, ev.scoreRun(c, { close: [], unverified: [] })])
  assert.equal(m.verified_precision, 0.5)
  assert.equal(m.recall_any, 0.5)
  assert.deepEqual(ev.checkFloors(m, ev.DEFAULT_FLOORS), ["verified precision 0.50 < 1", "1 false verified closes > 0"])
})
