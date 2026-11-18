import { test, before } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"))
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
const { compose, claudeProjectSlug } = await import("../lib/compose.mjs")

const proj = path.join(tmp, "Projects", "Acme & Co", "site")
const memDir = path.join(tmp, ".claude", "projects", claudeProjectSlug(proj), "memory")

before(async () => {
  await fs.mkdir(proj, { recursive: true })
  await fs.mkdir(memDir, { recursive: true })
  await fs.mkdir(store.PROC_DIR, { recursive: true })
  await fs.writeFile(path.join(proj, "STATUS.md"), "# Status\n\n## Reviewer's feedback (Nov 1)\nold\n\n## Other\nx\n\n## Reviewer's feedback (Nov 9)\nnewest round\n")
  await fs.writeFile(path.join(memDir, "reviewer.md"), "---\nname: reviewer\n---\nReviewer wants measured spacing.\n")
  await fs.writeFile(path.join(store.PROC_DIR, "review.md"), "---\nid: review\n---\n1. Fix it at source.\n2. Draft a reply to {{reviewer}}.\n")
  await store.createWorkstream("acme-review", { title: "the Acme review", cwd: proj, prefix: "AR" })
  await store.updateWorkstream("acme-review", {
    procedure: "review",
    vars: { reviewer: "Reviewer" },
    input: "New feedback from {{reviewer}}: [paste]",
    sources: [
      { path: path.join(memDir, "reviewer.md"), role: "memory" },
      { path: path.join(proj, "STATUS.md"), section: "Reviewer's feedback", role: "status" },
    ],
  })
})

test("items get stable, never-reused IDs and survive a round trip", async () => {
  const a = await store.addItem("acme-review", "Fix the frame")
  const b = await store.addItem("acme-review", "Get the vector", { waiting: "Big Client" })
  assert.equal(a.id, "AR-1")
  assert.equal(b.id, "AR-2")
  await store.closeItem("acme-review", "ar-1", { session: "abcdef1234" })
  const c = await store.addItem("acme-review", "New thing")
  assert.equal(c.id, "AR-3")
  const { items } = await store.readOpen("acme-review")
  assert.deepEqual(items.map((i) => [i.id, i.done]), [["AR-2", false], ["AR-3", false], ["AR-1", true]])
  assert.equal(items[0].waiting, "Big Client")
  assert.match(items[2].closed, /abcdef12/)
})

test("parallel writers don't lose items", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.addItem("acme-review", `parallel ${i}`)))
  const { items } = await store.readOpen("acme-review")
  const ids = items.map((i) => i.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(items.filter((i) => i.text.startsWith("parallel")).length, 10)
})

test("compose for Claude in the memory's own cwd points at files, fills vars and lists open items", async () => {
  await store.appendLog("acme-review", { summary: "Rebuilt the frame.", tool: "claude", session: "1234567890" })
  const { text } = await compose("acme-review", { tool: "claude" })
  assert.match(text, /^Continuing the Acme review\./)
  assert.match(text, /my memory note reviewer\.md \(/)
  assert.match(text, /the latest "Reviewer's feedback" section in/)
  assert.match(text, /New feedback from Reviewer: \[paste\]/)
  assert.match(text, /2\. Draft a reply to Reviewer\./)
  assert.match(text, /- AR-2 Get the vector \(waiting on Big Client\)/)
  assert.doesNotMatch(text, /AR-1 Fix the frame/)
  assert.match(text, /Last session \(.*claude\): Rebuilt the frame\./)
  assert.doesNotMatch(text, /Included files/)
})

test("compose for Codex inlines the memory note", async () => {
  const { text } = await compose("acme-review", { tool: "codex" })
  assert.match(text, /reviewer\.md \(included below\)/)
  assert.match(text, /Reviewer wants measured spacing\./)
})

test("--inline includes only the newest matching section", async () => {
  const { text } = await compose("acme-review", { tool: "claude", inline: true })
  assert.match(text, /newest round/)
  assert.doesNotMatch(text, /\nold\n/)
})

test("compose fails loudly on a missing section or source", async () => {
  await store.updateWorkstream("acme-review", {
    sources: [{ path: path.join(proj, "STATUS.md"), section: "Nope" }, { path: path.join(proj, "GONE.md") }],
  })
  await assert.rejects(compose("acme-review"), /no heading containing "Nope"[\s\S]*source missing/)
})

test("compose fails on unset procedure vars", async () => {
  await store.updateWorkstream("acme-review", { sources: [], vars: {} })
  await assert.rejects(compose("acme-review"), /vars not set: reviewer/)
})

test("mirror block: opt-in, replaces only its own block, defers on a recently edited doc", async () => {
  const doc = path.join(proj, "MIRROR.md")
  await fs.writeFile(doc, "# Status\n\nHand-written notes.\n")
  await store.updateWorkstream("acme-review", { mirror: doc })
  // Fresh file: deferred unless forced.
  assert.equal((await store.syncMirror("acme-review")).action, "deferred")
  assert.equal((await store.syncMirror("acme-review", { force: true })).action, "missing-block")
  assert.equal((await store.syncMirror("acme-review", { force: true, init: true })).action, "written")
  let text = await fs.readFile(doc, "utf-8")
  assert.match(text, /^# Status\n\nHand-written notes\.\n\n<!-- ws:open acme-review/)
  assert.match(text, /- AR-2 Get the vector \(waiting on Big Client\)/)

  // Age the file, add text after the block, then change an item: only the block changes.
  await fs.appendFile(doc, "\nAfter the block.\n")
  const old = new Date(Date.now() - 10 * 60_000)
  await fs.utimes(doc, old, old)
  await store.addItem("acme-review", "Mirror me")
  text = await fs.readFile(doc, "utf-8")
  assert.match(text, /- AR-\d+ Mirror me\n<!-- \/ws:open -->\n\nAfter the block\.\n$/)
  assert.equal(text.match(/<!-- ws:open/g).length, 1)
  await store.updateWorkstream("acme-review", { mirror: null })
})
