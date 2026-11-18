import { NextResponse } from "next/server"

export async function json<T>(fn: () => Promise<T>) {
  try {
    return NextResponse.json((await fn()) ?? { ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

// Writes must come from the board itself. Without this, any web page could POST
// text/plain (no CORS preflight) to 127.0.0.1:3311 and add or close items, and item
// text flows into session-start notes and resume prompts. The Host check also stops
// DNS-rebinding requests.
export function writeGuard(req: Request): NextResponse | null {
  const host = req.headers.get("host") || ""
  if (!LOCAL_HOST.test(host)) return NextResponse.json({ error: "board accepts local requests only" }, { status: 403 })
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "expected application/json" }, { status: 415 })
  }
  const origin = req.headers.get("origin")
  if (origin) {
    let ok = false
    try { ok = new URL(origin).host === host } catch {}
    if (!ok) return NextResponse.json({ error: "cross-origin write refused" }, { status: 403 })
  }
  return null
}

// For older routes whose clients may not send JSON (e.g. body-less POSTs): browsers always
// send Origin on cross-site POSTs, so a host+origin check is enough there.
export function originGuard(req: Request): NextResponse | null {
  const host = req.headers.get("host") || ""
  if (!LOCAL_HOST.test(host)) return NextResponse.json({ error: "local requests only" }, { status: 403 })
  const origin = req.headers.get("origin")
  if (origin) {
    let ok = false
    try { ok = new URL(origin).host === host } catch {}
    if (!ok) return NextResponse.json({ error: "cross-origin write refused" }, { status: 403 })
  }
  return null
}

export async function writeJson<T>(req: Request, fn: (body: any) => Promise<T>) {
  const denied = writeGuard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  return json(() => fn(body))
}
