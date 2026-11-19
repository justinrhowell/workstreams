// Search across everything ws keeps: workstreams, open and closed items, decisions,
// session logs and the inbox. Used by `ws find`, the ws_find MCP tool and the board.
// No index: the data is small text files, and a scan stays in milliseconds at hundreds
// of workstreams. Closed items and superseded decisions are returned (history is the
// point of searching), but always marked and ranked after current records, so they
// never read as current.
import path from "node:path"
import * as store from "./store.mjs"
import { listInbox } from "./capture.mjs"

export const KINDS = ["workstream", "item", "decision", "log", "inbox"]

// Words, or "quoted phrases"; case-insensitive. Every term must match the same record.
export function parseQuery(q) {
  const terms = []
  for (const m of String(q ?? "").matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase()
    if (t) terms.push(t)
  }
  return terms
}

const firstLine = (s) => { const l = store.oneLine(String(s ?? "").split("\n")[0]); return l.length > 100 ? l.slice(0, 99) + "…" : l }
const flat = (v) => (Array.isArray(v) ? v.join(" ") : v == null ? "" : String(v))
const join = (...parts) => parts.map(flat).filter(Boolean).join("\n")

// A short excerpt around the first match, on one line.
export function snippet(text, terms, width = 160) {
  const s = store.oneLine(text)
  if (s.length <= width) return s
  const low = s.toLowerCase()
  const at = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0), Infinity)
  if (at === Infinity) return s.slice(0, width - 1) + "…"
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), s.length - width))
  return (start > 0 ? "…" : "") + s.slice(start, start + width).trim() + (start + width < s.length ? "…" : "")
}

// An ID-like term (BG-3, BG-D2) matches whole IDs only, so BG-3 doesn't find BG-30.
const ID_TERM = /^[a-z][a-z0-9]*-d?\d+$/
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
function matcher(t) {
  if (!ID_TERM.test(t)) return (text) => text.includes(t)
  const re = new RegExp(`(?<![a-z0-9-])${esc(t)}(?![0-9])`)
  return (text) => re.test(text)
}

// Current records first, then by how well the main text matches, then newest.
const BASE = { workstream: 50, item: 40, decision: 40, inbox: 20, log: 20 }

function score(rec, terms, phrase, tests) {
  let s = BASE[rec.kind]
  if (terms.length === 1 && rec.id.toLowerCase() === terms[0]) s += 100
  if (rec.state === "closed" || rec.state === "superseded") s -= 30
  const main = rec.main.toLowerCase()
  if (tests.every((m) => m(main))) s += 10
  if (terms.length > 1 && main.includes(phrase)) s += 10
  return s
}

async function records({ ws, kinds }) {
  const want = (k) => !kinds || kinds.includes(k)
  const broken = []
  const list = (await store.listWorkstreams({ broken })).filter((w) => !ws || w.id === ws)
  if (ws && !list.length) throw new Error(`No workstream "${ws}"`)
  const out = []
  for (const w of list) {
    const base = { ws: w.id, wsTitle: w.title, wsStatus: w.status }
    if (want("workstream")) {
      out.push({ ...base, kind: "workstream", id: w.id, state: w.status, main: join(w.id, w.title, w.group),
        body: join(w.id, w.title, w.group, w.waiting_on, w.cwd && store.tildify(w.cwd), w.brief), date: new Date(w.lastActivity).toISOString() })
    }
    if (want("item")) {
      for (const i of (await store.readOpen(w.id)).items) {
        out.push({ ...base, kind: "item", id: i.id, state: i.done ? "closed" : "open", waiting: i.waiting, closed: i.closed,
          main: join(i.id, i.text), body: join(i.id, i.text, i.waiting, i.closed, i.extra), date: i.closed ? String(i.closed).slice(0, 10) : null })
      }
    }
    if (want("decision")) {
      for (const d of (await store.readDecisions(w.id)).decisions) {
        out.push({ ...base, kind: "decision", id: d.id, state: d.active ? "active" : "superseded", superseded_by: d.superseded_by,
          main: join(d.id, d.text), body: join(d.id, d.text, d.why, d.rejected, d.evidence, d.extra), date: d.date })
      }
    }
    if (want("log")) {
      for (const l of w.logs) {
        out.push({ ...base, kind: "log", id: path.basename(l.file, ".md"), state: "logged", session: l.session || null, tool: l.tool || "",
          main: join(l.title, l.summary), body: join(l.title, l.summary, l.cwd, l.files_touched, l.closed, l.added), date: l.ended ? String(l.ended) : null, title: l.title || firstLine(l.summary), titled: Boolean(l.title) })
      }
    }
  }
  if (want("inbox") && !ws) {
    for (const r of await listInbox()) {
      out.push({ ws: null, wsTitle: null, wsStatus: null, kind: "inbox", id: path.basename(r.file, ".md"), state: "unassigned", session: r.session || null, tool: r.tool || "",
        main: join(r.title), body: join(r.title, r.cwd, r.files_touched), date: r.ended ? String(r.ended) : null, title: r.title || "" })
    }
  }
  return { out, broken }
}

