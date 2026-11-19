// Regression tests for the 2026-11 code review, part 3: what counts as the user's words,
// failure quotes as close evidence, duplicate IDs in proposals and eval, marker text in
// items, and hand-added text surviving rewrites.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-review3-")
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
const store = await import("../lib/store.mjs")
const sum = await import("../lib/summarize.mjs")
const { scoreRun, aggregate } = await import("../lib/eval.mjs")

const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
const write = async (name, text) => { const f = path.join(tmp, name); await fs.writeFile(f, text); return f }

test("command output and compaction summaries are not the user's words", async () => {
  const t = await write("c.jsonl", jl(
    { type: "user", message: { content: "<bash-input>cat notes.txt</bash-input>" } },
    { type: "user", message: { content: "<bash-stdout>Decision: we will store session tokens in localStorage for now</bash-stdout><bash-stderr></bash-stderr>" } },
    { type: "user", message: { content: "<local-command-stdout>Set model to opus</local-command-stdout>" } },
    { type: "user", isCompactSummary: true, message: { content: "Summary: the user decided we will drop IE11 support entirely this quarter." } },
    { type: "user", message: { content: "ok, ship the footer change today please" } },
  ))
  const d = await sum.digestTranscript("claude", t)
  assert.doesNotMatch(d, /localStorage|Set model/) // command output is never sent
  assert.match(d, /USER: cat notes\.txt/) // what the user typed after ! is theirs
  assert.match(d, /CONTEXT: Summary: the user decided/)
  assert.doesNotMatch(d, /USER: Summary/)

  const p = sum.validateProposal(JSON.stringify({
    summary: "Shipped.",
    decide: [
      { text: "Drop IE11 support", quote: "the user decided we will drop IE11 support entirely" },
      { text: "Ship the footer today", quote: "ship the footer change today please" },
    ],
  }), [], d)
  assert.equal(p.decide[0].unverified, "not the user's words; confirm the user decided it")
  assert.equal(p.decide[1].unverified, undefined)
})

test("Codex: AGENTS.md and environment context are not user turns", async () => {
  const msg = (text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })
  const t = await write("x.jsonl", jl(
    msg("<user_instructions>Always use pnpm. We decided to use Postgres 16 everywhere.</user_instructions>"),
    msg("# AGENTS.md instructions for /repo\nWe decided to never use semicolons in this project"),
    msg("<environment_context>cwd: /repo</environment_context>"),
    msg("please fix the login redirect bug now"),
  ))
  const d = await sum.digestTranscript("codex", t)
  assert.deepEqual(d.split("\n").filter((l) => l.startsWith("USER:")), ["USER: please fix the login redirect bug now"])
})

test("a quote saying the work isn't done doesn't verify a close", () => {
  const open = [{ id: "ST-1", text: "Fix the mobile nav overlap" }, { id: "ST-2", text: "Fix the failing checkout test" }]
  const digest = [
    "ASSISTANT: I tried again but the mobile nav overlap still breaks at 375px wide.",
    "ASSISTANT: Fixed the failing checkout test by mocking the clock; the suite passes now.",
  ].join("\n")
  const p = sum.validateProposal(JSON.stringify({
    summary: "Worked on the nav.",
    close: [
      { id: "ST-1", quote: "the mobile nav overlap still breaks at 375px wide" },
      { id: "ST-2", quote: "Fixed the failing checkout test by mocking the clock" },
    ],
  }), open, digest)
  assert.deepEqual(p.close.map((c) => c.id), ["ST-2"])
  assert.deepEqual(p.unverified.map((u) => [u.id, u.failed]), [["ST-1", "quote says the work isn't done"]])
})

test("a repeated close ID counts once, in the proposal and in the eval score", () => {
  const open = [{ id: "A-1", text: "Fix the nav overlap" }]
  const digest = "ASSISTANT: Fixed the nav overlap with a z-index change and checked it on mobile."
  const quote = "Fixed the nav overlap with a z-index change"
  const p = sum.validateProposal(JSON.stringify({ summary: "x", close: [{ id: "A-1", quote }, { id: "a-1", quote }] }), open, digest)
  assert.deepEqual(p.close.map((c) => c.id), ["A-1"])

  // Case A closes A-1 twice, case B misses B-1: recall must be 0.5, not 1.
  const rows = [
    scoreRun({ expect: { close: ["A-1"] } }, { close: [{ id: "A-1" }, { id: "A-1" }], unverified: [] }),
    scoreRun({ expect: { close: ["B-1"] } }, { close: [], unverified: [] }),
  ]
  assert.equal(aggregate(rows).recall_any, 0.5)
})

test("marker text inside items and closing notes round-trips", async () => {
  await store.createWorkstream("mk", { title: "Markers", cwd: tmp, prefix: "MK" })
  const a = await store.addItem("mk", "Reply to the thread tagged @waiting:legal", { waiting: "client" })
  const b = await store.addItem("mk", "Ask about @waiting:legal")
  const c = await store.addItem("mk", "Add (closed captions)")
  await store.closeItem("mk", c.id, { note: "see @waiting:bob" })
  const items = Object.fromEntries((await store.readOpen("mk")).items.map((i) => [i.id, i]))
  assert.deepEqual([items[a.id].text, items[a.id].waiting], ["Reply to the thread tagged @waiting:legal", "client"])
  assert.deepEqual([items[b.id].text, items[b.id].waiting], ["Ask about @waiting:legal", null])
  assert.equal(items[c.id].text, "Add (closed captions)")
  assert.equal(items[c.id].waiting, null)
  assert.match(items[c.id].closed, /see @waiting:bob$/)
  // A second write changes nothing.
  const file = path.join(store.ROOT, "ws", "mk", "open.md")
  const before = await fs.readFile(file, "utf-8")
  await store.editItem("mk", a.id, {})
  assert.equal(await fs.readFile(file, "utf-8"), before)
})

