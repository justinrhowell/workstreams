// Workstream store: markdown files on disk.
// Layout (see docs/ARCHITECTURE.md):  $WS_ROOT/ws/<id>/{WORKSTREAM.md, open.md, log/*.md}
//                        $WS_ROOT/procedures/<name>.md
import { promises as fs, constants as fsConstants, readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import matter from "gray-matter"

// gray-matter caches parses by text and shares the data object; mutating it poisons
// later reads of identical text. Passing options disables the cache.
// Front matter must be plain YAML. gray-matter also accepts "---js" (and other languages)
// and evaluates it as code; data synced from another machine must never run here, so any
// opening line other than a bare "---" is refused, and the code engines throw if reached.
const noCode = () => { throw new Error("front matter must be plain YAML") }
export function parseMd(text) {
  text = String(text ?? "")
  const first = text.replace(/^\uFEFF/, "").split("\n", 1)[0]
  if (/^---/.test(first) && first.trim() !== "---") throw new Error(`front matter must start with a bare "---" (found "${first.slice(0, 20)}")`)
  return matter(text, { language: "yaml", engines: { js: noCode, javascript: noCode, coffee: noCode, coffeescript: noCode, cson: noCode } })
}
// Path rewrites from config.json (set once LOCAL is read below; WS_ROOT itself is never mapped).
let localPaths = []

// $WS_ROOT, else $XDG_DATA_HOME/ws, else ~/.local/share/ws.
export function defaultRoot(env = process.env) {
  if (env.WS_ROOT) return path.resolve(expand(env.WS_ROOT))
  if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) return path.join(env.XDG_DATA_HOME, "ws")
  return path.join(os.homedir(), ".local", "share", "ws")
}

export const ROOT = defaultRoot()
// A relative WS_ROOT would mean a different folder for every process (hooks run in each
// project's folder). Commands refuse to run with one; hooks do nothing.
export const ROOT_PROBLEM = process.env.WS_ROOT && !path.isAbsolute(expand(process.env.WS_ROOT))
  ? `WS_ROOT must be an absolute path (got "${process.env.WS_ROOT}")`
  : null
export const WS_DIR = path.join(ROOT, "ws")
export const PROC_DIR = path.join(ROOT, "procedures")

