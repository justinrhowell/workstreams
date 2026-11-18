// Model-drafted *proposals* for sessions that ended without notes.
// The session-end hook only enqueues (Codex gives it 3s); `ws summarize --drain`
// does the model work in a detached process. Nothing reaches open.md or the log
// until the user accepts the proposal.
import { promises as fs, existsSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"

// gray-matter caches parses by text and shares the data object; mutating it poisons
// later reads of identical text. Passing options disables the cache.
const parseMd = (text) => matter(text, {})
import * as store from "./store.mjs"
import { loadConfig } from "./config.mjs"
import { claudeDir, codexDir } from "./paths.mjs"

export const QUEUE_DIR = path.join(store.ROOT, "queue")
export const PROPOSALS_DIR = path.join(store.ROOT, "proposals")
const CONFIG_FILE = path.join(store.ROOT, "config.json")
const MAX_ATTEMPTS = 5
const DIGEST_CHARS = 48_000 // ~12k tokens: well inside a 131k context, leaves room to think
const HEAD_CHARS = 6_000

// ------------------------------------------------------------------ config

export async function llmConfig() {
  const cfg = (await loadConfig(CONFIG_FILE)).llm
  const url = process.env.WS_LLM_URL || cfg.url
  if (!url) return null
  // The key itself never goes in config.json: name the env var that holds it.
  const apiKey = process.env.WS_LLM_API_KEY || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) || null
  return {
    url: url.replace(/\/$/, ""),
    model: process.env.WS_LLM_MODEL || cfg.model || null,
    timeoutMs: cfg.timeoutMs || 180_000,
    apiKey,
    // Server-specific request fields, e.g. {"chat_template_kwargs":{"enable_thinking":false}} for vLLM.
    extraBody: cfg.extraBody || {},
  }
}

