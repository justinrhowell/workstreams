import { NextResponse } from "next/server"

export async function json<T>(fn: () => Promise<T>) {
  try {
    return NextResponse.json((await fn()) ?? { ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

// The board's security boundary is "only this machine": it binds to 127.0.0.1 and has no
// login. These checks stop the browser-based attacks that reach a loopback server anyway
// (cross-site requests, DNS rebinding). Next fills x-forwarded-for with the socket's
// address when a request isn't proxied, so it must be loopback; a request relayed by a
// proxy or tunnel carries the real client there and is refused. A local process that
// forges every header can't be stopped this way, so never expose the board.
const LOOPBACK_IP = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

function fromThisMachine(req: Request): boolean {
  const host = req.headers.get("host") || ""
  if (!LOCAL_HOST.test(host)) return false
  if (req.headers.has("forwarded")) return false
  const fwdHost = req.headers.get("x-forwarded-host")
  if (fwdHost && !LOCAL_HOST.test(fwdHost)) return false
  for (const h of ["x-forwarded-for", "x-real-ip"]) {
    const v = req.headers.get(h)
    if (v && !v.split(",").every((ip) => LOOPBACK_IP.test(ip.trim()))) return false
  }
  return true
}

function localOnly(req: Request): NextResponse | null {
  if (!fromThisMachine(req)) return NextResponse.json({ error: "board accepts local requests only" }, { status: 403 })
  const origin = req.headers.get("origin")
  if (origin) {
    let ok = false
    try { ok = new URL(origin).host === req.headers.get("host") } catch {}
    if (!ok) return NextResponse.json({ error: "cross-origin request refused" }, { status: 403 })
  }
  return null
}

// Reads expose prompts, summaries and item text, so they get the same host/origin check.
export async function readJson<T>(req: Request, fn: () => Promise<T>) {
  return localOnly(req) || json(fn)
}

// Writes must come from the board itself. Without this, any web page could POST
// text/plain (no CORS preflight) to 127.0.0.1:3311 and add or close items, and item
// text flows into session-start notes and resume prompts. The Host check also stops
// DNS-rebinding requests.
export function writeGuard(req: Request): NextResponse | null {
  const denied = localOnly(req)
  if (denied) return denied
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "expected application/json" }, { status: 415 })
  }
  return null
}

// For older routes whose clients may not send JSON (e.g. body-less POSTs): browsers always
// send Origin on cross-site POSTs, so a host+origin check is enough there.
export function originGuard(req: Request): NextResponse | null {
  return localOnly(req)
}

export async function writeJson<T>(req: Request, fn: (body: any) => Promise<T>) {
  const denied = writeGuard(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  return json(() => fn(body))
}