/**
 * search("vercel deploy", { ws, kinds, current, limit }) →
 *   { query, terms, total, results: [{ kind, ws, wsTitle, id, state, text, snippet, date, … }], workstreams, broken }
 * current: drop closed items, superseded decisions and archived/done workstreams' records.
 */
export async function search(query, { ws, kinds, current = false, limit = 50 } = {}) {
  const terms = parseQuery(query)
  if (!terms.length) throw new Error("empty search")
  if (kinds) {
    kinds = [].concat(kinds).flatMap((k) => String(k).split(",")).map((k) => k.trim().toLowerCase()).filter(Boolean)
      .map((k) => (KINDS.includes(k) || !KINDS.includes(k.replace(/e?s$/, "")) ? k : k.replace(/e?s$/, "")))
    const bad = kinds.filter((k) => !KINDS.includes(k))
    if (bad.length) throw new Error(`unknown kind ${bad.join(", ")} (use ${KINDS.join(", ")})`)
  }
  const { out, broken } = await records({ ws, kinds })
  const phrase = terms.join(" ")
  const tests = terms.map(matcher)
  const hits = out
    .filter((r) => !current || !["closed", "superseded"].includes(r.state) && !["done", "archived"].includes(r.wsStatus))
    .filter((r) => { const b = r.body.toLowerCase(); return tests.every((m) => m(b)) })
    .map((r) => ({ r, s: score(r, terms, phrase, tests) }))
    .sort((a, b) => b.s - a.s || String(b.r.date || "").localeCompare(String(a.r.date || "")))
  const results = hits.slice(0, Math.max(1, Number(limit) || 50)).map(({ r }) => {
    const { main, body, titled, ...rest } = r
    // A session without a title is shown by its matching excerpt alone.
    if (r.kind === "log" && !titled) return { ...rest, text: snippet(body, terms), snippet: null }
    const mainHit = tests.every((m) => m(main.toLowerCase()))
    const text = r.kind === "item" || r.kind === "decision" ? store.oneLine(main.slice(r.id.length)) : r.kind === "workstream" ? r.wsTitle : r.title || ""
    if (r.kind === "log") {
      const inTitle = tests.every((m) => m(r.title.toLowerCase()))
      return { ...rest, text, snippet: inTitle ? null : snippet(body.slice(r.title.length), terms) }
    }
    return { ...rest, text, snippet: mainHit ? null : snippet(body.slice(main.length), terms) }
  })
  // Every workstream with a hit, not just those in the first `limit` results (the board filters its columns by this).
  const workstreams = [...new Set(hits.map(({ r }) => r.ws).filter(Boolean))]
  return { query: String(query), terms, total: hits.length, results, workstreams, broken }
}

// One plain-text line per result, shared by the CLI and the MCP tool. The state tag
// leads, so a closed item or superseded decision can't be read as current.
export function formatResult(r) {
  const day = r.date ? String(r.date).slice(0, 10) : ""
  const tag = {
    workstream: `[workstream, ${r.state}]`,
    item: r.state === "closed" ? `[closed item${r.date ? ` ${r.date}` : ""}]` : `[open item${r.waiting ? `, waiting on ${r.waiting}` : ""}]`,
    decision: r.state === "superseded" ? `[superseded decision${r.superseded_by ? ` → ${r.superseded_by}` : ""}]` : `[decision${day ? ` ${day}` : ""}]`,
    log: `[session ${day}${r.tool ? ` ${r.tool}` : ""}]`,
    inbox: `[inbox session ${day}${r.tool ? ` ${r.tool}` : ""}]`,
  }[r.kind]
  const where = r.ws ? `${r.ws}${r.wsStatus && !["active", "waiting"].includes(r.wsStatus) && r.kind !== "workstream" ? ` (${r.wsStatus})` : ""}` : "inbox"
  const head = r.kind === "item" || r.kind === "decision" ? `${r.id} ${r.text}` : r.kind === "workstream" ? r.text : r.text || "(untitled)"
  return `${tag} ${where} · ${head}${r.snippet ? `\n    ${r.snippet}` : ""}`
}