// ------------------------------------------------------------ this machine (sync)
// Read once, synchronously, from config.json (which is never synced: it is this machine's).
// Only the parts the store needs at import time; config.mjs validates the whole file and
// reports problems. Anything malformed here is ignored, so a bad file never breaks hooks.
//   sync.machine  name recorded on logs and inbox entries (default: the host name)
//   sync.remote   git URL of the main data repo (absent: this machine's data stays local)
//   sync.shares   [{ name, match: ["clinic-*", "billing"], remote }]: workstreams whose id
//                 matches live in their own repo, $WS_ROOT/shares/<name>, so a machine can
//                 sync some workstreams without the rest (see docs/SYNC.md)
//   paths         { "<path as stored>": "<path on this machine>" }: prefix rewrites, so a
//                 workstream whose cwd or sources were written on another machine resolves here
function readLocal() {
  let raw = {}
  try { raw = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf-8")) } catch {}
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  const sync = isObj(raw?.sync) ? raw.sync : {}
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
  const shares = (Array.isArray(sync.shares) ? sync.shares : [])
    .filter((s) => isObj(s) && name.test(s.name || "") && Array.isArray(s.match) && s.match.every((m) => typeof m === "string" && /^[a-z0-9*][a-z0-9*-]*$/.test(m)))
    .map((s) => ({ name: s.name, match: s.match, remote: typeof s.remote === "string" && s.remote ? s.remote : null, dir: path.join(ROOT, "shares", s.name) }))
  const paths = Object.entries(isObj(raw?.paths) ? raw.paths : {})
    .filter(([a, b]) => typeof a === "string" && typeof b === "string" && a && b)
    .map(([a, b]) => [a.replace(/\/+$/, ""), b.replace(/\/+$/, "")])
    .sort((x, y) => y[0].length - x[0].length)
  return {
    enabled: typeof sync.remote === "string" || shares.length > 0,
    machine: typeof sync.machine === "string" && name.test(sync.machine) ? sync.machine : os.hostname().split(".")[0],
    remote: typeof sync.remote === "string" && sync.remote ? sync.remote : null,
    auto: sync.auto !== false,
    shares,
    paths,
  }
}
export const LOCAL = readLocal()
localPaths = LOCAL.paths

const globRe = (g) => new RegExp(`^${g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]*")}$`)
// The share a workstream id belongs to, by its id alone (never by where a folder happens to
// be), so a new workstream lands in the right repo on every machine.
export function shareOf(id) {
  return LOCAL.shares.find((s) => s.match.some((g) => globRe(g).test(id))) || null
}
export function wsDir(id) {
  const s = shareOf(id)
  return s ? path.join(s.dir, "ws", id) : path.join(WS_DIR, id)
}
export function proposalsDir(id) {
  const s = shareOf(id)
  return s ? path.join(s.dir, "proposals", id) : path.join(ROOT, "proposals", id)
}
// Every folder that holds workstream folders, and every folder that holds proposal folders.
export const wsRoots = () => [WS_DIR, ...LOCAL.shares.map((s) => path.join(s.dir, "ws"))]
export const proposalRoots = () => [path.join(ROOT, "proposals"), ...LOCAL.shares.map((s) => path.join(s.dir, "proposals"))]

// Paths are stored as written on the machine that wrote them (usually with ~). `paths` in
// config.json maps a stored prefix to this machine's: expand applies it, tildify reverses it,
// so what this machine writes back still reads right on the others.
const underPrefix = (p, pre) => p === pre || p.startsWith(pre + "/")
function mapIn(p) {
  for (const [from, to] of localPaths) if (underPrefix(p, from)) return to + p.slice(from.length)
  return p
}
function mapOut(p) {
  for (const [from, to] of [...localPaths].sort((x, y) => y[1].length - x[1].length)) if (underPrefix(p, to)) return from + p.slice(to.length)
  return p
}

export function expand(p) {
  if (!p) return p
  p = mapIn(p)
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p
}

export function tildify(p) {
  const h = os.homedir()
  return mapOut(p.startsWith(h + "/") ? "~" + p.slice(h.length) : p)
}

// Set when this process writes anything under $WS_ROOT; the CLI and MCP server start a
// background sync afterwards (sync.mjs) when sync is configured.
let dirty = false
export const isDirty = () => dirty
export const clearDirty = () => { dirty = false }
const markDirty = (file) => { if (file.startsWith(ROOT + path.sep)) dirty = true }

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

// Files edited on Windows have CRLF endings; every parser works on LF.
export const normalizeEol = (text) => text.replace(/\r\n?/g, "\n")

// Missing file -> null. Any other read error is real and propagates, so a damaged
// file is never mistaken for an empty one and then overwritten.
export async function readText(file) {
  try { return normalizeEol(await fs.readFile(file, "utf-8")) } catch (e) {
    if (e.code === "ENOENT") return null
    throw e
  }
}

// Write to a unique temp file beside the target, then rename over it. A crash or a
// full disk leaves either the old file or the new one, never a truncated one. A symlinked
// target (dotfiles) is written through to its real file, and the file's mode is kept,
// so a private 0600 file stays private.
export async function writeFileAtomic(file, text) {
  let target = file
  let mode = null
  try {
    // Follow a symlink even when its target doesn't exist yet (a fresh dotfiles link).
    if ((await fs.lstat(file)).isSymbolicLink()) target = path.resolve(path.dirname(file), await fs.readlink(file))
    target = await fs.realpath(target).catch(() => target)
    mode = (await fs.stat(target)).mode & 0o7777
  } catch (e) { if (e.code !== "ENOENT") throw e }
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await fs.writeFile(tmp, text, { flag: "wx", ...(mode !== null ? { mode } : {}) })
    if (mode !== null) await fs.chmod(tmp, mode)
    await fs.rename(tmp, target)
    markDirty(target)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

// Create a file that must not exist yet, all at once: write a temp file, then hard-link
// it into place (link fails with EEXIST instead of replacing anything).
export async function createFileAtomic(file, text) {
  markDirty(file)
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await fs.writeFile(tmp, text, { flag: "wx" })
    try { await fs.link(tmp, file) } catch (e) {
      // Filesystems without hard links (some network and FAT volumes): exclusive create.
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(e.code)) throw e
      await fs.writeFile(file, text, { flag: "wx" })
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

// Record fields are one line in markdown: a newline in item or decision text would
// otherwise create (or forge) another record.
export const oneLine = (s) => String(s ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()

export const PREFIX_RE = /^[A-Z][A-Z0-9]*$/
export function defaultPrefix(id) {
  return id.split("-").map((w) => w.match(/[a-z]/i)?.[0] || "").join("").toUpperCase() || "WS"
}

// ---------------------------------------------------------------- workstreams

// One unreadable workstream (a hand-edit that broke the YAML, a bad `ws set`, a stray
// folder) must not hide the others: hooks, ls, MCP and the board all list through here.
// It is skipped, and pushed onto `broken` for callers that report problems.
// logs: false skips reading session logs (hooks only need cwd and status); lastActivity
// then falls back to the created date.
/** @param {{ broken?: { id: string, error: string }[], logs?: boolean }} [opts] */
export async function listWorkstreams({ broken, logs = true } = {}) {
  const ids = []
  for (const root of wsRoots()) {
    let names = []
    try { names = await fs.readdir(root) } catch { continue }
    // A folder only counts where its id says it lives (a share or the main folder), so a
    // copy left behind in the other place by a move never shows up twice.
    for (const n of names) if (!ids.includes(n) && (!isId(n) || path.dirname(wsDir(n)) === root)) ids.push(n)
  }
  const out = []
  for (const id of ids) {
    if (id.startsWith(".")) continue
    // Absent WORKSTREAM.md: a stray folder, skipped quietly. Any other access error
    // (a folder that denies traversal) is reported, so `ws doctor` and the board see it.
    try { await fs.access(path.join(isId(id) ? wsDir(id) : path.join(WS_DIR, id), "WORKSTREAM.md")) } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") broken?.push({ id, error: `can't read WORKSTREAM.md (${e.code})` })
      continue
    }
    if (!isId(id)) {
      broken?.push({ id, error: "folder name isn't a workstream id (lowercase letters, digits and dashes)" })
      continue
    }
    try {
      out.push(await getWorkstream(id, { logs }))
    } catch (e) {
      // YAML errors carry a multi-line code frame; the first line says what and where.
      broken?.push({ id, error: String(e instanceof Error ? e.message : e).split("\n")[0].replace(/:\s*$/, "") })
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}

// Workstream ids are folder names under WS_DIR; anything else (../x, a/b) is refused
// before a path is built from it.
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/
export function isId(id) { return typeof id === "string" && ID_RE.test(id) }
export function assertId(id) {
  if (!isId(id)) throw new Error(`No workstream "${id}" (ids are lowercase letters, digits and dashes)`)
  return id
}

export async function getWorkstream(id, { logs: withLogs = true } = {}) {
  const dir = isId(id) ? wsDir(id) : path.join(WS_DIR, id)
  const file = path.join(dir, "WORKSTREAM.md")
  const raw = isId(id) ? await readText(file) : null
  if (raw === null) throw new Error(`No workstream "${id}" (looked in ${tildify(dir)})`)
  const { data, content } = parseMd(raw)
  const logs = withLogs ? await listLogs(id) : []
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
    prefix: data.prefix || defaultPrefix(id),
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
  if (!isId(id)) throw new Error("id must be kebab-case")
  const dir = wsDir(id)
  if (await exists(dir)) throw new Error(`${id} already exists`)
  if (fields?.prefix !== undefined) {
    fields = { ...fields, prefix: String(fields.prefix).toUpperCase() }
    if (!PREFIX_RE.test(fields.prefix)) throw new Error("prefix must be letters and digits, starting with a letter (e.g. AB)")
  }
  for (const k of ["title", "waiting_on", "group"]) if (fields?.[k] !== undefined) fields = { ...fields, [k]: oneLine(fields[k]) }
  // The folder itself is the reservation: of two creators, only one mkdir succeeds, so the
  // loser can't overwrite the winner's WORKSTREAM.md or reset its open items.
  await fs.mkdir(path.dirname(dir), { recursive: true })
  try { await fs.mkdir(dir) } catch (e) {
    if (e.code === "EEXIST") throw new Error(`${id} already exists`)
    throw e
  }
  await fs.mkdir(path.join(dir, "log"), { recursive: true })
  const data = { id, status: "active", tool: "claude", created: new Date().toISOString(), sources: [], ...fields }
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k]
  await writeFileAtomic(path.join(dir, "WORKSTREAM.md"), matter.stringify("\n", data))
  await writeOpen(id, { next: 1, items: [] }, data.title || id)
  return getWorkstream(id)
}

// patch is an object to merge, or a function that edits `data` in place (and may
// return a result). Runs under the workstream's lock, so concurrent updates don't
// lose each other's fields.
export async function updateWorkstream(id, patch) {
  assertId(id)
  const file = path.join(wsDir(id), "WORKSTREAM.md")
  return withLock(file, async () => {
    const raw = await readText(file)
    if (raw === null) throw new Error(`No workstream "${id}"`)
    const { data, content } = parseMd(raw)
    let result
    if (typeof patch === "function") result = patch(data)
    else {
      if (patch.prefix !== undefined) {
        patch = { ...patch, prefix: String(patch.prefix).toUpperCase() }
        if (!PREFIX_RE.test(patch.prefix)) throw new Error("prefix must be letters and digits, starting with a letter (e.g. AB)")
      }
      for (const k of ["title", "waiting_on", "group"]) if (typeof patch[k] === "string") patch = { ...patch, [k]: oneLine(patch[k]) }
      Object.assign(data, patch)
    }
    await writeFileAtomic(file, matter.stringify(content, data))
    return result
  })
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
  await updateWorkstream(id, (data) => {
    data.status = to
    delete data.archived_from
    delete data.archived_at
  })
  return { to }
}

export async function deleteWorkstream(id) {
  const ws = await getWorkstream(id)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = path.join(TRASH_DIR, `${id}__${stamp}`)
  await fs.mkdir(dest, { recursive: true })
  // The entry's metadata lands before anything moves, so a delete interrupted at any later
  // step still leaves a trash entry that `ws trash restore` can bring back.
  await writeFileAtomic(path.join(dest, "TRASHED.json"), JSON.stringify({ id, title: ws.title, deleted_at: new Date().toISOString() }, null, 2))
  await fs.rename(ws.dir, path.join(dest, "ws"))
  dirty = true // the folder left the synced tree
  // Pending drafts and queued summaries go with it, so nothing resurfaces.
  const props = proposalsDir(id)
  if (await exists(props)) await fs.rename(props, path.join(dest, "proposals"))
  // Queued and failed summary jobs too (a running drain skips jobs whose workstream is gone).
  for (const [from, to] of [["queue", "queue"], [path.join("queue", "failed"), "queue-failed"]]) {
    const qdir = path.join(/* turbopackIgnore: true */ ROOT, from)
    let queued = []
    try { queued = (await fs.readdir(/* turbopackIgnore: true */ qdir)).filter((f) => f.endsWith(".json")) } catch {}
    for (const f of queued) {
      try {
        // Under the job's lock, the same one a running drain takes to update it.
        await withLock(path.join(/* turbopackIgnore: true */ qdir, f), async () => {
          const job = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ qdir, f), "utf-8"))
          if (job.ws === id) {
            await fs.mkdir(path.join(dest, to), { recursive: true })
            await fs.rename(path.join(/* turbopackIgnore: true */ qdir, f), path.join(dest, to, f))
          }
        })
      } catch {}
    }
  }
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

// Trash names come from the user; only exact names of existing trash entries are
// accepted, so "..", "." or a path can never point rm/rename outside .trash.
async function trashEntry(name) {
  const n = String(name ?? "")
  const names = (await listTrash()).map((t) => t.name)
  if (!n || n.includes("/") || n.includes("\\") || n === "." || n === ".." || !names.includes(n)) {
    throw new Error(`No trash entry "${n}" (see \`ws trash\`)`)
  }
  const full = path.join(TRASH_DIR, n)
  if (path.dirname(full) !== TRASH_DIR) throw new Error(`No trash entry "${n}"`)
  return full
}

// Move a file only if nothing is at the destination, checked atomically: a hard link fails
// rather than replace (exclusive copy where hard links aren't supported). Returns false
// when the destination already existed (the source is left for the caller to drop).
async function moveNoReplace(from, to) {
  try { await fs.link(from, to) } catch (e) {
    if (e.code === "EEXIST") return false
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(e.code)) throw e
    try { await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL) } catch (e2) {
      if (e2.code === "EEXIST") return false
      throw e2
    }
  }
  await fs.rm(from, { force: true })
  return true
}

