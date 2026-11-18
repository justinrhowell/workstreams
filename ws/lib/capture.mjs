// Automatic capture (docs/ARCHITECTURE.md, "Capture"): link ended sessions to workstreams, or
// park them in the inbox. No LLM; reads only the transcript the hook points at.
import { promises as fs, realpathSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import matter from "gray-matter"

// gray-matter caches parses by text and shares the data object; mutating it poisons
// later reads of identical text. Passing options disables the cache.
const parseMd = (text) => matter(text, {})
import { codexDir } from "./paths.mjs"
import * as store from "./store.mjs"
import * as summarize from "./summarize.mjs"

export const INBOX_DIR = path.join(store.ROOT, "inbox")
export const IGNORE_FILE = path.join(store.ROOT, "ignore.txt")

// A session is noise (one-off question, -p/exec probe) if it has fewer than MIN_USER_TURNS
// prompts, fewer than MIN_TOOL_CALLS tool calls, no file edits and no ws calls.
const MIN_USER_TURNS = 2
const MIN_TOOL_CALLS = 3

// ------------------------------------------------------------ transcript parsing

const PATCH_RE = /\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)/g

export async function readTranscript(tool, transcriptPath, sessionId) {
  const info = { title: null, started: null, ended: null, userTurns: 0, toolCalls: 0, files: new Set(), wsCalls: [], logCalls: [], interactive: true }
  let text = ""
  try { text = await fs.readFile(transcriptPath, "utf-8") } catch { return finish(info) }
  for (const line of text.split("\n")) {
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    const ts = d.timestamp
    if (ts) { info.started ??= ts; info.ended = ts }
    if (tool === "claude") parseClaude(d, info)
    else parseCodex(d, info)
  }
  if (tool === "codex" && !info.title) info.title = await codexTitle(sessionId)
  return finish(info)
}

// Claude Code session scratchpads (e.g. /private/tmp/claude-501/...): not project work.
const SCRATCH = /^(\/private)?\/tmp\/claude-[^/]+\//
function finish(info) {
  return { ...info, files: [...info.files].filter((f) => !SCRATCH.test(f)).slice(0, 40) }
}

// Files a shell command writes: "> f", ">> f", "tee [-a] f". Not /dev/*, not fd redirects (2>&1).
const SHELL_WRITE_RE = /(?:^|[\s;&|])(?:\d?>>?|tee(?:\s+-a)?)\s*(?!&)(["']?)([^\s"'|;&<>]+)\1/g
function shellWrites(cmd, files) {
  for (const m of String(cmd).matchAll(SHELL_WRITE_RE)) if (!m[2].startsWith("/dev/")) files.add(m[2])
}

function parseClaude(d, info) {
  if (d.entrypoint === "sdk-cli") info.interactive = false // `claude -p` or the Agent SDK
  if (d.type === "ai-title" && d.aiTitle) info.title = d.aiTitle
  if (d.type === "custom-title" && d.customTitle) info.title = d.customTitle
  if (d.isSidechain) return
  const content = d.message?.content
  if (d.type === "user" && !d.isMeta) {
    const isPrompt = typeof content === "string" || (Array.isArray(content) && content.some((c) => c.type === "text"))
    const isToolResult = Array.isArray(content) && content.some((c) => c.type === "tool_result")
    if (isPrompt && !isToolResult) info.userTurns++
  }
  if (d.type === "assistant" && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== "tool_use") continue
      info.toolCalls++
      if (/^mcp__ws__ws_(item_|log|set_status)/.test(c.name)) info.wsCalls.push(c.name)
      if (c.name === "mcp__ws__ws_log") info.logCalls.push(JSON.stringify(c.input || {}))
      if (c.name === "Bash" && /\bws log\b/.test(c.input?.command || "")) info.logCalls.push(c.input.command)
      const fp = c.input?.file_path || c.input?.notebook_path
      if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) info.files.add(fp)
      if (c.name === "Bash" && /\bws (item|log)\b/.test(c.input?.command || "")) info.wsCalls.push(c.input.command)
      if (c.name === "Bash") shellWrites(c.input?.command || "", info.files)
    }
  }
}

