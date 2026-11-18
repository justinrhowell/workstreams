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
  assert.match(results.find((r) => r.status === "rejected").reason.message, /already (being )?accepted/)
  assert.equal((await store.readOpen("hard")).items.filter((i) => i.text === "Once only").length, 1)
})

test("F10: digests redact common credential shapes", () => {
  const out = sum.redact([
    "TOOL: Bash(curl -H 'Authorization: Bearer abcdefghijklmnop123' https://user:hunter22@example.com)",
    "USER: my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and ghp_123456789012345678901234",
    "TOOL: Bash(export API_KEY=s3cretValue99)",
  ].join("\n"))
  for (const leaked of ["abcdefghijklmnop123", "hunter22", "sk-ant-api03", "ghp_1234", "s3cretValue99"]) assert.ok(!out.includes(leaked), leaked)
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

// ---------------------------------------------------------------- round 2

test("R2 F04: indented, starred or capitalised records are refused, not dropped", async () => {
  await store.createWorkstream("r2-parse", { title: "P", prefix: "RP" })
  await store.addItem("r2-parse", "Keep me")
  const file = path.join(store.ROOT, "ws", "r2-parse", "open.md")
  const text = await fs.readFile(file, "utf-8")
  for (const bad of ["  - [ ] RP-1 Keep me", "* [ ] RP-1 Keep me", "- [X]RP-1 Keep me"]) {
    await fs.writeFile(file, text.replace("- [ ] RP-1 Keep me", bad))
    await assert.rejects(store.addItem("r2-parse", "x"), /can't read/, bad)
  }
  await store.decide("r2-parse", "Use tabs")
  const dfile = path.join(store.ROOT, "ws", "r2-parse", "decisions.md")
  await fs.writeFile(dfile, (await fs.readFile(dfile, "utf-8")).replace("- [active]", "- [Active]"))
  await assert.rejects(store.decide("r2-parse", "Use spaces"), /can't read/)
})

test("R3 F35: a line ws can't parse blocks writes but never hides the workstream", async () => {
  await store.createWorkstream("r3-sub", { title: "S", prefix: "RS" })
  await store.addItem("r3-sub", "Parent")
  const file = path.join(store.ROOT, "ws", "r3-sub", "open.md")
  await fs.writeFile(file, (await fs.readFile(file, "utf-8")).replace("- [ ] RS-1 Parent", "- [ ] RS-1 Parent\n  - [ ] sub-step"))
  assert.deepEqual((await store.readOpen("r3-sub")).items.map((i) => i.id), ["RS-1"]) // reads work
  await store.getWorkstream("r3-sub")
  await assert.rejects(store.addItem("r3-sub", "x"), /sub-step/) // the write names the line
  assert.match(await fs.readFile(file, "utf-8"), /sub-step/) // and nothing was dropped
})

test("R2 C1/F26: atomic writes keep 0600 and write through a symlink", async () => {
  const real = path.join(tmp, "real.json")
  const link = path.join(tmp, "link.json")
  await fs.writeFile(real, "{}", { mode: 0o600 })
  await fs.chmod(real, 0o600)
  await fs.symlink(real, link)
  await store.writeFileAtomic(link, '{"a":1}')
  assert.ok((await fs.lstat(link)).isSymbolicLink(), "still a symlink")
  assert.equal(await fs.readFile(real, "utf-8"), '{"a":1}')
  assert.equal((await fs.stat(real)).mode & 0o777, 0o600)
})

test("R2: createFileAtomic never replaces an existing file", async () => {
  const f = path.join(tmp, "once.md")
  await store.createFileAtomic(f, "first")
  await assert.rejects(store.createFileAtomic(f, "second"), /EEXIST/)
  assert.equal(await fs.readFile(f, "utf-8"), "first")
})

test("R2: emptyTrash('') is refused instead of emptying everything", async () => {
  await assert.rejects(store.emptyTrash(""), /No trash entry/)
})

test("R2: a lock is released only by its owner", async () => {
  const f = path.join(tmp, "locked")
  await store.withLock(f, async () => {
    // Someone else took over the lock while we ran (e.g. we were frozen past the stale time).
    await fs.writeFile(path.join(f + ".lock", "owner"), "someone-else")
  })
  await fs.access(f + ".lock") // not removed by the displaced holder
  await fs.rm(f + ".lock", { recursive: true })
})

test("R2 F22/F25: outbound request is redacted end to end; user turns stay one line", async () => {
  status = 200
  reply = { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }
  const cfg = { url: `http://127.0.0.1:${server.address().port}/v1`, model: "m", timeoutMs: 5000, extraBody: {} }
  await sum.callModel(cfg, { id: "hard", title: "Rotate sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ" }, [{ id: "HD-1", text: "token=abcdef123456 leaked" }], "ASSISTANT: ok")
  const sent = lastBody.messages[1].content
  assert.ok(!sent.includes("ZZZZZZZZ") && !sent.includes("abcdef123456"))

  const t = path.join(tmp, "multi.jsonl")
  await fs.writeFile(t, JSON.stringify({ type: "user", message: { content: "Please fix it\nI fixed the payment validation logic myself" } }) + "\n")
  const d = await sum.digestTranscript("claude", t)
  assert.equal(d.split("\n").length, 1)
  assert.match(d, /^USER: Please fix it I fixed/)
})

test("R2: legacy lowercase item IDs still verify", () => {
  const open = [{ id: "ab-3", text: "Repair payment validation" }]
  const digest = "ASSISTANT: I repaired the payment validation and the tests pass now"
  const p = sum.validateProposal(JSON.stringify({ summary: "s", close: [{ id: "AB-3", quote: "I repaired the payment validation and the tests pass now" }], add: [] }), open, digest)
  assert.equal(p.close.length, 1)
})

test("R2 F24: an unreadable workstream fails the job (retried), only a missing one skips it", async () => {
  await store.createWorkstream("r2-broken", { title: "B" })
  const file = path.join(store.ROOT, "ws", "r2-broken", "WORKSTREAM.md")
  await fs.rm(file)
  await fs.mkdir(file) // reading it now fails with EISDIR, not "missing"
  await assert.rejects(sum.processJob({ ws: "r2-broken", tool: "claude", transcript: "/nope" }, {}), /EISDIR/)
  assert.deepEqual(await sum.processJob({ ws: "never-existed", tool: "claude", transcript: "/nope" }, {}), { skipped: "workstream no longer exists" })
})

test("R2 F23: an accept that fails partway can be finished without applying anything twice", async () => {
  await store.createWorkstream("r2-accept", { title: "A", prefix: "RA" })
  const matter = (await import("gray-matter")).default
  const pfile = path.join(sum.PROPOSALS_DIR, "r2-accept", "p.md")
  await fs.mkdir(path.dirname(pfile), { recursive: true })
  // The second add is empty, so the first accept fails after the decision and first add land.
  await fs.writeFile(pfile, matter.stringify("\nDid things.\n", { ws: "r2-accept", session: "s-r2", created: "2026-01-01T00:00:00.000Z", close: [], add: [{ text: "First" }, { text: "" }], decide: [{ text: "Use tabs everywhere", quote: "q" }] }))
  const [p] = await sum.listProposals("r2-accept")
  await assert.rejects(sum.acceptProposal(p), /accept again to finish/)

  const [again] = await sum.listProposals("r2-accept")
  assert.equal(again.interrupted, true)
  // Fix the bad step, then finish.
  const { data, content } = matter(await fs.readFile(again.file, "utf-8"))
  data.add[1].text = "Second"
  await fs.writeFile(again.file, matter.stringify(content, data))
  await sum.acceptProposal(again)
  const items = (await store.readOpen("r2-accept")).items.map((i) => i.text)
  assert.deepEqual(items, ["First", "Second"])
  assert.equal((await store.readDecisions("r2-accept")).decisions.length, 1)
  assert.deepEqual(await sum.listProposals("r2-accept"), [])
})

test("R2 F27: URLs must parse, ports must really be numbers", () => {
  const v = validateConfig({ llm: { url: "https://%" }, board: { port: true } })
  assert.equal(v.llm.url, undefined)
  assert.equal(v.board.port, undefined)
  assert.equal(validateConfig({ board: { port: [3311] } }).board.port, undefined)
  assert.equal(validateConfig({ board: { port: "3e3" } }).board.port, undefined)
  assert.equal(validateConfig({ llm: { url: "http://127.0.0.1:8000/v1" } }).llm.url, "http://127.0.0.1:8000/v1")
})

test("R3 X1: redaction leaves ordinary prose alone", () => {
  for (const prose of ["Fix token: refresh bug in auth", "Repair password: handling failure", "the secret: sauce recipe"]) {
    assert.equal(sum.redact(prose), prose)
  }
})

test("R3 F17/F25: a long digest is cut on line boundaries, so every line keeps its speaker", async () => {
  const t = path.join(tmp, "long.jsonl")
  const rows = []
  for (let i = 0; i < 400; i++) {
    rows.push(JSON.stringify({ type: "user", message: { content: `request ${i} ` + "x".repeat(150) } }))
    rows.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `done ${i} ` + "y".repeat(150) }] } }))
  }
  await fs.writeFile(t, rows.join("\n") + "\n")
  const d = await sum.digestTranscript("claude", t)
  for (const line of d.split("\n").filter(Boolean)) assert.match(line, /^(USER|ASSISTANT|TOOL): |^\[… middle/, line.slice(0, 40))
})