// Every step can be repeated: if a restore is interrupted after the workstream folder moved,
// restoring the same entry again moves the drafts and queued jobs that were left behind.
export async function restoreWorkstream(name) {
  const src = await trashEntry(name)
  // The id is in TRASHED.json; the entry name (<id>__<time>) is the fallback for an entry
  // whose metadata is missing or damaged.
  let id = null
  try { id = JSON.parse(await fs.readFile(path.join(src, "TRASHED.json"), "utf-8")).id } catch {}
  if (!isId(id)) id = String(name).split("__")[0]
  if (!isId(id)) throw new Error(`Can't tell which workstream ${tildify(src)} holds`)
  const leftovers = []
  for (const part of ["proposals", "queue", "queue-failed"]) if (await exists(path.join(src, part))) leftovers.push(part)
  if (await exists(path.join(src, "ws"))) {
    if (await exists(wsDir(id))) throw new Error(`A workstream "${id}" already exists; rename or delete it first`)
    await fs.mkdir(path.dirname(wsDir(id)), { recursive: true })
    await fs.rename(path.join(src, "ws"), wsDir(id))
  } else if (!leftovers.length || !(await exists(wsDir(id)))) {
    throw new Error(`Nothing to restore at ${tildify(src)}`)
  }
  // Moved file by file, and never over an existing file: a draft or job already there (a
  // finished part of an earlier attempt, a job re-queued or a draft published since, which
  // is newer) is kept, even one that lands while this runs. Leftover lock folders are dropped.
  for (const [from, to] of [["proposals", proposalsDir(id)], ["queue", path.join(ROOT, "queue")], ["queue-failed", path.join(ROOT, "queue", "failed")]]) {
    if (!leftovers.includes(from)) continue
    await fs.mkdir(/* turbopackIgnore: true */ to, { recursive: true })
    for (const ent of await fs.readdir(path.join(src, from), { withFileTypes: true })) {
      if (!ent.isFile()) continue
      await moveNoReplace(path.join(src, from, ent.name), path.join(/* turbopackIgnore: true */ to, ent.name))
    }
  }
  await fs.rm(src, { recursive: true, force: true })
  dirty = true
  return { id }
}

