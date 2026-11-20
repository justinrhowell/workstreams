// Fixes from the cross-model (Codex) end-to-end review of v0.2.1.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import http from "node:http"
import path from "node:path"
import matter from "gray-matter"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-r5-")
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const sum = await import("../lib/summarize.mjs")
const BIN = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))

const site = path.join(tmp, "site")
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"

// Fake OpenAI-compatible endpoint. `onChat` runs before each chat reply.
let onChat = async () => {}
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", async () => {
    res.setHeader("content-type", "application/json")
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fake-model" }] }))
    await onChat(JSON.parse(body))
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Did the work.", close: [], add: [] }) }, finish_reason: "stop" }] }))
  })
})

async function transcript(name) {
  const p = path.join(tmp, `${name}.jsonl`)
  await fs.writeFile(p, jl(
    { type: "user", timestamp: "2099-01-01T10:00:00Z", message: { content: `please do the thing ${name} ` + "x".repeat(250) } },
    { type: "assistant", timestamp: "2099-01-01T10:01:00Z", message: { content: [{ type: "text", text: "Done and verified." }] } },
  ))
  return p
}

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  await fs.mkdir(site, { recursive: true })
  await fs.mkdir(store.ROOT, { recursive: true })
  await fs.writeFile(path.join(store.ROOT, "config.json"), JSON.stringify({ llm: { url: `http://127.0.0.1:${server.address().port}/v1` } }))
  await store.createWorkstream("site", { title: "Site", cwd: site, prefix: "ST" })
})
after(() => server.close())

// ------------------------------------------------------------------ F05

test("F05: two creates of one id at once: exactly one wins, and its fields survive", async () => {
  const r = await Promise.allSettled([1, 2, 3, 4].map((n) => store.createWorkstream("race", { title: `Creator ${n}`, cwd: site })))
  const won = r.filter((x) => x.status === "fulfilled")
  assert.equal(won.length, 1)
  for (const x of r.filter((x) => x.status === "rejected")) assert.match(x.reason.message, /already exists/)
  assert.equal((await store.getWorkstream("race")).title, won[0].value.title)
})

// ------------------------------------------------------------------ F03

test("F03: delete writes the trash entry's metadata before moving anything", async () => {
  await store.createWorkstream("del-a", { title: "Delete A", cwd: site })
  const { trash } = await store.deleteWorkstream("del-a")
  const meta = JSON.parse(await fs.readFile(path.join(store.TRASH_DIR, trash, "TRASHED.json"), "utf-8"))
  assert.equal(meta.id, "del-a")
  // A delete cut short after the folder moved (no TRASHED.json yet, as older versions could
  // leave) is still restorable: the id comes from the entry name.
  await fs.rm(path.join(store.TRASH_DIR, trash, "TRASHED.json"))
  assert.equal((await store.restoreWorkstream(trash)).id, "del-a")
  await store.getWorkstream("del-a")
})

test("F03: a restore interrupted after moving the workstream finishes on the next try", async () => {
  await store.createWorkstream("del-b", { title: "Delete B", cwd: site })
  const pdir = path.join(sum.PROPOSALS_DIR, "del-b")
  await fs.mkdir(pdir, { recursive: true })
  await fs.writeFile(path.join(pdir, "s1.md"), matter.stringify("\nx\n", { ws: "del-b", session: "s1" }))
  const { trash } = await store.deleteWorkstream("del-b")
  // Simulate the interruption: the workstream folder made it back, the drafts didn't.
  await fs.rename(path.join(store.TRASH_DIR, trash, "ws"), path.join(store.WS_DIR, "del-b"))
  assert.equal((await store.restoreWorkstream(trash)).id, "del-b")
  await fs.access(path.join(pdir, "s1.md"))
  assert.ok(!(await store.listTrash()).some((t) => t.name === trash), "the finished entry is removed")
  // An entry with nothing left to move still says so.
  await fs.rm(pdir, { recursive: true })
  const { trash: t2 } = await store.deleteWorkstream("del-b")
  await fs.rename(path.join(store.TRASH_DIR, t2, "ws"), path.join(store.WS_DIR, "del-b"))
  await assert.rejects(store.restoreWorkstream(t2), /Nothing to restore/)
})

// ------------------------------------------------------------------ F04