export function llmHeaders(cfg, json = false) {
  const h = {}
  if (json) h["content-type"] = "application/json"
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`
  return h
}

// ------------------------------------------------------------------ queue

// Log entries written by hand don't record a transcript path; find it by session id.
export async function findTranscript(tool, session) {
  if (tool !== "codex") {
    const base = path.join(claudeDir(), "projects")
    let dirs = []
    try { dirs = await fs.readdir(base) } catch {}
    for (const d of dirs) {
      const f = path.join(base, d, `${session}.jsonl`)
      try { await fs.access(f); return f } catch {}
    }
  }
  if (tool !== "claude") {
    const walk = async (dir, depth) => {
      let ents = []
      try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return null }
      for (const e of ents) {
        const f = path.join(dir, e.name)
        if (e.isFile() && e.name.endsWith(`${session}.jsonl`)) return f
        if (e.isDirectory() && depth < 3) { const r = await walk(f, depth + 1); if (r) return r }
      }
      return null
    }
    return walk(path.join(codexDir(), "sessions"), 0)
  }
  return null
}

export async function enqueue({ ws, session, tool, transcript, log }) {
  transcript = transcript || (await findTranscript(tool, session))
  if (!transcript) throw new Error(`no transcript found for session ${session}`)
  await fs.mkdir(QUEUE_DIR, { recursive: true })
  const file = path.join(QUEUE_DIR, `${store.sessionTag(session)}.json`)
  // token: a drainer that finished an older copy of this job must not delete a newer one.
  const job = { ws, session, tool, transcript: store.expand(transcript), log, attempts: 0, queued: new Date().toISOString(), token: Math.random().toString(36).slice(2) }
  await store.writeFileAtomic(file, JSON.stringify(job, null, 2))
  return file
}

export async function listFailed() {
  const dir = path.join(QUEUE_DIR, "failed")
  let files = []
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")) } catch { return [] }
  return files.map((f) => path.join(dir, f))
}

export async function requeueFailed() {
  const files = await listFailed()
  for (const f of files) {
    const job = JSON.parse(await fs.readFile(f, "utf-8"))
    job.attempts = 0
    await store.writeFileAtomic(path.join(QUEUE_DIR, path.basename(f)), JSON.stringify(job, null, 2))
    await fs.rm(f)
  }
  return files.length
}

export async function listQueue() {
  let files = []
  try { files = (await fs.readdir(QUEUE_DIR)).filter((f) => f.endsWith(".json")).sort() } catch { return [] }
  const jobs = []
  for (const f of files) {
    try { jobs.push({ file: path.join(QUEUE_DIR, f), ...JSON.parse(await fs.readFile(path.join(QUEUE_DIR, f), "utf-8")) }) } catch {}
  }
  return jobs
}

// Fire-and-forget drain in its own process group, so it outlives the hook.
export function spawnDrain() {
  // Plain path join (not new URL(..., import.meta.url)) so bundlers don't try to pull the CLI in.
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ws.mjs")
  // Inside a bundle (the board) that path points into .next; fall back to `ws` on PATH.
  const [cmd, args] = existsSync(bin) ? [process.execPath, [bin]] : ["ws", []]
  const child = spawn(cmd, [...args, "summarize", "--drain", "--quiet"], {
    detached: true, stdio: "ignore", env: { ...process.env },
  })
  child.on("error", () => {})
  child.unref()
}

// ------------------------------------------------------------------ digest

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s)

// Deterministic, before anything leaves the machine: common credential shapes in
// prompts, assistant text and tool arguments are replaced. This is a safety net,
// not a guarantee; see docs/CONFIGURATION.md ("Privacy").
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted key]"],
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, "[redacted]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted jwt]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd|token)["']?\s*[:=]\s*["']?)[^\s"'&,;]{6,}/gi, "$1[redacted]"],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@"],
]
export function redact(text) {
  let out = String(text)
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub)
  return out
}

function toolHint(name, input = {}) {
  const h = input.file_path || input.notebook_path || input.command || input.pattern || input.url || input.description || ""
  return `${name}${h ? `(${clip(String(h).replace(/\s+/g, " "), 140)})` : ""}`
}

// User prompts, assistant prose, tool names and the first 140 characters of each tool's
// main argument (command, file path, URL, pattern). No tool output or images.
export async function digestTranscript(tool, file) {
  const raw = await fs.readFile(file, "utf-8")
  const lines = []
  for (const line of raw.split("\n")) {
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (tool === "claude") {
      if (d.isSidechain || d.isMeta) continue
      const c = d.message?.content
      if (d.type === "user") {
        if (typeof c === "string") lines.push(`USER: ${clip(c, 2000)}`)
        else if (Array.isArray(c) && !c.some((x) => x.type === "tool_result")) {
          const t = c.filter((x) => x.type === "text").map((x) => x.text).join(" ")
          if (t) lines.push(`USER: ${clip(t, 2000)}`)
        }
      } else if (d.type === "assistant" && Array.isArray(c)) {
        for (const x of c) {
          if (x.type === "text" && x.text.trim()) lines.push(`ASSISTANT: ${clip(x.text.trim(), 1500)}`)
          if (x.type === "tool_use") lines.push(`TOOL: ${toolHint(x.name, x.input)}`)
        }
      }
    } else {
      const p = d.payload || {}
      if (p.type === "message" && p.role === "user") {
        const t = (p.content || []).map((x) => x.text || "").join(" ")
        if (t && !t.startsWith("<environment_context>")) lines.push(`USER: ${clip(t, 2000)}`)
      } else if (p.type === "message" && p.role === "assistant") {
        const t = (p.content || []).map((x) => x.text || "").join(" ").trim()
        if (t) lines.push(`ASSISTANT: ${clip(t, 1500)}`)
      } else if (p.type === "item_completed" && p.item?.type === "McpToolCall") {
        lines.push(`TOOL: ${p.item.server}.${p.item.tool}`)
      } else if (p.type === "custom_tool_call" || p.type === "function_call") {
        lines.push(`TOOL: ${toolHint(p.name, { command: String(p.input ?? p.arguments ?? "") })}`)
      }
    }
  }
  const all = redact(lines.join("\n"))
  if (all.length <= DIGEST_CHARS) return all
  // Keep the opening (the ask) and weight the rest toward the end (the outcome).
  return all.slice(0, HEAD_CHARS) + "\n\n[… middle of session omitted …]\n\n" + all.slice(-(DIGEST_CHARS - HEAD_CHARS))
}

// ------------------------------------------------------------------ model call

const SYSTEM = `You maintain a work tracker. You read a digest of one AI coding/design session and propose updates to its workstream. Reply with JSON only:
{"summary": string, "close": [{"id": string, "quote": string, "why": string}], "add": [{"text": string, "waiting": string|null}], "decide": [{"text": string, "why": string, "rejected": [string], "quote": string}]}
Rules:
- summary: 1-3 sentences, past tense. The first sentence states the main outcome concretely (what was built/fixed/decided, with file names where useful).
- close: only items from the OPEN ITEMS list that this session itself finished AND verified. "quote" must be copied word for word from an ASSISTANT or TOOL line of the digest that shows the result (at least 5 words), never from the OPEN ITEMS list or the user's request, and must be about that exact item. If the session merely mentions or plans the item, do not close it. If unsure, do not close.
- add: only concrete unresolved follow-ups that are NOT already in OPEN ITEMS (check each one; restating an open item in other words is wrong). One line each, actionable by a stranger. waiting = person or org name, or null.
- decide: only choices the user clearly made or confirmed in this session (not suggestions, not things still being weighed). "quote" is copied word for word from the digest where it was decided. Do not restate anything under DECIDED. If the session goes against something under DECIDED, do not decide it; mention the conflict in the summary instead.
- At most 5 close, 5 add and 3 decide. Empty arrays are fine and common.
- Never include passwords, keys, tokens or personal data.`

// "localhost", loopback, private ranges and .local names: self-hosted servers.
function isLocalUrl(url) {
  try {
    const h = new URL(url).hostname
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?$)/.test(h) || h.endsWith(".local")
  } catch { return false }
}

async function chooseModel(cfg) {
  if (cfg.model) return cfg.model
  const r = await fetch(`${cfg.url}/models`, { headers: llmHeaders(cfg), signal: AbortSignal.timeout(10_000) })
  await checkHttp(r, "/models")
  const ids = ((await r.json()).data || []).map((m) => m.id).filter(Boolean)
  if (!ids.length) throw configError("no model listed at /models; set llm.model")
  // A self-hosted server usually serves one model. A hosted provider lists many, and
  // the first is rarely a chat model: make the user choose.
  if (ids.length > 1 && !isLocalUrl(cfg.url)) throw configError(`${ids.length} models listed at ${cfg.url}; set llm.model in config.json`)
  return ids[0]
}

// Auth and configuration problems are not the job's fault: keep the job, stop the drain,
// and say what to fix. Other client errors (bad request) count against the job.
export function configError(msg) {
  const e = transient(msg)
  e.config = true
  return e
}

async function checkHttp(res, what) {
  if (res.ok) return
  let detail = ""
  try { detail = redact(JSON.stringify((await res.clone().json()).error || "")).slice(0, 200) } catch {}
  const msg = `${what}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`
  if (res.status === 401 || res.status === 403) throw configError(`${msg} (check the API key: llm.apiKeyEnv or WS_LLM_API_KEY)`)
  if (res.status === 404) throw configError(`${msg} (check llm.url and llm.model)`)
  if (res.status === 408 || res.status === 429 || res.status >= 500) throw transient(msg)
  throw new Error(msg)
}

export async function callModel(cfg, ws, openItems, digest, decided = []) {
  const model = await chooseModel(cfg)
  const user = [
    `WORKSTREAM: ${ws.title} (${ws.id})`,
    `OPEN ITEMS:\n${openItems.map((i) => `${i.id} ${i.text}`).join("\n") || "(none)"}`,
    `DECIDED:\n${decided.map((d) => `${d.id} ${d.text}`).join("\n") || "(none)"}`,
    `SESSION DIGEST:\n${digest}`,
  ].join("\n\n")
  // extraBody can add or override request options (null removes one, e.g. max_tokens for
  // providers that want max_completion_tokens) but never the model or the messages.
  const body = { temperature: 0.2, max_tokens: 1500, response_format: { type: "json_object" }, ...cfg.extraBody, model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }
  for (const k of Object.keys(body)) if (body[k] === null) delete body[k]
  const res = await fetch(`${cfg.url}/chat/completions`, {
    method: "POST",
    headers: llmHeaders(cfg, true),
    signal: AbortSignal.timeout(cfg.timeoutMs),
    body: JSON.stringify(body),
  })
  await checkHttp(res, "chat/completions")
  let d
  try { d = await res.json() } catch { throw transient("chat/completions returned non-JSON") }
  const choice = d.choices?.[0]
  if (!choice) throw transient(`no choices: ${redact(JSON.stringify(d.error || d)).slice(0, 200)}`)
  if (choice.finish_reason !== "stop") throw new Error(`finish_reason ${choice.finish_reason}`)
  return { model, content: choice.message?.content || "" }
}

// Endpoint trouble (down, loading, swapped preset) is not the job's fault: it must not
// use up the job's attempts. Only bad model output (truncated, not JSON, empty) counts.
export function transient(msg) {
  const e = new Error(msg)
  e.transient = true
  return e
}

export async function endpointUp(cfg) {
  return (await endpointStatus(cfg)).ok
}

// { ok, why }: tells "unreachable" apart from "the key was refused".
export async function endpointStatus(cfg) {
  try {
    const r = await fetch(`${cfg.url}/models`, { headers: llmHeaders(cfg), signal: AbortSignal.timeout(10_000) })
    if (r.status === 401 || r.status === 403) return { ok: false, why: `HTTP ${r.status}: the API key was refused (llm.apiKeyEnv or WS_LLM_API_KEY)` }
    if (!r.ok) return { ok: false, why: `HTTP ${r.status} from ${cfg.url}/models` }
    return Array.isArray((await r.json()).data) ? { ok: true } : { ok: false, why: `${cfg.url}/models didn't return a model list` }
  } catch (e) {
    return { ok: false, why: `unreachable (${e.cause?.code || e.name || e.message})` }
  }
}