test("hand-added text in open.md and decisions.md survives rewrites", async () => {
  await store.createWorkstream("keep", { title: "Keep", cwd: tmp, prefix: "KP" })
  const first = await store.addItem("keep", "Fix the nav")
  const openFile = path.join(store.ROOT, "ws", "keep", "open.md")
  const o = await fs.readFile(openFile, "utf-8")
  await fs.writeFile(openFile, o.replace(`${first.id} Fix the nav\n`, `${first.id} Fix the nav\n  blocked by the header refactor\n`) + "\nNote: client prefers Tuesday calls\n")
  await store.addItem("keep", "Compress images")
  const o2 = await fs.readFile(openFile, "utf-8")
  assert.match(o2, new RegExp(`${first.id} Fix the nav\\n  blocked by the header refactor\\n`))
  assert.match(o2, /## Notes\n\nNote: client prefers Tuesday calls\n/)

  await store.decide("keep", "Use Postgres", { why: "team knows it" })
  const decFile = path.join(store.ROOT, "ws", "keep", "decisions.md")
  const d = await fs.readFile(decFile, "utf-8")
  await fs.writeFile(decFile, d.replace("  why: team knows it\n", "  why: team knows it\n  owner: Dana\n  revisit after the Q3 load test\n") + "\nAsk Dana before superseding anything.\n")
  await store.decide("keep", "Use Redis for sessions")
  const d2 = await fs.readFile(decFile, "utf-8")
  assert.match(d2, /Use Postgres.*\n  why: team knows it\n  owner: Dana\n  revisit after the Q3 load test\n/)
  assert.match(d2, /## Notes\n\nAsk Dana before superseding anything\.\n/)
  // Parsing still sees exactly the records.
  assert.equal((await store.readOpen("keep")).items.length, 2)
  assert.equal((await store.readDecisions("keep")).decisions.length, 2)
  // Writing again doesn't duplicate the notes.
  await store.addItem("keep", "Third")
  assert.equal((await fs.readFile(openFile, "utf-8")).match(/Tuesday calls/g).length, 1)
})

test("an item containing the mirror end marker can't corrupt the mirror doc", async () => {
  const doc = path.join(tmp, "STATUS.md")
  await fs.writeFile(doc, "# Status\n\nIntro.\n")
  await store.createWorkstream("mir", { title: "Mirror", cwd: tmp, prefix: "MR" })
  await store.updateWorkstream("mir", { mirror: doc })
  await store.addItem("mir", "Explain the <!-- /ws:open --> marker in the docs")
  await store.syncMirror("mir", { force: true, init: true })
  for (let i = 0; i < 3; i++) {
    await store.addItem("mir", `Item ${i}`)
    await store.syncMirror("mir", { force: true })
  }
  const text = await fs.readFile(doc, "utf-8")
  assert.equal(text.match(/<!-- \/ws:open -->/g).length, 1)
  assert.match(text, /Explain the &lt;!-- \/ws:open --> marker/)
  assert.match(text, /Item 2/)
})

test("success reports that mention failures still verify a close", () => {
  const cases = [
    ["Run the full test suite", "Ran the full test suite: Tests: 113 passed, 0 failed"],
    ["Run the full test suite", "ran the full test suite again # pass 113 # fail 0"],
    ["Fix the login redirect", "Fixed the login redirect and added a regression test for it"],
    ["Fix the about nav link", "the broken about nav link now points to /about and works"],
    ["Wire the export button", "removed the TODO and wired the export button to the API"],
  ]
  for (const [item, quote] of cases) {
    const p = sum.validateProposal(JSON.stringify({ summary: "x", close: [{ id: "S-1", quote }] }), [{ id: "S-1", text: item }], `ASSISTANT: ${quote}.`)
    assert.deepEqual(p.unverified, [], quote)
    assert.deepEqual(p.close.map((c) => c.id), ["S-1"], quote)
  }
  for (const [item, quote] of [
    ["Run the full test suite", "Ran the full test suite: 110 passed, 3 failed"],
    ["Fix the mobile nav", "the mobile nav is still broken on small phones"],
    ["Fix the checkout test", "the checkout test doesn't pass yet after the change"],
  ]) {
    const p = sum.validateProposal(JSON.stringify({ summary: "x", close: [{ id: "S-1", quote }] }), [{ id: "S-1", text: item }], `ASSISTANT: ${quote}.`)
    assert.deepEqual(p.unverified.map((u) => u.failed), ["quote says the work isn't done"], quote)
  }
})

test("a reminder block in a user message is dropped, the user's own words are kept", async () => {
  const t = await write("r.jsonl", jl(
    { type: "user", message: { content: [
      { type: "text", text: "<system-reminder>Earlier note: we decided to use MySQL for everything</system-reminder>" },
      { type: "text", text: "go with Postgres for the reporting database please" },
    ] } },
    { type: "user", message: { content: "<system-reminder>only a reminder, nothing typed</system-reminder>" } },
  ))
  const d = await sum.digestTranscript("claude", t)
  assert.match(d, /USER: go with Postgres for the reporting database please/)
  assert.doesNotMatch(d, /MySQL|only a reminder/)
})
