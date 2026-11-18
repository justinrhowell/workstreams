import { test, before } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import matter from "gray-matter"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-dec-"))
process.env.WS_ROOT = path.join(tmp, "root")
const store = await import("../lib/store.mjs")
const sum = await import("../lib/summarize.mjs")
const { compose } = await import("../lib/compose.mjs")
const cap = await import("../lib/capture.mjs")

const site = path.join(tmp, "site")
before(async () => {
  await fs.mkdir(site, { recursive: true })
  await store.createWorkstream("brand", { title: "Brand refresh", cwd: site, prefix: "BR" })
  await store.addItem("brand", "Pick the cream colour")
})

test("decide allocates <PREFIX>-D<n>, records why/rejected, and supersedes without editing", async () => {
  const a = await store.decide("brand", "Cream is #F7F7E7", { why: "matches logo exports" })
  assert.equal(a.decision.id, "BR-D1")
  const b = await store.decide("brand", "Cream is #F2F2E9 everywhere", { why: "guide palette is the source", rejected: ["#F7F7E7: legacy export value"], supersedes: "br-d1" })
  assert.equal(b.decision.id, "BR-D2")
  assert.equal(b.superseded, "BR-D1")
  const { decisions } = await store.readDecisions("brand")
  const d1 = decisions.find((d) => d.id === "BR-D1")
  assert.equal(d1.active, false)
  assert.equal(d1.superseded_by, "BR-D2")
  assert.equal(d1.text, "Cream is #F7F7E7") // unchanged
  assert.equal(decisions.find((d) => d.id === "BR-D2").rejected, "#F7F7E7: legacy export value")
  await assert.rejects(store.decide("brand", "x", { supersedes: "BR-D1" }), /already superseded/)
  await assert.rejects(store.decide("brand", "x", { supersedes: "BR-D9" }), /not found/)
})

test("prompt and start note list active decisions only", async () => {
  const { text } = await compose("brand")
  assert.match(text, /Decided \(don't reopen[\s\S]*BR-D2 Cream is #F2F2E9 everywhere\. Why: guide palette is the source\. Rejected: #F7F7E7/)
  assert.doesNotMatch(text, /BR-D1/)
  assert.match(text, /ws decide brand/)
  const note = await cap.startContext({ cwd: site })
  assert.match(note, /Decided \(1\):\n  BR-D2/)
})

test("decision IDs never collide with item IDs, and parallel decides don't lose records", async () => {
  await Promise.all(Array.from({ length: 6 }, (_, i) => store.decide("brand", `parallel decision ${i}`)))
  const { decisions } = await store.readDecisions("brand")
  const ids = decisions.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal((await store.addItem("brand", "another item")).id, "BR-2")
})

test("summarizer: decisions need a real quote; restated decisions are dropped; unverified ones need confirming", async () => {
  const decided = [{ id: "BR-D2", text: "Cream is #F2F2E9 everywhere" }]
  const digest = "USER: let's go with Helvetica Neue for all headings, no more Inter.\nASSISTANT: Done."
  const p = sum.validateProposal(JSON.stringify({
    summary: "Chose fonts.",
    decide: [
      { text: "Use Helvetica Neue for all headings", why: "house style", rejected: ["Inter"], quote: "let's go with Helvetica Neue for all headings" },
      { text: "Cream is #F2F2E9 everywhere", quote: "let's go with Helvetica Neue for all headings" }, // restates an active decision
      { text: "Use 12pt body text", quote: "nobody said this in the session at all" },
    ],
  }), [], digest, decided)
  assert.equal(p.decide.length, 2)
  assert.equal(p.decide[0].unverified, undefined)
  assert.equal(p.decide[1].unverified, "quote not found in the session")

  const log = await store.appendLog("brand", { summary: "(auto) fonts", session: "sess-font", source: "hook" })
  const pfile = path.join(sum.PROPOSALS_DIR, "brand", "f.md")
  await fs.mkdir(path.dirname(pfile), { recursive: true })
  const write = () => fs.writeFile(pfile, matter.stringify(`\n${p.summary}\n`, { ws: "brand", session: "sess-font", log, close: [], add: [], decide: p.decide }))
  await write()
  let [prop] = await sum.listProposals("brand")
  let r = await sum.acceptProposal(prop)
  assert.equal(r.decided.length, 1) // verified only
  await write()
  ;[prop] = await sum.listProposals("brand")
  r = await sum.acceptProposal(prop, { decide: false, confirmDecisions: [1] })
  assert.equal(r.decided.length, 1) // only the confirmed unverified one
  const texts = (await store.readDecisions("brand")).decisions.map((d) => d.text)
  assert.ok(texts.includes("Use Helvetica Neue for all headings"))
  assert.ok(texts.includes("Use 12pt body text"))
})