export async function emptyTrash(name) {
  // Only an absent name means "everything"; "" or any other value must name one entry.
  const targets = name !== undefined && name !== null ? [await trashEntry(name)] : (await listTrash()).map((t) => path.join(TRASH_DIR, t.name))
  for (const t of targets) await fs.rm(t, { recursive: true, force: true })
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

// Lines ws writes itself in open.md and decisions.md. Anything else a person adds is kept:
// indented lines stay with the record above them, other text moves under "## Notes".
const MANAGED_LINE = /^(# (Open items|Decisions): .*|<!-- managed by ws.*-->|<!-- next: \d+ -->|_\(none\)_|## (Closed|Superseded|Notes)\s*)$/
const renderNotes = (notes = []) => (notes.length ? ["## Notes", "", ...notes, ""] : [])

// Prefixes are uppercase for new workstreams; lowercase is still read so older data survives.
const ITEM_RE = /^- \[( |x)\] ([A-Za-z][A-Za-z0-9]*-\d+) (.*)$/

export function parseOpen(text) {
  text = normalizeEol(text)
  const next = Number(text.match(/<!-- next: (\d+) -->/)?.[1] || 0)
  const items = []
  const unparsed = []
  const notes = []
  let cur = null
  for (const line of text.split("\n")) {
    const m = line.match(ITEM_RE)
    // Anything that looks like a checkbox record but doesn't parse exactly is reported,
    // so a hand edit (indent, "*", "[X]") is never dropped by the next write.
    // Any checkbox line that doesn't parse exactly (hand-added, indented, "*", "[X]") is
    // reported: ws re-renders this file, so the next write would drop it. Writes refuse;
    // reads still show everything that parsed.
    if (!m) {
      if (/^\s*[-*+]\s*\[[^\]]{0,3}\]/.test(line)) { unparsed.push(line); cur = null }
      else if (!line.trim() || MANAGED_LINE.test(line)) {} // blank lines don't end a record
      else if (cur && /^\s/.test(line)) cur.extra.push(line.trim())
      else { notes.push(line); cur = null }
      continue
    }
    // Markers are read from the end of the line only (closed last, then waiting), so the
    // same words inside the item text or the closing note can't be mistaken for them.
    let rest = m[3]
    let waiting = null
    let closed = null
    const c = m[1] === "x" && rest.match(/ \(closed ([^()]*)\)$/)
    if (c) { closed = c[1] || null; rest = rest.slice(0, -c[0].length) }
    const w = rest.match(/ @waiting:(\S*)$/)
    if (w) { waiting = w[1].replace(/_/g, " ") || null; rest = rest.slice(0, -w[0].length) }
    cur = { id: m[2], done: m[1] === "x", text: rest.trim(), waiting, closed, extra: [] }
    items.push(cur)
  }
  const maxN = Math.max(0, ...items.map((i) => Number(i.id.split("-").pop())))
  return { next: Math.max(next, maxN + 1), items, unparsed, notes }
}

function renderItem(i) {
  const text = oneLine(i.text)
  let s = `- [${i.done ? "x" : " "}] ${i.id} ${text}`
  // An empty marker keeps text that ends like a marker from being read as one.
  if (i.waiting) s += ` @waiting:${oneLine(i.waiting).replace(/ /g, "_")}`
  else if (/ ?@waiting:\S*$/.test(text) || (i.done && !i.closed && / \(closed [^)]*\)$/.test(text))) s += " @waiting:"
  if (i.closed) s += ` (closed ${String(i.closed).replace(/[()]/g, "")})`
  return [s, ...(i.extra || []).map((l) => `  ${l}`)].join("\n")
}