const STOP = new Set("fix fixed add use get set new old the and for not but are was has had its our out can will about after again also been before being could does done from have into just make more must need only other over same should some still than that their them then there these they this those through under until very want were what when where which while with would your the and for not but are was has had its our out".split(" "))
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "") || w
const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9#]{3,}/g) || []).filter((w) => !STOP.has(w)).map(stem))
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim()
function overlap(a, b) {
  const A = words(a), B = words(b)
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return { n, ratio: n / Math.max(1, Math.min(A.size, B.size)) }
}

// Strict validation: anything off is dropped, not "fixed". `digest` lets us check quotes
// mechanically, because local models confidently close the wrong item. `ws eval` measures this.
export function validateProposal(raw, openItems, digest = null, decided = []) {
  let p
  try { p = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "")) } catch { throw new Error("model output is not JSON") }
  const openIds = new Set(openItems.map((i) => i.id))
  const str = (v) => (typeof v === "string" ? v.trim() : "")
  const summary = str(p.summary)
  if (!summary) throw new Error("empty summary")
  const byId = new Map(openItems.map((i) => [i.id, i]))
  // A close is evidence of work done, so it must quote the assistant or a tool, never the
  // user's request. A decision is the user's, so it must quote the user.
  const linesOf = (pred) => norm(String(digest).split("\n").filter(pred).join("\n"))
  const dig = digest == null ? null : linesOf((l) => !/^USER:/.test(l))
  const userDig = digest == null ? null : linesOf((l) => /^USER:/.test(l))
  const unverified = []
  const checkClose = (c) => {
    if (dig == null) return null
    // The quote must really be in the session, must not just copy the item, and must be about it.
    // Only the verbatim quote counts: the model's own "why" can borrow the item's words.
    const q = norm(c.quote).replace(/[.…]+$/, "")
    const itemText = byId.get(c.id).text
    if (c.quote.split(/\s+/).length < 5) return "quote too short"
    if (!dig.includes(q)) return userDig.includes(q) ? "quote is the user's request, not the result" : "quote not found in the session"
    if (norm(itemText).includes(q) || q.includes(norm(itemText))) return "quote copies the item text"
    if (overlap(itemText, c.quote).n < Math.min(2, words(itemText).size)) return "quote is about something else"
    return null
  }
  const close = (Array.isArray(p.close) ? p.close : [])
    .map((c) => ({ id: str(c?.id).toUpperCase(), quote: str(c?.quote), evidence: str(c?.why || c?.evidence) }))
    .filter((c) => {
      if (!openIds.has(c.id) || !(c.quote || c.evidence)) return false
      const why = checkClose(c)
      if (why) unverified.push({ id: c.id, evidence: c.evidence || c.quote, failed: why })
      return !why
    })
    .map((c) => ({ id: c.id, evidence: c.quote ? `"${c.quote}"${c.evidence ? `: ${c.evidence}` : ""}` : c.evidence }))
    .slice(0, 5)
  const add = (Array.isArray(p.add) ? p.add : [])
    .map((a) => ({ text: str(a?.text), waiting: str(a?.waiting) || null }))
    .filter((a) => a.text && a.text.length <= 300)
    // Drop restatements of items that are already open.
    .filter((a) => !openItems.some((i) => { const o = overlap(i.text, a.text); return o.n >= 3 || o.ratio >= 0.5 }))
    .slice(0, 5)
  // Decisions: verbatim quote from the session, not a restatement of an active decision.
  const decide = []
  for (const d of Array.isArray(p.decide) ? p.decide : []) {
    const text = str(d?.text), quote = str(d?.quote)
    if (!text || text.length > 300) continue
    if (decided.some((x) => { const o = overlap(x.text, text); return o.n >= 3 || o.ratio >= 0.5 })) continue
    const rec = { text, why: str(d?.why) || null, rejected: (Array.isArray(d?.rejected) ? d.rejected : []).map(str).filter(Boolean).slice(0, 4), quote }
    let failed = null
    if (dig != null) {
      const q = norm(quote).replace(/[.…]+$/, "")
      if (quote.split(/\s+/).length < 5) failed = "quote too short"
      else if (!userDig.includes(q)) failed = dig.includes(q) ? "not the user's words; confirm the user decided it" : "quote not found in the session"
    }
    decide.push(failed ? { ...rec, unverified: failed } : rec)
    if (decide.length >= 3) break
  }
  return { summary: summary.slice(0, 800), close, add, unverified: unverified.slice(0, 5), decide }
}

