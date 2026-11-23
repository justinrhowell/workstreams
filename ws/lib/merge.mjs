// Three-way merges for the files ws owns, used by `ws sync` as a git merge driver.
// Git would merge open.md line by line and leave conflict markers when two machines add an
// item at the same time (both write `<!-- next: N -->` and both take the same ID). ws refuses
// to write a file with lines it can't parse, so a marker would stop the workstream. These
// merges work on records instead: base is the common ancestor, ours the local version,
// theirs the version being merged in (another machine's, already pushed).
//
// Rules, per record (item or decision, matched by ID):
// - a change on one side only wins;
// - closed beats open, superseded beats active (closing is never undone by a merge);
// - text changed on both sides: theirs is kept (other machines may already show it) and
//   ours is kept under it as an indented "also:" line, so nothing typed is lost;
// - the same new ID on both sides with different text: theirs keeps the ID (it was published
//   first) and ours is renumbered to the next free one. The renumbering is reported.
// Free text (notes, extra lines) is merged as a union, ours first.
import matter from "gray-matter"
import { parseOpen, renderOpen, parseDecisions, renderDecisions, normalizeEol, oneLine } from "./store.mjs"

const parseMd = (text) => matter(text, {})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const numOf = (id, sep) => Number(String(id).split(sep).pop())

function titleOf(text, kind) {
  return normalizeEol(text || "").match(new RegExp(`^# ${kind}: (.*)$`, "m"))?.[1] ?? ""
}

function unionLines(...lists) {
  const out = []
  for (const l of lists) for (const x of l || []) if (!out.includes(x)) out.push(x)
  return out
}

// Field-wise three-way merge of one record. `closedField` decides which side "wins" a
// both-sides state change (closed/superseded beats open/active).
function mergeRecord(b, o, t, { stateKeys, stronger, textKey = "text" }) {
  if (!o) return t
  if (!t) return o
  if (same(o, t)) return o
  const r = { ...o }
  b = b || {}
  for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
    if (k === "extra" || stateKeys.includes(k) || k === textKey) continue
    if (same(o[k], t[k])) continue
    r[k] = same(o[k], b[k]) ? t[k] : o[k] // changed on one side: take it; on both: ours
  }
  // State: a one-sided change wins; a both-sides change goes to the stronger state.
  const st = (x) => Object.fromEntries(stateKeys.map((k) => [k, x[k]]))
  if (!same(st(o), st(t))) {
    const pick = same(st(o), st(b)) ? t : same(st(t), st(b)) ? o : stronger(o, t)
    for (const k of stateKeys) r[k] = pick[k]
  }
  // Text: one-sided change wins; both changed: theirs, with ours kept as an "also:" line.
  const extra = unionLines(o.extra, t.extra)
  if (o[textKey] !== t[textKey]) {
    if (o[textKey] === b[textKey]) r[textKey] = t[textKey]
    else if (t[textKey] === b[textKey]) r[textKey] = o[textKey]
    else {
      r[textKey] = t[textKey]
      const also = `also: ${oneLine(o[textKey])}`
      if (!extra.includes(also)) extra.push(also)
    }
  }
  r.extra = extra
  return r
}

// Records added on both sides under the same ID with different content: theirs keeps the
// ID, ours moves to a fresh one. Returns the merged list in a stable order and the renames.
function mergeRecords(base, ours, theirs, { idOf, renumber, merge }) {
  const bm = new Map(base.map((r) => [idOf(r), r]))
  const om = new Map(ours.map((r) => [idOf(r), r]))
  const tm = new Map(theirs.map((r) => [idOf(r), r]))
  const out = []
  const moved = []
  const ids = unionLines(ours.map(idOf), theirs.map(idOf))
  for (const id of ids) {
    const b = bm.get(id), o = om.get(id), t = tm.get(id)
    if (o && t && !b && !same(o, t)) {
      out.push(t)
      moved.push(o) // renumbered below, once every taken ID is known
      continue
    }
    out.push(merge(b, o, t))
  }
  const renames = []
  for (const o of moved) {
    const newId = renumber(out)
    renames.push([idOf(o), newId])
    out.push({ ...o, id: newId })
  }
  return { records: out, renames }
}