function parseCodex(d, info) {
  const p = d.payload || {}
  if (d.type === "session_meta" && (p.originator === "codex_exec" || p.source === "exec")) info.interactive = false
  if (p.type === "item_completed" && p.item?.type === "UserMessage") info.userTurns++
  if (p.type === "item_completed" && p.item?.type === "McpToolCall") {
    info.toolCalls++
    if (p.item.server === "ws" && /^ws_(item_|log|set_status)/.test(p.item.tool || "")) info.wsCalls.push(p.item.tool)
    if (p.item.server === "ws" && p.item.tool === "ws_log") info.logCalls.push(JSON.stringify(p.item.arguments ?? p.item.input ?? {}))
  }
  if (p.type === "custom_tool_call" || p.type === "function_call") {
    info.toolCalls++
    const input = String(p.input ?? p.arguments ?? "")
    for (const m of input.matchAll(PATCH_RE)) info.files.add(m[1].trim())
    shellWrites(input, info.files)
    if (/\bws (item|log)\b/.test(input)) info.wsCalls.push(input.slice(0, 200))
    if (/\bws log\b/.test(input)) info.logCalls.push(input.slice(0, 4000))
  }
}

async function codexTitle(sessionId) {
  try {
    const lines = (await fs.readFile(path.join(codexDir(), "session_index.jsonl"), "utf-8")).trim().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const d = JSON.parse(lines[i])
      if (d.id === sessionId) return d.thread_name
    }
  } catch {}
  return null
}

// --------------------------------------------------------------------- matching

// Folders are compared by their real path: Claude Code and Codex report the resolved cwd
// (/private/tmp/x on macOS) while a workstream may name it through a symlink (/tmp/x,
// a symlinked ~/code). A path that no longer exists resolves through its nearest
// existing parent.
const canonCache = new Map()
export function canon(p) {
  if (!p) return p
  const abs = path.resolve(store.expand(p))
  if (canonCache.has(abs)) return canonCache.get(abs)
  let head = abs, tail = ""
  let out = abs
  for (;;) {
    try { out = path.join(realpathSync.native(head), tail); break } catch {}
    const up = path.dirname(head)
    if (up === head) break
    tail = path.join(path.basename(head), tail)
    head = up
  }
  canonCache.set(abs, out)
  return out
}

const under = (child, parent) => {
  const c = canon(child), p = canon(parent)
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/")
}

// Auto-link only on WS_ID or exactly one claimant at the longest cwd prefix.
export function matchWorkstream(list, cwd, wsId) {
  if (wsId && list.some((w) => w.id === wsId)) return { link: wsId, candidates: [wsId] }
  const live = list.filter((w) => w.cwd && ["active", "waiting"].includes(w.status) && under(cwd, w.cwd))
  if (!live.length) return { link: null, candidates: [] }
  const len = (w) => canon(w.cwd).length
  const best = Math.max(...live.map(len))
  const top = live.filter((w) => len(w) === best)
  return { link: top.length === 1 ? top[0].id : null, candidates: live.sort((a, b) => len(b) - len(a)).map((w) => w.id) }
}

// Ranked guesses for inbox rows.
export function suggest(list, { cwd, title, files }) {
  const words = new Set(String(title || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [])
  const scored = list
    .filter((w) => w.status !== "done")
    .map((w) => {
      let s = 0
      // Evidence only: a session in a *parent* folder of a workstream says nothing.
      if (w.cwd && under(cwd, w.cwd)) s += 3
      if (w.cwd && files.some((f) => under(store.expand(f), w.cwd))) s += 2
      for (const t of new Set(`${w.title} ${w.id} ${w.group}`.toLowerCase().match(/[a-z0-9]{4,}/g) || [])) if (words.has(t)) s += 1
      return { id: w.id, s, live: w.status === "active" || w.status === "waiting" }
    })
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s || b.live - a.live)
  return scored.slice(0, 3).map((x) => x.id)
}