export function renderOpen({ next, items, notes }, title) {
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
    ...renderNotes(notes),
  ].join("\n")
}

export async function readOpen(id) {
  assertId(id)
  const file = path.join(wsDir(id), "open.md")
  const text = await readText(file)
  if (text === null) return { next: 1, items: [], unparsed: [], notes: [] }
  return parseOpen(text)
}

// Writes refuse a file with record lines they couldn't parse: rewriting would drop them.
// Reads still work (they show what parsed), so one bad line never hides a workstream.
function refuseUnparsed(file, state, what) {
  if (state.unparsed.length) throw new Error(`${tildify(file)} has ${what} lines ws can't read; fix them by hand:\n  ${state.unparsed.slice(0, 3).join("\n  ")}`)
}

async function writeOpen(id, state, title) {
  assertId(id)
  await writeFileAtomic(path.join(wsDir(id), "open.md"), renderOpen(state, title))
}

// A lock is a directory holding its owner's token. The owner refreshes it every few
// seconds, so a live owner is never treated as stale; only a lock untouched for 30s (its
// process died or froze) is taken over. Release removes the lock only if it is still ours.
const LOCK_STALE_MS = 30_000
// Removing a stale lock happens inside a second, short-lived "takeover" lock, and only after
// re-checking that the lock is still the same stale one. So two waiters can never both
// remove locks and both proceed (one could otherwise remove the other's fresh lock).
// A lock is also stale as soon as its owner process is gone (a hook killed by its
// timeout, a crash): waiting out 30s would outlast every hook's own timeout and drop the
// session. Only checked for owners on this host, since PIDs mean nothing elsewhere.
const HOST = os.hostname()
async function ownerGone(lock) {
  let owner
  try { owner = await fs.readFile(path.join(lock, "owner"), "utf-8") } catch { return false }
  const [host, pid] = owner.split(" ")[0].split("/")
  if (host !== HOST || !/^\d+$/.test(pid || "")) return false
  try { process.kill(Number(pid), 0); return false } catch (e) { return e.code === "ESRCH" }
}
const isStale = async (lock, st) => Date.now() - st.mtimeMs > LOCK_STALE_MS || (await ownerGone(lock))

