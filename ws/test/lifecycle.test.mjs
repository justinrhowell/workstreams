import { test, before } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-life-"))
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const sum = await import("../lib/summarize.mjs")

const site = path.join(tmp, "site")
before(async () => {
  await fs.mkdir(site, { recursive: true })
  await store.createWorkstream("old-job", { title: "Old job", cwd: site, prefix: "OJ", status: "done" })
  await store.addItem("old-job", "leftover")
})

test("archive hides from matching and listings, unarchive restores the previous status", async () => {
  await store.archiveWorkstream("old-job")
  let w = await store.getWorkstream("old-job")
  assert.equal(w.status, "archived")
  assert.equal(w.data.archived_from, "done")
  // A session in its folder is no longer linked to it.
  const list = await store.listWorkstreams()
  assert.equal(cap.matchWorkstream(list, site, null).link, null)
  assert.equal(await cap.startContext({ cwd: site }), "")
  await assert.rejects(store.archiveWorkstream("old-job"), /already archived/)
  const r = await store.unarchiveWorkstream("old-job")
  assert.equal(r.to, "done")
  w = await store.getWorkstream("old-job")
  assert.equal(w.status, "done")
  assert.equal(w.data.archived_from, undefined)
})

test("delete moves the workstream, its drafts and queued jobs to the trash; restore brings all back", async () => {
  await fs.mkdir(path.join(store.ROOT, "proposals", "old-job"), { recursive: true })
  await fs.writeFile(path.join(store.ROOT, "proposals", "old-job", "p.md"), "---\nws: old-job\nsession: s1\n---\nx\n")
  await fs.mkdir(path.join(store.ROOT, "queue"), { recursive: true })
  await fs.writeFile(path.join(store.ROOT, "queue", "s1.json"), JSON.stringify({ ws: "old-job", session: "s1" }))
  await fs.writeFile(path.join(store.ROOT, "queue", "s2.json"), JSON.stringify({ ws: "other", session: "s2" }))

  const { trash } = await store.deleteWorkstream("old-job")
  await assert.rejects(store.getWorkstream("old-job"), /No workstream/)
  assert.equal((await store.listWorkstreams()).length, 0)
  assert.equal((await sum.listProposals("old-job")).length, 0)
  assert.deepEqual((await sum.listQueue()).map((j) => j.ws), ["other"]) // other workstreams' jobs untouched
  const t = await store.listTrash()
  assert.equal(t[0].id, "old-job")
  assert.equal(t[0].title, "Old job")

  // Restore refuses to clobber a new workstream with the same id.
  await store.createWorkstream("old-job", { title: "New one", cwd: site })
  await assert.rejects(store.restoreWorkstream(trash), /already exists/)
  await store.deleteWorkstream("old-job")
  const r = await store.restoreWorkstream(trash)
  assert.equal(r.id, "old-job")
  const w = await store.getWorkstream("old-job")
  assert.equal(w.title, "Old job")
  assert.equal((await store.readOpen("old-job")).items[0].text, "leftover")
  assert.equal((await sum.listProposals("old-job")).length, 1)
  assert.ok((await sum.listQueue()).some((j) => j.ws === "old-job"))
})

test("empty the trash removes for good", async () => {
  assert.equal((await store.listTrash()).length, 1) // the "New one" deleted above
  assert.equal(await store.emptyTrash(), 1)
  assert.equal((await store.listTrash()).length, 0)
})