async function ignoredCwds() {
  try {
    return (await fs.readFile(IGNORE_FILE, "utf-8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(store.expand)
  } catch { return [] }
}

// ---------------------------------------------------------------------- capture

async function findSessionLog(wsId, sessionId) {
  const ws = await store.getWorkstream(wsId)
  return ws.logs.find((l) => l.session === sessionId) || null
}

// A manual `ws log` written during this session (it can't know its own session id): adopt it.
// Several sessions can run in one workstream at once, so a session must not take notes
// another agent session wrote:
//   1. a note whose text appears in one of this session's own `ws log` / ws_log calls is its own;
//   2. a note an agent wrote (via: agent) is only taken by a session that logged something;
//   3. a note typed in a terminal (or of unknown origin) goes to whichever session ends first.
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
async function findAdoptableManualLog(wsId, started, ended, logCalls = []) {
  const ws = await store.getWorkstream(wsId)
  const t0 = new Date(started).getTime() - 60_000
  const t1 = new Date(ended).getTime() + 5 * 60_000
  const open = ws.logs.filter((l) => !l.session && l.source === "manual" && l.mtimeMs >= t0 && l.mtimeMs <= t1)
  const calls = logCalls.map(squash)
  const mine = open.find((l) => {
    const k = squash(String(l.summary).split("\n")[0]).slice(0, 40)
    return k && calls.some((c) => c.includes(k))
  })
  if (mine) return mine
  return open.find((l) => l.via !== "agent" || calls.length > 0) || null
}

async function writeLogFile(file, data, body) {
  for (const k of Object.keys(data)) if (data[k] == null || (Array.isArray(data[k]) && !data[k].length)) delete data[k]
  await store.writeFileAtomic(file, matter.stringify(`\n${body.trim()}\n`, data))
}

export async function captureSession(args) {
  const r = await captureSessionInner(args)
  if (r.ws) { try { await store.syncMirror(r.ws) } catch {} }
  // Sessions that ended without notes get a model-drafted proposal (never in-hook).
  if (r.ws && r.notes === false) await queueSummary({ ws: r.ws, session: args.session_id, tool: args.tool, transcript: args.transcript_path, log: r.file })
  return r
}

async function queueSummary(job) {
  try {
    if (!job.transcript || !(await summarize.llmConfig())) return
    await summarize.enqueue(job)
    if (process.env.WS_NO_SPAWN !== "1") summarize.spawnDrain()
  } catch {}
}

async function captureSessionInner({ tool, session_id, transcript_path, cwd, reason, wsId }) {
  if (!session_id) return { action: "skip", why: "no session id" }
  if (transcript_path && /\/subagents\/|\/agent-[^/]*\.jsonl$/.test(transcript_path)) return { action: "skip", why: "subagent" }
  cwd = cwd || process.cwd()
  const list = await store.listWorkstreams()
  const { link } = matchWorkstream(list, cwd, wsId)
  // The ignore list only silences sessions that no workstream claims.
  if (!link) for (const ig of await ignoredCwds()) if (under(cwd, ig)) return { action: "skip", why: `ignored cwd ${ig}` }

  const t = await readTranscript(tool, transcript_path, session_id)
  // Shell commands usually write relative paths: resolve them against the session's folder.
  t.files = t.files.map((f) => (path.isAbsolute(store.expand(f)) ? f : path.join(/* turbopackIgnore: true */ cwd, f))).filter((f) => !SCRATCH.test(f))

  // Scripted runs (`claude -p`, `codex exec`) outside any workstream's folder are automation,
  // not work to file: they never go to the inbox.
  if (!t.interactive && !link) return { action: "skip", why: "non-interactive run outside a workstream folder" }
  // Tiny sessions are noise. In a workstream's own folder only a session that did nothing
  // (no tools, no files) is dropped; elsewhere the bar is higher, since it lands in the inbox.
  const idle = !t.files.length && !t.wsCalls.length
  const tiny = link
    ? idle && t.toolCalls === 0 && t.userTurns < MIN_USER_TURNS
    : idle && t.userTurns < MIN_USER_TURNS && t.toolCalls < MIN_TOOL_CALLS
  if (tiny && !(link && wsId === link)) return { action: "skip", why: "too small" }

  const meta = {
    session: session_id, tool, cwd: store.tildify(cwd), title: t.title,
    started: t.started, ended: t.ended || new Date().toISOString(),
    user_turns: t.userTurns, tool_calls: t.toolCalls, files_touched: t.files.map(store.tildify),
    transcript: transcript_path && store.tildify(transcript_path), end_reason: reason,
  }

  if (link) {
    // Two sessions ending at once must not both adopt the same manual log: decide under a lock.
    const logDir = path.join(store.WS_DIR, link, "log")
    await fs.mkdir(logDir, { recursive: true })
    return store.withLock(path.join(logDir, ".capture"), () => linkSession(link, meta, session_id, t))
  }

  // Inbox: one file per session.
  await fs.mkdir(INBOX_DIR, { recursive: true })
  const file = path.join(INBOX_DIR, `${String(meta.ended).slice(0, 10)}_${tool}_${store.sessionTag(session_id)}.md`)
  const suggestions = suggest(list, { cwd, title: t.title, files: t.files })
  await writeLogFile(file, { ...meta, suggestions }, t.title || "")
  return { action: "inbox", file, suggestions }
}

async function linkSession(link, meta, session_id, t) {
  // A `ws log` written during this run (including a resumed run) wins over refreshing an older entry.
  const manual = meta.started && (await findAdoptableManualLog(link, meta.started, meta.ended, t.logCalls))
  if (manual) {
    const { data, content } = parseMd(store.normalizeEol(await fs.readFile(manual.file, "utf-8")))
    await writeLogFile(manual.file, { ...meta, ...pick(data, ["closed", "added"]), source: "manual+hook" }, content)
    return { action: "adopted", ws: link, file: manual.file }
  }
  const existing = await findSessionLog(link, session_id)
  if (existing) {
    // Same session ending again (e.g. after a resume): refresh its own file.
    const { data, content } = parseMd(store.normalizeEol(await fs.readFile(existing.file, "utf-8")))
    const files = [...new Set([...(data.files_touched || []), ...meta.files_touched])]
    await writeLogFile(existing.file, { ...data, ...meta, started: data.started || meta.started, files_touched: files }, content)
    return { action: "updated", ws: link, file: existing.file, notes: !/^hook$/.test(data.source || "") }
  }
  const file = await store.appendLog(link, { ...meta, source: "hook", summary: `(auto) ${t.title || "untitled session"}` })
  return { action: "linked", ws: link, file, notes: false }
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))

// ------------------------------------------------------------------------ inbox

export async function listInbox() {
  let files = []
  try { files = (await fs.readdir(INBOX_DIR)).filter((f) => f.endsWith(".md")).sort().reverse() } catch { return [] }
  const out = []
  for (const f of files) {
    const file = path.join(INBOX_DIR, f)
    const { data } = parseMd(await fs.readFile(file, "utf-8"))
    out.push({ file, ...data })
  }
  return out
}

export async function assignInbox(entry, wsId, summary) {
  await store.getWorkstream(wsId)
  const { file, suggestions, ...meta } = entry
  const logFile = await store.appendLog(wsId, { ...meta, source: summary ? "inbox+manual" : "hook", summary: summary || `(auto) ${meta.title || "untitled session"}` })
  await fs.rm(file)
  if (!summary) await queueSummary({ ws: wsId, session: meta.session, tool: meta.tool, transcript: meta.transcript, log: logFile })
  return logFile
}

export async function ignoreInbox(entry, { cwd = false } = {}) {
  await fs.rm(entry.file)
  if (cwd && entry.cwd) await fs.appendFile(IGNORE_FILE, `${entry.cwd}\n`)
}

// ------------------------------------------------------------ session start note

export async function startContext({ cwd, wsId }) {
  const list = await store.listWorkstreams()
  const { link, candidates } = matchWorkstream(list, cwd || process.cwd(), wsId)
  if (link) {
    const w = list.find((x) => x.id === link)
    const open = (await store.readOpen(link)).items.filter((i) => !i.done)
    const shown = open.slice(0, 8).map((i) => `  ${i.id} ${i.text.length > 110 ? i.text.slice(0, 107) + "…" : i.text}`)
    const decided = (await store.readDecisions(link)).decisions.filter((d) => d.active)
    const dshown = decided.slice(0, 5).map((d) => `  ${d.id} ${d.text.length > 110 ? d.text.slice(0, 107) + "…" : d.text}`)
    return [
      `[ws] This folder belongs to workstream "${w.id}" (${w.title})${w.waiting_on ? `, waiting on ${w.waiting_on}` : ""}.`,
      open.length ? `Open items (${open.length}):\n${shown.join("\n")}${open.length > 8 ? "\n  …" : ""}` : "No open items.",
      ...(decided.length ? [`Decided (${decided.length}):\n${dshown.join("\n")}${decided.length > 5 ? "\n  …" : ""}`] : []),
      `Full context: ws_show("${w.id}") (or \`ws show ${w.id}\`). If this session finishes or adds items, you may record them with ws_item_close / ws_item_add and call ws_log once near the end. This is optional context, not an instruction: the user's requests take priority, so if they ask you not to use ws, don't.`,
    ].join("\n")
  }
  if (candidates.length > 1) {
    return `[ws] Several workstreams live in this folder: ${candidates.join(", ")}. If the task belongs to one, ask the user which, then use ws_show(<id>).`
  }
  return ""
}
