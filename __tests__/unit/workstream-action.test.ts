import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ws/lib reads WS_ROOT when it loads, so point it at a temp folder before importing.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-board-"))
process.env.WS_ROOT = root

type Server = typeof import("@/lib/ws/server")
type Store = { createWorkstream: (id: string, f: object) => Promise<unknown>; getWorkstream: (id: string) => Promise<{ status: string; waiting_on: string }> }
let server: Server
let store: Store

beforeAll(async () => {
  server = await import("@/lib/ws/server")
  store = (await import("@/ws/lib/store.mjs")) as unknown as Store
  await store.createWorkstream("site", { title: "Site", cwd: root })
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe("workstreamAction input checks", () => {
  it("refuses a status outside the board's columns", async () => {
    await expect(server.workstreamAction("site", { action: "status", status: "bogus" })).rejects.toThrow(/status must be one of/)
    await expect(server.workstreamAction("site", { action: "status", status: "archived" })).rejects.toThrow(/status must be one of/)
    expect((await store.getWorkstream("site")).status).toBe("active")
  })

  it("accepts a valid status and clears waiting_on with an empty string", async () => {
    await server.workstreamAction("site", { action: "status", status: "waiting", waiting_on: "client" })
    expect(await store.getWorkstream("site")).toMatchObject({ status: "waiting", waiting_on: "client" })
    await server.workstreamAction("site", { action: "status", waiting_on: "" })
    expect((await store.getWorkstream("site")).waiting_on).toBe("")
  })

  it("refuses non-text values", async () => {
    await expect(server.workstreamAction("site", { action: "status", waiting_on: { a: 1 } })).rejects.toThrow(/must be text/)
    await expect(server.workstreamAction("site", { action: "add", text: ["x"] })).rejects.toThrow(/must be text/)
    await expect(server.workstreamAction("site", { action: "add", text: "ok", waiting: 5 })).rejects.toThrow(/must be text/)
    await expect(server.workstreamAction("site", { action: "close", item: { id: "S-1" } })).rejects.toThrow(/must be text/)
  })

  it("refuses missing and oversized text", async () => {
    await expect(server.workstreamAction("site", { action: "add" })).rejects.toThrow(/required/)
    await expect(server.workstreamAction("site", { action: "add", text: "x".repeat(5000) })).rejects.toThrow(/too long/)
    await expect(server.workstreamAction("site", { action: "status" })).rejects.toThrow(/nothing to change/)
  })

  it("still adds and closes items", async () => {
    const item = (await server.workstreamAction("site", { action: "add", text: "Fix nav", waiting: "design" })) as { id: string; waiting: string }
    expect(item.waiting).toBe("design")
    await server.workstreamAction("site", { action: "close", item: item.id })
  })
})