// ------------------------------------------------------------------ drain

export async function processJob(job, cfg) {
  let ws
  try { ws = await store.getWorkstream(job.ws) } catch { return { skipped: "workstream no longer exists" } }
  const openItems = (await store.readOpen(job.ws)).items.filter((i) => !i.done)
  const decided = (await store.readDecisions(job.ws)).decisions.filter((d) => d.active)
  const digest = await digestTranscript(job.tool, job.transcript)
  if (digest.length < 200) return { skipped: "digest too short" }
  const { model, content } = await callModel(cfg, ws, openItems, digest, decided)
  const proposal = validateProposal(content, openItems, digest, decided)
  const dir = path.join(PROPOSALS_DIR, job.ws)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${store.sessionTag(job.session)}.md`)
  const data = { ws: job.ws, session: job.session, tool: job.tool, log: job.log, model, created: new Date().toISOString(), close: proposal.close, add: proposal.add, unverified: proposal.unverified, decide: proposal.decide }
  // Deleted while the model was working: don't recreate its proposals.
  if (!(await fs.access(ws.file).then(() => true, () => false))) return { skipped: "workstream deleted during summary" }
  await store.writeFileAtomic(file, matter.stringify(`\n${proposal.summary}\n`, data))
  return { file, proposal }
}

// The drain lock is refreshed before every job; it's stale only after a full model
// timeout (plus slack) with no sign of life.
async function takeDrainLock(lock, cfg) {
  await fs.mkdir(QUEUE_DIR, { recursive: true })
  try { await fs.mkdir(lock); return true } catch {}
  const staleMs = Math.max(15 * 60_000, 2 * cfg.timeoutMs + 60_000)
  try { if (Date.now() - (await fs.stat(lock)).mtimeMs < staleMs) return false } catch {}
  await fs.rm(lock, { recursive: true, force: true })
  try { await fs.mkdir(lock); return true } catch { return false }
}

// Re-read the job file: if it was re-queued (new token) while we worked, leave it.
async function sameJob(job) {
  try { return JSON.parse(await fs.readFile(job.file, "utf-8")).token === job.token } catch { return false }
}

export async function drain({ log = () => {} } = {}) {
  const cfg = await llmConfig()
  if (!cfg) return { done: 0, failed: 0, note: "no llm configured" }
  const lock = path.join(QUEUE_DIR, ".drain.lock")
  if (!(await takeDrainLock(lock, cfg))) return { done: 0, failed: 0, note: "another drain is running" }
  let done = 0, failed = 0
  try {
    const up = await endpointStatus(cfg)
    if (!up.ok) return { done, failed, note: `model endpoint ${up.why}; queue kept` }
    for (const job of await listQueue()) {
      const now = new Date()
      await fs.utimes(lock, now, now).catch(() => {})
      try {
        const r = await processJob(job, cfg)
        if (await sameJob(job)) await fs.rm(job.file, { force: true })
        done++
        log(`${job.ws} ${store.sessionTag(job.session)}: ${r.skipped || "proposal written"}`)
      } catch (e) {
        failed++
        const isTransient = e.transient || e.name === "TimeoutError" || e.name === "AbortError" || /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(String(e.message))
        if (!isTransient) job.attempts = (job.attempts || 0) + 1
        job.lastError = redact(String(e.message || e)).slice(0, 300)
        const { file, ...rest } = job
        if (await sameJob(job)) {
          if (job.attempts >= MAX_ATTEMPTS) {
            await fs.mkdir(path.join(QUEUE_DIR, "failed"), { recursive: true })
            await store.writeFileAtomic(path.join(QUEUE_DIR, "failed", path.basename(file)), JSON.stringify(rest, null, 2))
            await fs.rm(file, { force: true })
          } else {
            await store.writeFileAtomic(file, JSON.stringify(rest, null, 2))
          }
        }
        log(`${job.ws} ${store.sessionTag(job.session)}: failed (${job.lastError})`)
        if (isTransient) break // endpoint or config trouble: stop, retry later without charging other jobs
      }
    }
  } finally {
    await fs.rm(lock, { recursive: true, force: true })
  }
  return { done, failed }
}

// ------------------------------------------------------------------ review

export async function listProposals(wsId) {
  const out = []
  let dirs = []
  try { dirs = wsId ? [wsId] : await fs.readdir(PROPOSALS_DIR) } catch { return [] }
  for (const d of dirs) {
    let files = []
    try { files = (await fs.readdir(path.join(PROPOSALS_DIR, d))).filter((f) => f.endsWith(".md")).sort() } catch { continue }
    for (const f of files) {
      const file = path.join(PROPOSALS_DIR, d, f)
      const { data, content } = parseMd(await fs.readFile(file, "utf-8"))
      out.push({ file, ...data, summary: content.trim() })
    }
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)))
}

export async function acceptProposal(p, opts = {}) {
  // Claim the proposal first (rename is atomic): two accepts of the same proposal, from
  // the CLI and the board at once, can't both apply it.
  const claimed = `${p.file}.accepting`
  try { await fs.rename(p.file, claimed) } catch (e) {
    if (e.code === "ENOENT") throw new Error("This proposal was already accepted or rejected")
    throw e
  }
  try {
    return await applyProposal({ ...p, file: claimed }, opts)
  } catch (e) {
    await fs.rename(claimed, p.file).catch(() => {})
    throw e
  }
}

async function applyProposal(p, { close = true, add = true, summary = true, unverified = [], decide = true, confirmDecisions = [] } = {}) {
  const applied = { closed: [], added: [], decided: [], skipped: [] }
  // Verified decisions apply with `decide`; unverified ones only when confirmed by index.
  for (const [i, d] of (p.decide || []).entries()) {
    if (d.unverified ? !confirmDecisions.includes(i) : !decide) continue
    try {
      const r = await store.decide(p.ws, d.text, { why: d.why || undefined, rejected: d.rejected, evidence: d.quote ? `"${d.quote}"` : undefined, session: p.session })
      applied.decided.push(r.decision.id)
    } catch (e) { applied.skipped.push(`decision: ${e.message}`) }
  }
  // Unverified closes apply only when the reviewer ticks them, by ID.
  for (const id of unverified) {
    const u = (p.unverified || []).find((x) => x.id === id)
    if (!u) continue
    try { applied.closed.push((await store.closeItem(p.ws, u.id, { session: p.session, note: `reviewer confirmed: ${u.evidence}` })).id) } catch (e) { applied.skipped.push(`${u.id}: ${e.message}`) }
  }
  if (add) for (const a of p.add || []) applied.added.push((await store.addItem(p.ws, a.text, { waiting: a.waiting })).id)
  if (close) {
    for (const c of p.close || []) {
      try { applied.closed.push((await store.closeItem(p.ws, c.id, { session: p.session, note: c.evidence })).id) } catch (e) { applied.skipped.push(`${c.id}: ${e.message}`) }
    }
  }
  if (summary && p.log) {
    // Same session's own log stub: safe to rewrite. Mark it reviewed-model text.
    try {
      const { data, content } = parseMd(store.normalizeEol(await fs.readFile(p.log, "utf-8")))
      // Never replace a summary someone wrote; only fill an "(auto)" placeholder.
      if (content.trim() && !/^\(auto\)/.test(content.trim())) {
        applied.skipped.push("summary: session already has notes")
        await fs.rm(p.file, { force: true })
        return applied
      }
      data.source = `${data.source || "hook"}+model`
      data.summary_model = p.model
      if (applied.closed.length) data.closed = applied.closed
      if (applied.added.length) data.added = applied.added
      await store.writeFileAtomic(p.log, matter.stringify(`\n${p.summary}\n`, data))
    } catch (e) { applied.skipped.push(`log: ${e.message}`) }
  }
  await fs.rm(p.file, { force: true })
  return applied
}

export async function rejectProposal(p) {
  await fs.rm(p.file, { force: true })
}