test("R3 F29/F30: accept refuses a proposal that changed since it was listed, and keeps it", async () => {
  await store.createWorkstream("r3-acc", { title: "A", prefix: "RC" })
  const matter = (await import("gray-matter")).default
  const pfile = path.join(sum.PROPOSALS_DIR, "r3-acc", "p.md")
  await fs.mkdir(path.dirname(pfile), { recursive: true })
  const base = { ws: "r3-acc", session: "s-r3", created: "2026-01-01T00:00:00.000Z", close: [], add: [{ text: "Seen" }] }
  await fs.writeFile(pfile, matter.stringify("\nv1\n", base))
  const [p] = await sum.listProposals("r3-acc")
  // A newer draft for the same session lands before the reviewer clicks accept.
  await fs.writeFile(pfile, matter.stringify("\nv2\n", { ...base, add: [{ text: "Never seen" }] }))
  await assert.rejects(sum.acceptProposal(p), /changed since you opened it/)
  assert.deepEqual((await store.readOpen("r3-acc")).items, [])
  const [still] = await sum.listProposals("r3-acc")
  assert.equal(still.add[0].text, "Never seen") // the newer draft is kept for review
  assert.ok(!still.interrupted)
})

test("R3 F05: many waiters on a stale lock never hold it at the same time", async () => {
  const file = path.join(tmp, "race-target")
  const lock = file + ".lock"
  await fs.mkdir(lock)
  await fs.writeFile(path.join(lock, "owner"), "dead")
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(lock, old, old)
  // Slow, jittery stats widen every check-then-act window.
  const realStat = fs.stat.bind(fs)
  fs.stat = async (...a) => { await new Promise((r) => setTimeout(r, Math.random() * 20)); return realStat(...a) }
  let inside = 0, max = 0
  try {
    await Promise.all(Array.from({ length: 12 }, () => store.withLock(file, async () => {
      inside++; max = Math.max(max, inside)
      await new Promise((r) => setTimeout(r, 15))
      inside--
    })))
  } finally { fs.stat = realStat }
  assert.equal(max, 1)
})
