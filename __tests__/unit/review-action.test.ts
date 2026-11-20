import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ws/lib reads WS_ROOT when it loads, so point it at a temp folder before importing.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-board-review-"))
process.env.WS_ROOT = root

type Server = typeof import("@/lib/ws/server")
type Store = {
  createWorkstream: (id: string, f: object) => Promise<unknown>
  addItem: (id: string, text: string) => Promise<{ id: string }>
  readOpen: (id: string) => Promise<{ items: { id: string; text: string }[] }>
}
let server: Server
let store: Store

// A draft for one session, as the summarizer writes it. Writing it again replaces it, as a
// re-summarized session does.
function writeDraft(add: string, name = "sess-1.md") {
  const dir = path.join(root, "proposals", "site")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), `---\nws: site\nsession: sess-1\nmodel: m\ncreated: '${new Date().toISOString()}'\nclose: []\nadd:\n  - text: ${add}\n    waiting: null\nunverified: []\ndecide: []\n---\n\nDrafted.\n`)
}

beforeAll(async () => {
  server = await import("@/lib/ws/server")
  store = (await import("@/ws/lib/store.mjs")) as unknown as Store
  await store.createWorkstream("site", { title: "Site", cwd: root })
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe("reviewAction applies only the draft the board showed", () => {
  it("refuses an accept or reject without the shown draft's fingerprint", async () => {
    writeDraft("Add a sitemap")
    await expect(server.reviewAction({ action: "accept", ws: "site", session: "sess-1" })).rejects.toThrow(/fingerprint is required/)
    await expect(server.reviewAction({ action: "reject", ws: "site", session: "sess-1" })).rejects.toThrow(/fingerprint is required/)
  })

  it("refuses when a newer draft replaced the one on screen, and applies the one on screen otherwise", async () => {
    writeDraft("Add a sitemap")
    const [shown] = await server.reviewData()
    writeDraft("Delete the blog") // the session was summarized again after the board loaded
    await expect(server.reviewAction({ action: "accept", ws: "site", session: "sess-1", fingerprint: shown.fingerprint })).rejects.toThrow(/changed since the board showed it/)
    expect((await store.readOpen("site")).items.map((i) => i.text)).not.toContain("Delete the blog")

    const [current] = await server.reviewData()
    expect(current.fingerprint).not.toBe(shown.fingerprint)
    await server.reviewAction({ action: "accept", ws: "site", session: "sess-1", fingerprint: current.fingerprint })
    expect((await store.readOpen("site")).items.map((i) => i.text)).toContain("Delete the blog")
  })

  it("acts on the card's own draft when an interrupted accept sits beside a newer draft for the session", async () => {
    writeDraft("Add a changelog", "sess-1.md.accepting") // an accept of the older draft that was cut short
    writeDraft("Add a status page")
    const cards = (await server.reviewData()).filter((x) => x.session === "sess-1")
    expect(cards).toHaveLength(2)
    const newer = cards.find((x) => x.add.some((a) => a.text === "Add a status page"))!
    const older = cards.find((x) => x.add.some((a) => a.text === "Add a changelog"))!
    await server.reviewAction({ action: "reject", ws: "site", session: "sess-1", fingerprint: newer.fingerprint })
    await server.reviewAction({ action: "accept", ws: "site", session: "sess-1", fingerprint: older.fingerprint })
    const texts = (await store.readOpen("site")).items.map((i) => i.text)
    expect(texts).toContain("Add a changelog")
    expect(texts).not.toContain("Add a status page")
    expect(await server.reviewData()).toHaveLength(0)
  })
})