export function mergeOpenText(baseText, oursText, theirsText) {
  const b = parseOpen(baseText || ""), o = parseOpen(oursText || ""), t = parseOpen(theirsText || "")
  for (const [name, s] of [["ours", o], ["theirs", t]]) {
    if (s.unparsed.length) throw new Error(`open.md (${name}) has item lines ws can't read: ${s.unparsed[0]}`)
  }
  const prefix = (o.items[0] || t.items[0] || b.items[0])?.id.split("-")[0]
  let next = Math.max(b.next, o.next, t.next)
  const { records, renames } = mergeRecords(b.items, o.items, t.items, {
    idOf: (i) => i.id,
    renumber: (taken) => {
      next = Math.max(next, ...taken.map((i) => numOf(i.id, "-") + 1))
      return `${prefix}-${next++}`
    },
    merge: (bi, oi, ti) => mergeRecord(bi, oi, ti, {
      stateKeys: ["done", "closed"],
      stronger: (x, y) => (x.done ? x : y),
    }),
  })
  next = Math.max(next, ...records.map((i) => numOf(i.id, "-") + 1))
  const title = titleOf(oursText, "Open items") || titleOf(theirsText, "Open items") || titleOf(baseText, "Open items")
  // Open items keep ours' order with theirs' new ones after; renderOpen splits open/closed.
  return { text: renderOpen({ next, items: records, notes: unionLines(o.notes, t.notes) }, title), renames }
}

export function mergeDecisionsText(baseText, oursText, theirsText) {
  const b = parseDecisions(baseText || ""), o = parseDecisions(oursText || ""), t = parseDecisions(theirsText || "")
  for (const [name, s] of [["ours", o], ["theirs", t]]) {
    if (s.unparsed.length) throw new Error(`decisions.md (${name}) has decision lines ws can't read: ${s.unparsed[0]}`)
  }
  const prefix = (o.decisions[0] || t.decisions[0] || b.decisions[0])?.id.split("-D")[0]
  let next = Math.max(b.next, o.next, t.next)
  const { records, renames } = mergeRecords(b.decisions, o.decisions, t.decisions, {
    idOf: (d) => d.id,
    renumber: (taken) => {
      next = Math.max(next, ...taken.map((d) => numOf(d.id, "-D") + 1))
      return `${prefix}-D${next++}`
    },
    merge: (bd, od, td) => mergeRecord(bd, od, td, {
      stateKeys: ["active", "superseded_by"],
      stronger: (x, y) => (!x.active ? x : y),
    }),
  })
  // A renumbered decision may be the one an older decision points at ("superseded by").
  const map = new Map(renames)
  for (const d of records) if (d.superseded_by && map.has(d.superseded_by)) {
    const local = o.decisions.find((x) => x.superseded_by === d.superseded_by && x.id === d.id)
    if (local) d.superseded_by = map.get(d.superseded_by)
  }
  next = Math.max(next, ...records.map((d) => numOf(d.id, "-D") + 1))
  const title = titleOf(oursText, "Decisions") || titleOf(theirsText, "Decisions") || titleOf(baseText, "Decisions")
  return { text: renderDecisions({ next, decisions: records, notes: unionLines(o.notes, t.notes) }, title), renames }
}

// WORKSTREAM.md: frontmatter key by key (a one-sided change wins; both sides: ours, except
// `sources`, which is merged as a union by path), and the brief as a whole (one-sided change
// wins; both changed: ours, with theirs appended under a marker so nothing is lost).
export function mergeWorkstreamText(baseText, oursText, theirsText) {
  const b = parseMd(normalizeEol(baseText || "")), o = parseMd(normalizeEol(oursText || "")), t = parseMd(normalizeEol(theirsText || ""))
  const data = { ...o.data }
  for (const k of new Set([...Object.keys(o.data), ...Object.keys(t.data)])) {
    const bv = b.data[k], ov = o.data[k], tv = t.data[k]
    if (same(ov, tv)) continue
    if (same(ov, bv)) { if (tv === undefined) delete data[k]; else data[k] = tv; continue }
    if (same(tv, bv)) continue
    if (k === "sources" && Array.isArray(ov) && Array.isArray(tv)) {
      const seen = new Set(ov.map((s) => JSON.stringify([s.path, s.section || ""])))
      data[k] = [...ov, ...tv.filter((s) => !seen.has(JSON.stringify([s.path, s.section || ""])))]
    }
  }
  const bb = b.content.trim(), ob = o.content.trim(), tb = t.content.trim()
  let body = ob
  if (ob !== tb) {
    if (ob === bb) body = tb
    else if (tb !== bb) body = `${ob}\n\n<!-- ws sync: also edited on another machine -->\n${tb}`
  }
  return { text: matter.stringify(`\n${body ? body + "\n" : ""}`, data), renames: [] }
}

// Which merge applies to a repo-relative path; null means "not a ws record file".
export function mergerFor(relPath) {
  const name = String(relPath).split("/").pop()
  if (!/(^|\/)ws\/[^/]+\/[^/]+$/.test(relPath)) return null
  return { "open.md": mergeOpenText, "decisions.md": mergeDecisionsText, "WORKSTREAM.md": mergeWorkstreamText }[name] || null
}
