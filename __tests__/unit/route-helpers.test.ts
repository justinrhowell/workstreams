import { writeGuard, readJson } from "@/lib/ws/route-helpers"

const req = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1:3311/api/ws", { method: "POST", headers })

describe("writeGuard", () => {
  it("accepts a same-origin JSON write from the local board", () => {
    expect(writeGuard(req({ host: "127.0.0.1:3311", "content-type": "application/json", origin: "http://127.0.0.1:3311" }))).toBeNull()
  })

  it("accepts localhost without an Origin header (CLI-style clients)", () => {
    expect(writeGuard(req({ host: "localhost:3311", "content-type": "application/json" }))).toBeNull()
  })

  it("refuses non-local hosts (DNS rebinding)", () => {
    expect(writeGuard(req({ host: "evil.example:3311", "content-type": "application/json" }))?.status).toBe(403)
  })

  it("refuses non-JSON bodies (no-preflight text/plain posts)", () => {
    expect(writeGuard(req({ host: "127.0.0.1:3311", "content-type": "text/plain" }))?.status).toBe(415)
  })

  it("refuses cross-origin writes", () => {
    expect(writeGuard(req({ host: "127.0.0.1:3311", "content-type": "application/json", origin: "https://evil.example" }))?.status).toBe(403)
  })
})

describe("readJson", () => {
  const get = (headers: Record<string, string>) => new Request("http://127.0.0.1:3311/api/ws", { headers })
  const data = async () => ({ secret: "prompt text" })

  it("serves local reads", async () => {
    expect((await readJson(get({ host: "127.0.0.1:3311" }), data)).status).toBe(200)
  })

  it("refuses DNS-rebinding reads (foreign Host)", async () => {
    expect((await readJson(get({ host: "attacker.example:3311" }), data)).status).toBe(403)
  })

  it("refuses cross-origin reads and proxied requests", async () => {
    expect((await readJson(get({ host: "127.0.0.1:3311", origin: "https://evil.example" }), data)).status).toBe(403)
    expect((await readJson(get({ host: "localhost:3311", "x-forwarded-for": "203.0.113.9" }), data)).status).toBe(403)
    expect((await readJson(get({ host: "localhost:3311", "x-forwarded-host": "board.example.com" }), data)).status).toBe(403)
    expect((await readJson(get({ host: "localhost:3311", forwarded: "for=203.0.113.9" }), data)).status).toBe(403)
  })

  it("accepts the loopback x-forwarded-* headers Next adds to direct requests", async () => {
    const h = { host: "127.0.0.1:3311", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:3311", "x-forwarded-port": "3311", "x-forwarded-proto": "http" }
    expect((await readJson(get(h), data)).status).toBe(200)
    expect((await readJson(get({ ...h, "x-forwarded-for": "::ffff:127.0.0.1" }), data)).status).toBe(200)
  })
})
