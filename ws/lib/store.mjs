// Workstream store: markdown files on disk.
// Layout (see docs/ARCHITECTURE.md):  $WS_ROOT/ws/<id>/{WORKSTREAM.md, open.md, log/*.md}
//                        $WS_ROOT/procedures/<name>.md
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import matter from "gray-matter"

// gray-matter caches parses by text and shares the data object; mutating it poisons
// later reads of identical text. Passing options disables the cache.
const parseMd = (text) => matter(text, {})

// $WS_ROOT, else $XDG_DATA_HOME/ws, else ~/.local/share/ws.
export function defaultRoot(env = process.env) {
  if (env.WS_ROOT) return expand(env.WS_ROOT)
  if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) return path.join(env.XDG_DATA_HOME, "ws")
  return path.join(os.homedir(), ".local", "share", "ws")
}

export const ROOT = defaultRoot()
export const WS_DIR = path.join(ROOT, "ws")
export const PROC_DIR = path.join(ROOT, "procedures")

export function expand(p) {
  if (!p) return p
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p
}

export function tildify(p) {
  const h = os.homedir()
  return p.startsWith(h + "/") ? "~" + p.slice(h.length) : p
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

// ---------------------------------------------------------------- workstreams

export async function listWorkstreams() {
  let ids = []
  try { ids = await fs.readdir(WS_DIR) } catch { return [] }
  const out = []
  for (const id of ids) {
    if (id.startsWith(".")) continue
    if (!(await exists(path.join(WS_DIR, id, "WORKSTREAM.md")))) continue
    out.push(await getWorkstream(id))
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}

export async function getWorkstream(id) {
  const dir = path.join(WS_DIR, id)
  const file = path.join(dir, "WORKSTREAM.md")
  let raw
  try { raw = await fs.readFile(file, "utf-8") } catch {
    throw new Error(`No workstream "${id}" (looked in ${tildify(dir)})`)
  }
  const { data, content } = parseMd(raw)
  const logs = await listLogs(id)
  const stat = await fs.stat(file)
  // Work happens in sessions: staleness counts from the newest session end, not file edits.
  const ends = logs.map((l) => Date.parse(l.ended)).filter((t) => !Number.isNaN(t))
  const created = Date.parse(data.created)
  const lastActivity = ends.length ? Math.max(...ends) : !Number.isNaN(created) ? created : stat.birthtimeMs
  return {
    id,
    dir,
    file,
    title: data.title || id,
    group: data.group || "",
    status: data.status || "active",
    waiting_on: data.waiting_on || "",
    cwd: data.cwd ? expand(data.cwd) : null,
    tool: data.tool || "claude",
    prefix: data.prefix || id.split("-").map((w) => w[0]).join("").toUpperCase(),
    procedure: data.procedure || null,
    vars: data.vars || {},
    sources: (data.sources || []).map((s) => ({ ...s, path: expand(s.path) })),
    input: data.input || "Goal for this session:",
    brief: content.trim(),
    logs,
    lastActivity,
    data,
  }
}

export async function createWorkstream(id, fields) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("id must be kebab-case")
  const dir = path.join(WS_DIR, id)
  if (await exists(dir)) throw new Error(`${id} already exists`)
  await fs.mkdir(path.join(dir, "log"), { recursive: true })
  const data = { id, status: "active", tool: "claude", created: new Date().toISOString(), sources: [], ...fields }
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k]
  await fs.writeFile(path.join(dir, "WORKSTREAM.md"), matter.stringify("\n", data))
  await writeOpen(id, { next: 1, items: [] }, data.title || id)
  return getWorkstream(id)
}

export async function updateWorkstream(id, patch) {
  const file = path.join(WS_DIR, id, "WORKSTREAM.md")
  const { data, content } = parseMd(await fs.readFile(file, "utf-8"))
  Object.assign(data, patch)
  await fs.writeFile(file, matter.stringify(content, data))
}

// ------------------------------------------------- archive, delete (trash), restore
// Archive keeps a workstream but hides it everywhere (board, picker, matching, stale).
// Delete moves it, and its pending drafts, into $WS_ROOT/.trash so it can be restored;
// only emptyTrash removes anything for good.

export const TRASH_DIR = path.join(ROOT, ".trash")
export const STATUSES = ["active", "waiting", "parked", "done", "archived"]