test("F04: two assigns of one inbox row at once log the session exactly once", async () => {
  await store.createWorkstream("other", { title: "Other", cwd: path.join(tmp, "elsewhere") })
  const file = path.join(cap.INBOX_DIR, "2026-11-20_claude_inboxrow.md")
  await fs.mkdir(cap.INBOX_DIR, { recursive: true })
  await fs.writeFile(file, matter.stringify("\nA session\n", { session: "inbox-row-1", tool: "claude", title: "A session", ended: "2026-11-20T10:00:00Z" }))
  const [row] = (await cap.listInbox()).filter((r) => r.session === "inbox-row-1")
  const r = await Promise.allSettled([cap.assignInbox(row, "site", "Did a thing."), cap.assignInbox(row, "other", "Did a thing.")])
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1)
  assert.match(r.find((x) => x.status === "rejected").reason.message, /already handled/)
  const logged = [...(await store.getWorkstream("site")).logs, ...(await store.getWorkstream("other")).logs].filter((l) => l.session === "inbox-row-1")
  assert.equal(logged.length, 1)
  assert.equal((await cap.listInbox()).filter((x) => x.session === "inbox-row-1").length, 0)
})

test("F04: a failed assign leaves the row in the inbox", async () => {
  const file = path.join(cap.INBOX_DIR, "2026-11-20_claude_inboxrow2.md")
  await fs.writeFile(file, matter.stringify("\nB\n", { session: "inbox-row-2", tool: "claude", title: "B", ended: "2026-11-20T10:00:00Z" }))
  const [row] = (await cap.listInbox()).filter((r) => r.session === "inbox-row-2")
  // A read-only log folder makes the log write fail.
  const logDir = path.join(store.WS_DIR, "other", "log")
  await fs.chmod(logDir, 0o500)
  try {
    if (process.getuid?.() === 0) return // root ignores the permission; nothing to check
    await assert.rejects(cap.assignInbox(row, "other", "x"))
  } finally { await fs.chmod(logDir, 0o755) }
  assert.equal((await cap.listInbox()).filter((x) => x.session === "inbox-row-2").length, 1)
})

// ------------------------------------------------------------------ F02

async function draft(session, fields) {
  const log = await store.appendLog("site", { summary: "(auto) untitled", session, source: "hook" })
  const pfile = path.join(sum.PROPOSALS_DIR, "site", `${session}.md`)
  await fs.mkdir(path.dirname(pfile), { recursive: true })
  await fs.writeFile(pfile, matter.stringify("\nModel summary.\n", { ws: "site", session, log, model: "m", created: new Date().toISOString(), close: [], add: [], unverified: [], decide: [], ...fields }))
  return (await sum.listProposals("site")).find((p) => p.session === session)
}

test("F02: a step that fails for a real reason stops the accept and keeps the draft", async () => {
  const p = await draft("acc-1", { decide: [{ text: "Use the blue logo everywhere", why: "brand", rejected: [] }] })
  const dfile = path.join(store.WS_DIR, "site", "decisions.md")
  await fs.writeFile(dfile, "# Decisions: Site\n\n* [active] hand-written line ws can't parse\n")
  await assert.rejects(sum.acceptProposal(p), /can't read[\s\S]*accept again/)
  const left = (await sum.listProposals("site")).find((x) => x.session === "acc-1")
  assert.ok(left?.interrupted, "the draft is kept for another try")
  // Fixed by hand, the second accept finishes the step.
  await fs.writeFile(dfile, "# Decisions: Site\n")
  const r = await sum.acceptProposal(left)
  assert.equal(r.decided.length, 1)
  assert.ok(!(await sum.listProposals("site")).some((x) => x.session === "acc-1"))
})

test("F02: a step made moot meanwhile (item already closed) is skipped and reported", async () => {
  const item = await store.addItem("site", "Ship the footer")
  await store.closeItem("site", item.id)
  const p = await draft("acc-2", { close: [{ id: item.id, evidence: "shipped" }] })
  const r = await sum.acceptProposal(p)
  assert.deepEqual(r.closed, [])
  assert.match(r.skipped.join(";"), /already closed/)
})

// ------------------------------------------------------------------ F01

test("F01: the fingerprint changes whenever the draft does", async () => {
  const p = await draft("fp-1", { add: [{ text: "Add a sitemap", waiting: null }] })
  const q = await draft("fp-1", { add: [{ text: "Add a robots.txt", waiting: null }] })
  assert.notEqual(sum.proposalFingerprint(p), sum.proposalFingerprint(q))
  assert.equal(sum.proposalFingerprint(q), sum.proposalFingerprint((await sum.listProposals("site")).find((x) => x.session === "fp-1")))
  await sum.rejectProposal(q)
})

// ------------------------------------------------------------------ F09

test("F09: a damaged draft or an empty claim never takes down the listing", async () => {
  const dir = path.join(sum.PROPOSALS_DIR, "site")
  await fs.writeFile(path.join(dir, "bad.md"), "---\nws: [unclosed\n---\nx\n")
  await fs.writeFile(path.join(dir, "nofields.md"), "---\nmodel: m\n---\nx\n")
  const good = await draft("ok-1", {})
  await fs.writeFile(`${good.file}.accepting`, "") // an accept reserving its name
  const broken = []
  const list = await sum.listProposals(undefined, { broken })
  assert.deepEqual(list.filter((p) => p.session === "ok-1").map((p) => !!p.interrupted), [false])
  assert.deepEqual(broken.map((b) => b.id).sort(), ["proposals/site/bad.md", "proposals/site/nofields.md"])
  // Such an empty claim (left by an older version) doesn't block accepting the draft.
  const r = await sum.acceptProposal(good)
  assert.deepEqual(r.skipped, [])
  for (const f of ["bad.md", "nofields.md"]) await fs.rm(path.join(dir, f))
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.startsWith("ok-1")), [])
})