async function removeIfStale(lock) {
  const gate = `${lock}.takeover`
  try { await fs.mkdir(gate) } catch (e) {
    if (e.code !== "EEXIST") throw e
    // A takeover that died midway leaves its gate behind; clear it once it's old.
    try { if (Date.now() - (await fs.stat(gate)).mtimeMs > LOCK_STALE_MS) await fs.rm(gate, { recursive: true, force: true }) } catch {}
    return
  }
  try {
    const st = await fs.stat(lock).catch(() => null)
    if (!st || !(await isStale(lock, st))) return
    // Its owner may have released it and someone else taken the path while we looked:
    // only remove the very directory (same inode, same owner token) that was judged stale.
    // A window of microseconds remains; closing it fully would need an OS-level lock.
    const owner = await fs.readFile(path.join(lock, "owner"), "utf-8").catch(() => null)
    const now = await fs.stat(lock).catch(() => null)
    const ownerNow = await fs.readFile(path.join(lock, "owner"), "utf-8").catch(() => null)
    if (now && now.ino === st.ino && now.mtimeMs === st.mtimeMs && owner === ownerNow) await fs.rm(lock, { recursive: true, force: true })
  } finally {
    await fs.rm(gate, { recursive: true, force: true })
  }
}

// A lock is a directory holding its owner's token. The owner refreshes it every few
// seconds, so a live owner is never treated as stale; only a lock untouched for 30s (its
// process died or was frozen that long) is taken over. Release removes it only if it is
// still ours.
export async function withLock(file, fn) {
  const lock = file + ".lock"
  const token = `${HOST}/${process.pid} ${Math.random().toString(36).slice(2)}`
  const start = Date.now()
  for (;;) {
    try { await fs.mkdir(lock); break } catch (e) {
      if (e.code !== "EEXIST") throw e
      await removeIfStale(lock).catch(() => {})
      if (Date.now() - start > 10_000) throw new Error(`Timed out waiting for lock ${tildify(lock)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try { await fs.writeFile(path.join(lock, "owner"), token) } catch (e) {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  const beat = setInterval(() => { const t = new Date(); fs.utimes(lock, t, t).catch(() => {}) }, 5_000)
  beat.unref?.()
  try { return await fn() } finally {
    clearInterval(beat)
    let mine = false
    try { mine = (await fs.readFile(path.join(lock, "owner"), "utf-8")) === token } catch {}
    if (mine) await fs.rm(lock, { recursive: true, force: true })
  }
}

async function mutateOpen(id, fn) {
  const ws = await getWorkstream(id)
  const result = await withLock(path.join(ws.dir, "open.md"), async () => {
    const state = await readOpen(id)
    refuseUnparsed(path.join(ws.dir, "open.md"), state, "item")
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
// The ":" after the id is part of the marker, so "a" never matches the block for "ab".
const mirrorStart = (id) => `<!-- ws:open ${id}:`
const MIRROR_END = "<!-- /ws:open -->"

export async function renderMirror(id) {
  const { items } = await readOpen(id)
  const open = items.filter((i) => !i.done)
  return [
    `${mirrorStart(id)} generated by ws. Change items with \`ws item\`, not here. -->`,
    `_Open items (ws, updated ${today()}):_`,
    "",
    // Escape comment openers so item text can't fake (or end) a ws block in the doc.
    ...(open.length ? open.map((i) => `- ${i.id} ${i.text}${i.waiting ? ` (waiting on ${i.waiting})` : ""}`.replace(/<!--/g, "&lt;!--")) : ["- (none)"]),
    MIRROR_END,
  ].join("\n")
}

export async function syncMirror(id, opts = {}) {
  const ws = await getWorkstream(id)
  if (!ws.data.mirror) return { action: "none" }
  const file = expand(ws.data.mirror)
  // Several workstreams can mirror into one doc: serialize writes to it.
  return withLock(file + ".ws", () => syncMirrorUnlocked(id, file, opts))
}

async function syncMirrorUnlocked(id, file, { force = false, init = false } = {}) {
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
  await writeFileAtomic(file, next)
  return { action: "written", file }
}

export function addItem(id, text, { waiting } = {}) {
  return mutateOpen(id, (state, ws) => {
    text = oneLine(text)
    if (!text) throw new Error("item text is empty")
    const item = { id: `${ws.prefix}-${state.next}`, done: false, text, waiting: waiting ? oneLine(waiting) : null, closed: null }
    state.next += 1
    state.items.push(item)
    return item
  })
}

// A request that conflicts with the current records (an item that's gone, already closed,
// or reworded since a draft quoted it; a decision with no text), as opposed to ws failing
// (a file it can't parse, a lock timeout, a full disk). Code that replays a draft tells
// the two apart by this flag, never by the message, which can quote user text.
export function conflict(msg) {
  const e = new Error(msg)
  e.conflict = true
  return e
}

export async function closeItem(id, itemId, opts = {}) {
  return (await closeItems(id, [itemId], opts))[0]
}

// All or nothing: every ID is checked before any is closed, in one write, so a bad ID in
// a list never leaves the others half-closed behind an error.
// `expect` maps an ID to the item text the caller saw (a model draft quotes it): an item
// reworded since then is left open, since the evidence was about the old wording.
export function closeItems(id, itemIds, { session, note, expect = {} } = {}) {
  return mutateOpen(id, (state) => {
    const items = [], problems = []
    const expected = new Map(Object.entries(expect || {}).map(([k, v]) => [k.toUpperCase(), v]))
    for (const itemId of itemIds) {
      const item = state.items.find((i) => i.id.toUpperCase() === String(itemId).toUpperCase())
      const was = expected.get(String(itemId).toUpperCase())
      if (!item) problems.push(`${itemId} not found in ${id}`)
      else if (item.done) problems.push(`${itemId} is already closed`)
      else if (typeof was === "string" && oneLine(was) !== oneLine(item.text)) problems.push(`${item.id} was reworded since the draft (now "${item.text}"), so it was left open`)
      else if (!items.includes(item)) items.push(item)
    }
    if (problems.length) throw conflict(problems.join("; ") + (itemIds.length > 1 ? " (nothing was closed)" : ""))
    // Keep open.md readable: the full evidence lives in the session log, not in this line.
    const n = note && oneLine(note).replace(/[()]/g, "")
    const closed = [today(), session && oneLine(session).slice(0, 8), n && (n.length > 160 ? n.slice(0, 159) + "…" : n)].filter(Boolean).join(", ")
    for (const item of items) { item.done = true; item.closed = closed }
    return items
  })
}

export function editItem(id, itemId, { text, waiting }) {
  return mutateOpen(id, (state) => {
    const item = state.items.find((i) => i.id.toUpperCase() === itemId.toUpperCase())
    if (!item) throw new Error(`${itemId} not found in ${id}`)
    if (text && oneLine(text)) item.text = oneLine(text)
    if (waiting !== undefined) item.waiting = waiting ? oneLine(waiting) : null
    return item
  })
}

// ------------------------------------------------------------------ decisions
// decisions.md: settled choices with why and what was rejected, so sessions don't
// reopen them. Superseded, never edited in place; IDs are <PREFIX>-D<n>.
//   - [active] AB-D1 Brand blue is #1A4FD6 everywhere (2026-11-17)
//     why: the guide palette is the source of truth
//     rejected: #2B5FE0 (only in old logo exports)
//     evidence: "…"
//   - [superseded by AB-D3] AB-D2 …

const DEC_RE = /^- \[(active|superseded(?: by ([A-Za-z][A-Za-z0-9]*-D\d+))?)\] ([A-Za-z][A-Za-z0-9]*-D\d+) (.*?)(?: \((\d{4}-\d{2}-\d{2})\))?$/
const DEC_FIELDS = ["why", "rejected", "evidence", "session"]

export function parseDecisions(text) {
  text = normalizeEol(text)
  const next = Number(text.match(/<!-- next: (\d+) -->/)?.[1] || 0)
  const decisions = []
  const unparsed = []
  const notes = []
  let cur = null
  for (const line of text.split("\n")) {
    const m = line.match(DEC_RE)
    if (!m && /^\s*[-*+]\s*\[\s*(active|superseded)/i.test(line)) { unparsed.push(line); cur = null; continue }
    if (m) {
      cur = { id: m[3], text: m[4].trim(), date: m[5] || null, active: m[1] === "active", superseded_by: m[2] || null, extra: [] }
      decisions.push(cur)
      continue
    }
    const f = line.match(/^\s+([a-z_]+):\s?(.*)$/)
    if (cur && f && DEC_FIELDS.includes(f[1])) cur[f[1]] = f[2].trim()
    else if (cur && /^\s+\S/.test(line)) cur.extra.push(line.trim()) // other fields (owner: …) and continuation lines
    else if (!line.trim() || MANAGED_LINE.test(line)) {} // blank lines don't end a record: fields after one still belong to it
    else { notes.push(line); cur = null }
  }
  const maxN = Math.max(0, ...decisions.map((d) => Number(d.id.split("-D").pop())))
  return { next: Math.max(next, maxN + 1), decisions, unparsed, notes }
}

export function renderDecisions({ next, decisions, notes }, title) {
  const one = (d) => [
    `- [${d.active ? "active" : `superseded${d.superseded_by ? ` by ${d.superseded_by}` : ""}`}] ${d.id} ${oneLine(d.text)}${d.date ? ` (${d.date})` : ""}`,
    ...DEC_FIELDS.filter((k) => d[k]).map((k) => `  ${k}: ${oneLine(d[k])}`),
    ...(d.extra || []).map((l) => `  ${l}`),
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
    ...renderNotes(notes),
  ].join("\n")
}

export async function readDecisions(id) {
  assertId(id)
  const file = path.join(wsDir(id), "decisions.md")
  const text = await readText(file)
  if (text === null) return { next: 1, decisions: [], unparsed: [], notes: [] }
  return parseDecisions(text)
}

export async function decide(id, text, { why, rejected, evidence, session, supersedes } = {}) {
  const ws = await getWorkstream(id)
  const file = path.join(ws.dir, "decisions.md")
  const result = await withLock(file, async () => {
    const state = await readDecisions(id)
    refuseUnparsed(file, state, "decision")
    let old = null
    if (supersedes) {
      old = state.decisions.find((d) => d.id.toUpperCase() === String(supersedes).toUpperCase())
      if (!old) throw conflict(`${supersedes} not found in ${id}`)
      if (!old.active) throw conflict(`${supersedes} is already superseded`)
    }
    const opt = (v) => (v ? oneLine(v) || undefined : undefined)
    const d = { id: `${ws.prefix}-D${state.next}`, text: oneLine(text), date: today(), active: true, superseded_by: null,
      why: opt(why), rejected: opt(Array.isArray(rejected) ? rejected.join("; ") : rejected), evidence: opt(evidence), session: opt(session) }
    if (!d.text) throw conflict("decision text is empty")
    state.next += 1
    state.decisions.push(d)
    if (old) { old.active = false; old.superseded_by = d.id }
    await writeFileAtomic(file, renderDecisions(state, ws.title))
    return { decision: d, superseded: old?.id || null }
  })
  return result
}

// ----------------------------------------------------------------------- logs
// One file per session. A log is filled in place when its session is adopted, resumed
// or summarized; other sessions never touch it.

export async function listLogs(id) {
  assertId(id)
  const dir = path.join(wsDir(id), "log")
  let files = []
  try { files = await fs.readdir(dir) } catch { return [] }
  const logs = []
  for (const f of files.filter((f) => f.endsWith(".md")).sort()) {
    const file = path.join(dir, f)
    const { data, content } = parseMd(normalizeEol(await fs.readFile(file, "utf-8")))
    const { mtimeMs } = await fs.stat(file)
    logs.push({ file, ...data, summary: content.trim(), mtimeMs })
  }
  return logs.sort((a, b) => String(a.ended || "").localeCompare(String(b.ended || "")) || a.mtimeMs - b.mtimeMs)
}

export async function appendLog(id, entry) {
  const ws = await getWorkstream(id)
  const now = new Date()
  // Manual notes are named by time; with several machines sharing the data, the machine name
  // keeps two notes written in the same second on different machines from sharing a file.
  const tag = entry.session ? sessionTag(entry.session)
    : "manual-" + now.toISOString().slice(11, 19).replace(/:/g, "") + (LOCAL.enabled ? `-${LOCAL.machine.toLowerCase()}` : "")
  const dir = path.join(ws.dir, "log")
  await fs.mkdir(dir, { recursive: true })
  const { summary = "", ...meta } = entry
  const data = { ended: now.toISOString(), source: "manual", ...meta }
  if (LOCAL.enabled && !data.host) data.host = LOCAL.machine // which machine, once several share the data
  for (const k of Object.keys(data)) if (data[k] === undefined || data[k] === null) delete data[k]
  const text = matter.stringify(`\n${summary.trim()}\n`, data)
  // Two notes in the same second share a name; the loser of the exclusive create takes
  // the next free suffix instead of failing.
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${today()}_${tag}${n > 1 ? `-${n}` : ""}.md`)
    if (await exists(file)) continue
    try { await createFileAtomic(file, text); return file } catch (e) {
      if (e.code !== "EEXIST" || n > 1000) throw e
    }
  }
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
