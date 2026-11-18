import { writeGuard, originGuard } from "@/lib/ws/route-helpers"

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

describe("originGuard", () => {
  it("accepts a body-less local POST", () => {
    expect(originGuard(req({ host: "127.0.0.1:3311" }))).toBeNull()
  })

  it("refuses cross-origin and non-local requests", () => {
    expect(originGuard(req({ host: "127.0.0.1:3311", origin: "http://other:1" }))?.status).toBe(403)
    expect(originGuard(req({ host: "example.com" }))?.status).toBe(403)
  })
})