// ------------------------------------------------------------------ F08

test("F08: a job queued while a drain runs is drafted by that drain", async () => {
  const log1 = await store.appendLog("site", { summary: "(auto) one", session: "drain-1", source: "hook" })
  const log2 = await store.appendLog("site", { summary: "(auto) two", session: "drain-2", source: "hook" })
  await sum.enqueue({ ws: "site", session: "drain-1", tool: "claude", transcript: await transcript("d1"), log: log1 })
  const t2 = await transcript("d2")
  let queuedSecond = false
  onChat = async () => {
    // The second session ends mid-drain; its own drain would find the lock taken and leave.
    if (!queuedSecond) { queuedSecond = true; await sum.enqueue({ ws: "site", session: "drain-2", tool: "claude", transcript: t2, log: log2 }) }
  }
  try {
    const r = await sum.drain()
    assert.equal(r.done, 2)
  } finally { onChat = async () => {} }
  assert.equal((await sum.listQueue()).length, 0)
  const drafted = (await sum.listProposals("site")).map((p) => p.session)
  assert.ok(drafted.includes("drain-1") && drafted.includes("drain-2"))
})

// ------------------------------------------------------------- F10, F15

test("F10/F15: ws go keeps the prompt private, cleans up, and fails loudly when the tool can't start", async () => {
  const tmpdir = path.join(tmp, "go-tmp")
  await fs.mkdir(tmpdir, { recursive: true })
  const seen = path.join(tmp, "go-seen.json")
  // An "editor" that records the file's and folder's permissions and leaves the text as is.
  const ed = path.join(tmp, "record-editor.mjs")
  await fs.writeFile(ed, `import fs from "node:fs"; import path from "node:path"; const f = process.argv.at(-1);
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ file: fs.statSync(f).mode & 0o777, dir: fs.statSync(path.dirname(f)).mode & 0o777 }))`)
  const env = { ...process.env, TMPDIR: tmpdir, EDITOR: `"${process.execPath}" "${ed}"`, VISUAL: "", PATH: "/usr/bin:/bin" }
  const r = spawnSync(process.execPath, [BIN, "go", "site", "--claude"], { env, encoding: "utf-8", input: "" })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /Couldn't start claude: it isn't on your PATH/)
  const modes = JSON.parse(await fs.readFile(seen, "utf-8"))
  assert.equal(modes.file, 0o600)
  assert.equal(modes.dir, 0o700)
  assert.deepEqual((await fs.readdir(tmpdir)).filter((f) => f.startsWith("ws-go-")), [], "the prompt folder is removed")
  // An editor that fails also leaves nothing behind.
  const r2 = spawnSync(process.execPath, [BIN, "go", "site", "--claude"], { env: { ...env, EDITOR: "false" }, encoding: "utf-8", input: "" })
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /editor exited/)
  assert.deepEqual((await fs.readdir(tmpdir)).filter((f) => f.startsWith("ws-go-")), [])
})