export async function archiveWorkstream(id) {
  const ws = await getWorkstream(id)
  if (ws.status === "archived") throw new Error(`${id} is already archived`)
  await updateWorkstream(id, { status: "archived", archived_from: ws.status, archived_at: new Date().toISOString() })
  return { from: ws.status }
}

export async function unarchiveWorkstream(id) {
  const ws = await getWorkstream(id)
  if (ws.status !== "archived") throw new Error(`${id} isn't archived`)
  const to = STATUSES.includes(ws.data.archived_from) && ws.data.archived_from !== "archived" ? ws.data.archived_from : "done"
  const file = path.join(WS_DIR, id, "WORKSTREAM.md")
  const { data, content } = parseMd(await fs.readFile(file, "utf-8"))
  data.status = to
  delete data.archived_from
  delete data.archived_at
  await fs.writeFile(file, matter.stringify(content, data))
  return { to }
}

export async function deleteWorkstream(id) {
  const ws = await getWorkstream(id)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = path.join(TRASH_DIR, `${id}__${stamp}`)
  await fs.mkdir(dest, { recursive: true })
  await fs.rename(ws.dir, path.join(dest, "ws"))
  // Pending drafts and queued summaries go with it, so nothing resurfaces.
  const props = path.join(ROOT, "proposals", id)
  if (await exists(props)) await fs.rename(props, path.join(dest, "proposals"))
  const qdir = path.join(ROOT, "queue")
  let queued = []
  try { queued = (await fs.readdir(qdir)).filter((f) => f.endsWith(".json")) } catch {}
  for (const f of queued) {
    try {
      const job = JSON.parse(await fs.readFile(path.join(qdir, f), "utf-8"))
      if (job.ws === id) {
        await fs.mkdir(path.join(dest, "queue"), { recursive: true })
        await fs.rename(path.join(qdir, f), path.join(dest, "queue", f))
      }
    } catch {}
  }
  await fs.writeFile(path.join(dest, "TRASHED.json"), JSON.stringify({ id, title: ws.title, deleted_at: new Date().toISOString() }, null, 2))
  return { trash: path.basename(dest) }
}

export async function listTrash() {
  let names = []
  try { names = (await fs.readdir(TRASH_DIR)).filter((n) => !n.startsWith(".")) } catch { return [] }
  const out = []
  for (const name of names.sort().reverse()) {
    let meta = {}
    try { meta = JSON.parse(await fs.readFile(path.join(TRASH_DIR, name, "TRASHED.json"), "utf-8")) } catch {}
    out.push({ name, id: meta.id || name.split("__")[0], title: meta.title || "", deleted_at: meta.deleted_at || "" })
  }
  return out
}

export async function restoreWorkstream(name) {
  const src = path.join(TRASH_DIR, path.basename(name))
  if (!(await exists(path.join(src, "ws")))) throw new Error(`Nothing to restore at ${tildify(src)}`)
  const { id } = JSON.parse(await fs.readFile(path.join(src, "TRASHED.json"), "utf-8"))
  if (await exists(path.join(WS_DIR, id))) throw new Error(`A workstream "${id}" already exists; rename or delete it first`)
  await fs.mkdir(WS_DIR, { recursive: true })
  await fs.rename(path.join(src, "ws"), path.join(WS_DIR, id))
  if (await exists(path.join(src, "proposals"))) {
    await fs.mkdir(path.join(ROOT, "proposals"), { recursive: true })
    await fs.rename(path.join(src, "proposals"), path.join(ROOT, "proposals", id))
  }
  if (await exists(path.join(src, "queue"))) {
    await fs.mkdir(path.join(ROOT, "queue"), { recursive: true })
    for (const f of await fs.readdir(path.join(src, "queue"))) await fs.rename(path.join(src, "queue", f), path.join(ROOT, "queue", f))
  }
  await fs.rm(src, { recursive: true, force: true })
  return { id }
}

export async function emptyTrash(name) {
  const targets = name ? [path.basename(name)] : (await listTrash()).map((t) => t.name)
  for (const t of targets) await fs.rm(path.join(TRASH_DIR, t), { recursive: true, force: true })
  return targets.length
}

// ----------------------------------------------------------------- procedures