// ------------------------------------------------------------------ round 2

test("F02 (round 2): a parse error that quotes 'is already closed' still stops the accept", async () => {
  const item = await store.addItem("site", "Archive old pages")
  const p = await draft("acc-3", { close: [{ id: item.id, item: item.text, evidence: "archived" }] })
  const ofile = path.join(store.WS_DIR, "site", "open.md")
  const before = await fs.readFile(ofile, "utf-8")
  // A hand-written line ws can't parse, whose text happens to read like a conflict.
  await fs.writeFile(ofile, before + "\n* [ ] ST-77 Check whether the account is already closed\n")
  try {
    await assert.rejects(sum.acceptProposal(p), /can't read/)
    assert.ok((await sum.listProposals("site")).find((x) => x.session === "acc-3")?.interrupted, "the draft is kept")
  } finally { await fs.writeFile(ofile, before) }
  const r = await sum.acceptProposal((await sum.listProposals("site")).find((x) => x.session === "acc-3"))
  assert.deepEqual(r.closed, [item.id])
})

test("F17: an item reworded after the draft is left open, and the skip says why", async () => {
  const item = await store.addItem("site", "Fix mobile navigation")
  const p = await draft("acc-4", { close: [{ id: item.id, item: "Fix mobile navigation", evidence: "fixed on phones" }] })
  await store.editItem("site", item.id, { text: "Fix mobile and tablet navigation" })
  const r = await sum.acceptProposal(p)
  assert.deepEqual(r.closed, [])
  assert.match(r.skipped.join(";"), /reworded since the draft/)
  assert.equal((await store.readOpen("site")).items.find((i) => i.id === item.id).done, false)
})

test("F17: drafted closes record the item text the model saw", () => {
  const open = [{ id: "ST-1", text: "Fix the nav overlap" }]
  const digest = "ASSISTANT: Fixed the nav overlap on mobile and verified it with a screenshot."
  const p = sum.validateProposal(JSON.stringify({ summary: "x", close: [{ id: "ST-1", quote: "Fixed the nav overlap on mobile and verified it", why: "w" }] }), open, digest)
  assert.equal(p.close[0]?.item, "Fix the nav overlap")
})

test("F18: an assign interrupted after logging leaves the row; assigning again doesn't log twice", async () => {
  const file = path.join(cap.INBOX_DIR, "2026-11-20_claude_inboxrow3.md")
  await fs.writeFile(file, matter.stringify("\nC\n", { session: "inbox-row-3", tool: "claude", title: "C", ended: "2026-11-20T10:00:00Z" }))
  const [row] = (await cap.listInbox()).filter((r) => r.session === "inbox-row-3")
  // The first attempt logged the session and then died before removing the row.
  const first = await store.appendLog("site", { session: "inbox-row-3", tool: "claude", ended: "2026-11-20T10:00:00Z", source: "inbox+manual", summary: "First try." })
  assert.equal((await cap.listInbox()).filter((x) => x.session === "inbox-row-3").length, 1, "the row is still there")
  assert.equal(await cap.assignInbox(row, "site", "First try."), first)
  assert.equal((await store.getWorkstream("site")).logs.filter((l) => l.session === "inbox-row-3").length, 1)
  assert.equal((await cap.listInbox()).filter((x) => x.session === "inbox-row-3").length, 0)
})

test("F09 (round 2): a draft whose lists aren't lists of entries is reported, not rendered", async () => {
  const dir = path.join(sum.PROPOSALS_DIR, "site")
  await fs.writeFile(path.join(dir, "shape1.md"), matter.stringify("\nx\n", { ws: "site", session: "shape-1", unverified: "oops" }))
  await fs.writeFile(path.join(dir, "shape2.md"), matter.stringify("\nx\n", { ws: "site", session: "shape-2", close: [{ id: "ST-1", evidence: { nested: true } }] }))
  const broken = []
  const list = await sum.listProposals("site", { broken })
  assert.ok(!list.some((p) => p.session.startsWith("shape-")))
  assert.deepEqual(broken.map((b) => b.id).sort(), ["proposals/site/shape1.md", "proposals/site/shape2.md"])
  for (const f of ["shape1.md", "shape2.md"]) await fs.rm(path.join(dir, f))
})

test("F01 (round 2): rejecting refuses a draft replaced since it was shown, and keeps the newer one", async () => {
  const shown = await draft("rej-1", { add: [{ text: "Add a sitemap", waiting: null }] })
  const fp = sum.proposalFingerprint(shown)
  const newer = await draft("rej-1", { add: [{ text: "Add a robots.txt", waiting: null }] })
  await assert.rejects(sum.rejectProposal(shown, { fingerprint: fp }), /changed since you opened it/)
  const kept = (await sum.listProposals("site")).find((x) => x.session === "rej-1")
  assert.equal(sum.proposalFingerprint(kept), sum.proposalFingerprint(newer))
  await sum.rejectProposal(kept, { fingerprint: sum.proposalFingerprint(kept) })
  assert.ok(!(await sum.listProposals("site")).some((x) => x.session === "rej-1"))
  assert.deepEqual((await fs.readdir(path.join(sum.PROPOSALS_DIR, "site"))).filter((f) => f.includes(".rejecting-")), [])
})

test("F19: a later inbox row for an already assigned session is logged in full, not dropped", async () => {
  const t = await transcript("f19")
  const row = async (name, ended, title) => {
    await fs.writeFile(path.join(cap.INBOX_DIR, name), matter.stringify(`\n${title}\n`, { session: "inbox-row-4", tool: "claude", title, ended, transcript: t }))
    return (await cap.listInbox()).find((r) => r.session === "inbox-row-4")
  }
  const first = await cap.assignInbox(await row("2026-11-20_claude_r4a.md", "2026-11-20T10:00:00Z", "First part"), "site", "Started the redesign.")
  // The same session, resumed outside the workstream's folder, ends again later.
  const second = await cap.assignInbox(await row("2026-11-21_claude_r4b.md", "2026-11-21T09:00:00Z", "Second part"), "site", "Finished the redesign.")
  assert.notEqual(second, first)
  const logs = (await store.getWorkstream("site")).logs.filter((l) => l.session === "inbox-row-4")
  assert.deepEqual(logs.map((l) => l.summary), ["Started the redesign.", "Finished the redesign."])
})

test("F19: retrying an interrupted assign fills a placeholder and still queues a summary", async () => {
  const t = await transcript("f19b")
  await fs.writeFile(path.join(cap.INBOX_DIR, "2026-11-20_claude_r5.md"), matter.stringify("\nE\n", { session: "inbox-row-5", tool: "claude", title: "E", ended: "2026-11-20T11:00:00Z", transcript: t }))
  const row = (await cap.listInbox()).find((r) => r.session === "inbox-row-5")
  // The first attempt wrote the placeholder log, then died before queueing and removing the row.
  const log = await store.appendLog("site", { session: "inbox-row-5", tool: "claude", ended: "2026-11-20T11:00:00Z", transcript: t, source: "hook", summary: "(auto) E" })
  assert.equal(await cap.assignInbox(row, "site"), log)
  assert.ok((await sum.listQueue()).some((j) => j.session === "inbox-row-5"), "the summary is queued on the retry")
  await fs.rm((await sum.listQueue()).find((j) => j.session === "inbox-row-5").file)
  assert.equal((await store.getWorkstream("site")).logs.filter((l) => l.session === "inbox-row-5").length, 1)
})

test("F01 (round 3): accepting a draft that was replaced leaves the newer draft untouched", async () => {
  const shown = await draft("acc-5", { add: [{ text: "Add a sitemap", waiting: null }] })
  const newer = await draft("acc-5", { add: [{ text: "Add a robots.txt", waiting: null }] })
  await assert.rejects(sum.acceptProposal(shown), /changed since you opened it/)
  const left = (await sum.listProposals("site")).filter((x) => x.session === "acc-5")
  assert.equal(left.length, 1)
  assert.ok(!left[0].interrupted && left[0].file.endsWith(".md"), "still a plain draft, not claimed")
  assert.equal(sum.proposalFingerprint(left[0]), sum.proposalFingerprint(newer))
  assert.ok(!(await store.readOpen("site")).items.some((i) => /sitemap|robots/.test(i.text)))
  await sum.rejectProposal(left[0])
})

// ------------------------------------------------------------------ round 4

test("F01 (round 4): a resumed accept refuses a claim that now holds a different draft", async () => {
  const stale = await draft("res-1", { add: [{ text: "Add a sitemap", waiting: null }], decide: [{ text: "Use the blue logo", why: "brand", rejected: [], unverified: "confirm" }] })
  const listedClaim = { ...stale, file: `${stale.file}.accepting`, interrupted: true }
  // Since that listing, its accept finished and a newer draft for the session was claimed.
  const newer = await draft("res-1", { add: [{ text: "Delete the blog", waiting: null }], decide: [{ text: "Drop the blog", why: "x", rejected: [], unverified: "confirm" }] })
  await fs.rename(newer.file, `${newer.file}.accepting`)
  const before = await fs.readFile(`${newer.file}.accepting`, "utf-8")
  await assert.rejects(sum.acceptProposal(listedClaim, { confirmDecisions: [0] }), /changed since you opened it/)
  assert.equal(await fs.readFile(`${newer.file}.accepting`, "utf-8"), before, "the claim is left as it was")
  assert.ok(!(await store.readOpen("site")).items.some((i) => i.text === "Delete the blog"))
  assert.ok(!(await store.readDecisions("site")).decisions.some((d) => d.text === "Drop the blog"))
  // The claim's own listing still finishes it.
  const own = (await sum.listProposals("site")).find((x) => x.session === "res-1" && x.interrupted)
  await sum.acceptProposal(own, { add: false })
  assert.ok(!(await sum.listProposals("site")).some((x) => x.session === "res-1"))
})

test("F21: an assign retry never overwrites notes that land on the log while it waits", async () => {
  const t = await transcript("f21")
  await fs.writeFile(path.join(cap.INBOX_DIR, "2026-11-20_claude_r6.md"), matter.stringify("\nF\n", { session: "inbox-row-6", tool: "claude", title: "F", ended: "2026-11-20T12:00:00Z", transcript: t }))
  const row = (await cap.listInbox()).find((r) => r.session === "inbox-row-6")
  const log = await store.appendLog("site", { session: "inbox-row-6", tool: "claude", ended: "2026-11-20T12:00:00Z", source: "hook", summary: "(auto) F" })
  let pending
  // Hold the log's capture lock (as accepting a draft does), let the retry start and wait,
  // then write a model summary before letting go.
  await store.withLock(path.join(path.dirname(log), ".capture"), async () => {
    pending = cap.assignInbox(row, "site", "My own notes.")
    await new Promise((r) => setTimeout(r, 200))
    const { data, content } = matter(await fs.readFile(log, "utf-8"))
    assert.match(content, /\(auto\) F/, "the retry waits for the capture lock before touching the log")
    await fs.writeFile(log, matter.stringify("\nModel summary.\n", { ...data, source: "hook+model" }))
  })
  assert.equal(await pending, log)
  assert.match(await fs.readFile(log, "utf-8"), /Model summary\./)
  assert.equal((await cap.listInbox()).filter((x) => x.session === "inbox-row-6").length, 0)
})

// ------------------------------------------------------------------ round 5

test("F22: restore never replaces a draft already at the destination, and drops stale lock folders", async () => {
  await store.createWorkstream("del-c", { title: "Delete C", cwd: site })
  const pdir = path.join(sum.PROPOSALS_DIR, "del-c")
  await fs.mkdir(pdir, { recursive: true })
  await fs.writeFile(path.join(pdir, "s1.md"), matter.stringify("\nold\n", { ws: "del-c", session: "s1" }))
  await fs.writeFile(path.join(pdir, "s2.md"), matter.stringify("\nonly in trash\n", { ws: "del-c", session: "s2" }))
  const { trash } = await store.deleteWorkstream("del-c")
  await fs.mkdir(path.join(store.TRASH_DIR, trash, "proposals", "s1.md.lock")) // a lock held when it was deleted
  // The workstream came back in an earlier attempt and a newer draft for s1 was published.
  await fs.rename(path.join(store.TRASH_DIR, trash, "ws"), path.join(store.WS_DIR, "del-c"))
  await fs.mkdir(pdir, { recursive: true })
  await fs.writeFile(path.join(pdir, "s1.md"), matter.stringify("\nnewer\n", { ws: "del-c", session: "s1" }))
  await store.restoreWorkstream(trash)
  assert.match(await fs.readFile(path.join(pdir, "s1.md"), "utf-8"), /newer/)
  assert.match(await fs.readFile(path.join(pdir, "s2.md"), "utf-8"), /only in trash/)
  assert.deepEqual((await fs.readdir(pdir)).sort(), ["s1.md", "s2.md"])
})