export async function getProcedure(name) {
  const file = path.join(PROC_DIR, `${name}.md`)
  let raw
  try { raw = await fs.readFile(file, "utf-8") } catch {
    throw new Error(`No procedure "${name}" (looked in ${tildify(file)})`)
  }
  const { data, content } = parseMd(raw)
  return { name, file, data, body: content.trim() }
}

export function variablesIn(text) {
  return [...new Set([...text.matchAll(/{{\s*([\w.-]+)\s*}}/g)].map((m) => m[1]))]
}

export function fillVars(text, vars) {
  return text.replace(/{{\s*([\w.-]+)\s*}}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

// ----------------------------------------------------------------- open items
// open.md is written only through these functions, under a lock.

const ITEM_RE = /^- \[( |x)\] ([A-Z][A-Z0-9]*-\d+) (.*)$/

export function parseOpen(text) {
  const next = Number(text.match(/<!-- next: (\d+) -->/)?.[1] || 0)
  const items = []
  for (const line of text.split("\n")) {
    const m = line.match(ITEM_RE)
    if (!m) continue
    let rest = m[3]
    let waiting = null
    let closed = null
    const w = rest.match(/\s*@waiting:(\S+)/)
    if (w) { waiting = w[1].replace(/_/g, " "); rest = rest.replace(w[0], "") }
    const c = rest.match(/\s*\(closed ([^)]*)\)\s*$/)
    if (c) { closed = c[1]; rest = rest.replace(c[0], "") }
    items.push({ id: m[2], done: m[1] === "x", text: rest.trim(), waiting, closed })
  }
  const maxN = Math.max(0, ...items.map((i) => Number(i.id.split("-").pop())))
  return { next: Math.max(next, maxN + 1), items }
}

function renderItem(i) {
  let s = `- [${i.done ? "x" : " "}] ${i.id} ${i.text}`
  if (i.waiting) s += ` @waiting:${i.waiting.replace(/ /g, "_")}`
  if (i.closed) s += ` (closed ${i.closed})`
  return s
}

export function renderOpen({ next, items }, title) {
  const open = items.filter((i) => !i.done)
  const closed = items.filter((i) => i.done)
  return [
    `# Open items: ${title}`,
    "<!-- managed by ws; change with `ws item` -->",
    `<!-- next: ${next} -->`,
    "",
    ...(open.length ? open.map(renderItem) : ["_(none)_"]),
    "",
    "## Closed",
    "",
    ...closed.map(renderItem),
    "",
  ].join("\n")
}

export async function readOpen(id) {
  try {
    return parseOpen(await fs.readFile(path.join(WS_DIR, id, "open.md"), "utf-8"))
  } catch {
    return { next: 1, items: [] }
  }
}

async function writeOpen(id, state, title) {
  await fs.writeFile(path.join(WS_DIR, id, "open.md"), renderOpen(state, title))
}

async function withLock(file, fn) {
  const lock = file + ".lock"
  const start = Date.now()
  for (;;) {
    try { await fs.mkdir(lock); break } catch (e) {
      if (e.code !== "EEXIST") throw e
      try {
        if (Date.now() - (await fs.stat(lock)).mtimeMs > 30_000) { await fs.rm(lock, { recursive: true, force: true }); continue }
      } catch {}
      if (Date.now() - start > 5000) throw new Error(`Timed out waiting for lock ${tildify(lock)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try { return await fn() } finally { await fs.rm(lock, { recursive: true, force: true }) }
}

async function mutateOpen(id, fn) {
  const ws = await getWorkstream(id)
  const result = await withLock(path.join(ws.dir, "open.md"), async () => {
    const state = await readOpen(id)
    const result = fn(state, ws)
    await writeOpen(id, state, ws.title)
    return result
  })
  try { await syncMirror(id) } catch {} // best effort; `ws mirror` reports problems
  return result
}

// ---------------------------------------------------------------- mirror block
// Opt-in: a generated open-items block inside a project doc. ws owns
// only the text between the markers. A doc touched in the last 2 minutes may be
// mid-edit by a live session, so it is left alone until the next sync.

export const MIRROR_QUIET_MS = 2 * 60_000
const mirrorStart = (id) => `<!-- ws:open ${id}`
const MIRROR_END = "<!-- /ws:open -->"

export async function renderMirror(id) {
  const { items } = await readOpen(id)
  const open = items.filter((i) => !i.done)
  return [
    `${mirrorStart(id)}: generated by ws. Change items with \`ws item\`, not here. -->`,
    `_Open items (ws, updated ${today()}):_`,
    "",
    ...(open.length ? open.map((i) => `- ${i.id} ${i.text}${i.waiting ? ` (waiting on ${i.waiting})` : ""}`) : ["- (none)"]),
    MIRROR_END,
  ].join("\n")
}

export async function syncMirror(id, { force = false, init = false } = {}) {
  const ws = await getWorkstream(id)
  if (!ws.data.mirror) return { action: "none" }
  const file = expand(ws.data.mirror)
  const stat = await fs.stat(file)
  if (!force && Date.now() - stat.mtimeMs < MIRROR_QUIET_MS) return { action: "deferred", file }
  const text = await fs.readFile(file, "utf-8")
  const start = text.indexOf(mirrorStart(id))
  const end = start >= 0 ? text.indexOf(MIRROR_END, start) : -1
  const block = await renderMirror(id)
  let next
  if (start >= 0 && end > start) next = text.slice(0, start) + block + text.slice(end + MIRROR_END.length)
  else if (init) next = text.replace(/\s*$/, "\n\n") + block + "\n"
  else return { action: "missing-block", file }
  if (next === text) return { action: "unchanged", file }
  // Re-check right before writing: bail if the doc changed while we rendered.
  if ((await fs.stat(file)).mtimeMs !== stat.mtimeMs) return { action: "deferred", file }
  const tmp = `${file}.ws-tmp`
  await fs.writeFile(tmp, next)
  await fs.rename(tmp, file)
  return { action: "written", file }
}

export function addItem(id, text, { waiting } = {}) {
  return mutateOpen(id, (state, ws) => {
    const item = { id: `${ws.prefix}-${state.next}`, done: false, text, waiting: waiting || null, closed: null }
    state.next += 1
    state.items.push(item)
    return item
  })
}

export function closeItem(id, itemId, { session, note } = {}) {
  return mutateOpen(id, (state) => {
    const item = state.items.find((i) => i.id.toUpperCase() === itemId.toUpperCase())
    if (!item) throw new Error(`${itemId} not found in ${id}`)
    if (item.done) throw new Error(`${itemId} is already closed`)
    item.done = true
    item.closed = [today(), session && session.slice(0, 8), note].filter(Boolean).join(", ")
    return item
  })
}

export function editItem(id, itemId, { text, waiting }) {
  return mutateOpen(id, (state) => {
    const item = state.items.find((i) => i.id.toUpperCase() === itemId.toUpperCase())
    if (!item) throw new Error(`${itemId} not found in ${id}`)
    if (text) item.text = text
    if (waiting !== undefined) item.waiting = waiting || null
    return item
  })
}

// ------------------------------------------------------------------ decisions
// decisions.md: settled choices with why and what was rejected, so sessions don't
// reopen them. Superseded, never edited in place; IDs are <PREFIX>-D<n>.
//   - [active] AB-D1 Cream is #F2F2E9 everywhere (2026-11-17)
//     why: the guide palette is the source of truth
//     rejected: #F7F7E7 (only in old logo exports)
//     evidence: "…"
//   - [superseded by AB-D3] AB-D2 …

const DEC_RE = /^- \[(active|superseded(?: by ([A-Z][A-Z0-9]*-D\d+))?)\] ([A-Z][A-Z0-9]*-D\d+) (.*?)(?: \((\d{4}-\d{2}-\d{2})\))?$/
const DEC_FIELDS = ["why", "rejected", "evidence", "session"]

export function parseDecisions(text) {
  const next = Number(text.match(/<!-- next: (\d+) -->/)?.[1] || 0)
  const decisions = []
  let cur = null
  for (const line of text.split("\n")) {
    const m = line.match(DEC_RE)
    if (m) {
      cur = { id: m[3], text: m[4].trim(), date: m[5] || null, active: m[1] === "active", superseded_by: m[2] || null }
      decisions.push(cur)
      continue
    }
    const f = line.match(/^\s+([a-z_]+):\s?(.*)$/)
    if (cur && f && DEC_FIELDS.includes(f[1])) cur[f[1]] = f[2].trim()
  }
  const maxN = Math.max(0, ...decisions.map((d) => Number(d.id.split("-D").pop())))
  return { next: Math.max(next, maxN + 1), decisions }
}

export function renderDecisions({ next, decisions }, title) {
  const one = (d) => [
    `- [${d.active ? "active" : `superseded${d.superseded_by ? ` by ${d.superseded_by}` : ""}`}] ${d.id} ${d.text}${d.date ? ` (${d.date})` : ""}`,
    ...DEC_FIELDS.filter((k) => d[k]).map((k) => `  ${k}: ${String(d[k]).replace(/\n/g, " ")}`),
  ].join("\n")
  const active = decisions.filter((d) => d.active)
  const old = decisions.filter((d) => !d.active)
  return [
    `# Decisions: ${title}`,
    "<!-- managed by ws; change with `ws decide` -->",
    `<!-- next: ${next} -->`,
    "",
    ...(active.length ? active.map(one) : ["_(none)_"]),
    "",
    "## Superseded",
    "",
    ...old.map(one),
    "",
  ].join("\n")
}

export async function readDecisions(id) {
  try {
    return parseDecisions(await fs.readFile(path.join(WS_DIR, id, "decisions.md"), "utf-8"))
  } catch {
    return { next: 1, decisions: [] }
  }
}

export async function decide(id, text, { why, rejected, evidence, session, supersedes } = {}) {
  const ws = await getWorkstream(id)
  const file = path.join(ws.dir, "decisions.md")
  const result = await withLock(file, async () => {
    const state = await readDecisions(id)
    let old = null
    if (supersedes) {
      old = state.decisions.find((d) => d.id.toUpperCase() === String(supersedes).toUpperCase())
      if (!old) throw new Error(`${supersedes} not found in ${id}`)
      if (!old.active) throw new Error(`${supersedes} is already superseded`)
    }
    const d = { id: `${ws.prefix}-D${state.next}`, text: String(text).trim(), date: today(), active: true, superseded_by: null,
      why: why || undefined, rejected: Array.isArray(rejected) ? rejected.join("; ") : rejected || undefined, evidence: evidence || undefined, session: session || undefined }
    if (!d.text) throw new Error("decision text is empty")
    state.next += 1
    state.decisions.push(d)
    if (old) { old.active = false; old.superseded_by = d.id }
    await fs.writeFile(file, renderDecisions(state, ws.title))
    return { decision: d, superseded: old?.id || null }
  })
  return result
}

// ----------------------------------------------------------------------- logs
// One file per session, never rewritten.

export async function listLogs(id) {
  const dir = path.join(WS_DIR, id, "log")
  let files = []
  try { files = await fs.readdir(dir) } catch { return [] }
  const logs = []
  for (const f of files.filter((f) => f.endsWith(".md")).sort()) {
    const file = path.join(dir, f)
    const { data, content } = parseMd(await fs.readFile(file, "utf-8"))
    const { mtimeMs } = await fs.stat(file)
    logs.push({ file, ...data, summary: content.trim(), mtimeMs })
  }
  return logs.sort((a, b) => String(a.ended || "").localeCompare(String(b.ended || "")) || a.mtimeMs - b.mtimeMs)
}

export async function appendLog(id, entry) {
  const ws = await getWorkstream(id)
  const now = new Date()
  const tag = entry.session ? sessionTag(entry.session) : "manual-" + now.toISOString().slice(11, 19).replace(/:/g, "")
  const dir = path.join(ws.dir, "log")
  await fs.mkdir(dir, { recursive: true })
  let file = path.join(dir, `${today()}_${tag}.md`)
  for (let n = 2; await exists(file); n++) file = path.join(dir, `${today()}_${tag}-${n}.md`)
  const { summary = "", ...meta } = entry
  const data = { ended: now.toISOString(), source: "manual", ...meta }
  for (const k of Object.keys(data)) if (data[k] === undefined || data[k] === null) delete data[k]
  await fs.writeFile(file, matter.stringify(`\n${summary.trim()}\n`, data), { flag: "wx" })
  return file
}

// Codex IDs are time-ordered UUIDs, so the first 8 chars collide within a minute; add the tail.
export function sessionTag(id) {
  const hex = id.replace(/-/g, "")
  return hex.length > 14 ? `${hex.slice(0, 8)}-${hex.slice(-6)}` : id
}

export function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
