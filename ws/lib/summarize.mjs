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

export const QUEUE_DIR = path.join(store.ROOT, "queue")
export const PROPOSALS_DIR = path.join(store.ROOT, "proposals")
const CONFIG_FILE = path.join(store.ROOT, "config.json")
const MAX_ATTEMPTS = 5
const DIGEST_CHARS = 48_000 // ~12k tokens: well inside a 131k context, leaves room to think
const HEAD_CHARS = 6_000

// ------------------------------------------------------------------ config

export async function llmConfig() {
  let cfg = {}
  try { cfg = JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8")).llm || {} } catch {}
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
    extraBody: cfg.extraBody && typeof cfg.extraBody === "object" ? cfg.extraBody : {},
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
  const home = process.env.HOME || ""
  if (tool !== "codex") {
    const base = path.join(home, ".claude", "projects")
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
    return walk(path.join(home, ".codex", "sessions"), 0)
  }
  return null
}

export async function enqueue({ ws, session, tool, transcript, log }) {
  transcript = transcript || (await findTranscript(tool, session))
  if (!transcript) throw new Error(`no transcript found for session ${session}`)
  await fs.mkdir(QUEUE_DIR, { recursive: true })
  const file = path.join(QUEUE_DIR, `${store.sessionTag(session)}.json`)
  const job = { ws, session, tool, transcript: store.expand(transcript), log, attempts: 0, queued: new Date().toISOString() }
  await fs.writeFile(file, JSON.stringify(job, null, 2))
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
    await fs.writeFile(path.join(QUEUE_DIR, path.basename(f)), JSON.stringify(job, null, 2))
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

function toolHint(name, input = {}) {
  const h = input.file_path || input.notebook_path || input.command || input.pattern || input.url || input.description || ""
  return `${name}${h ? `(${clip(String(h).replace(/\s+/g, " "), 140)})` : ""}`
}

// User prompts, assistant prose and tool names, no tool output or images.
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
  const all = lines.join("\n")
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

export async function callModel(cfg, ws, openItems, digest, decided = []) {
  let model = cfg.model
  if (!model) {
    const r = await fetch(`${cfg.url}/models`, { headers: llmHeaders(cfg), signal: AbortSignal.timeout(10_000) })
    model = (await r.json()).data?.[0]?.id
    if (!model) throw new Error("no model listed at /models")
  }
  const user = [
    `WORKSTREAM: ${ws.title} (${ws.id})`,
    `OPEN ITEMS:\n${openItems.map((i) => `${i.id} ${i.text}`).join("\n") || "(none)"}`,
    `DECIDED:\n${decided.map((d) => `${d.id} ${d.text}`).join("\n") || "(none)"}`,
    `SESSION DIGEST:\n${digest}`,
  ].join("\n\n")
  const res = await fetch(`${cfg.url}/chat/completions`, {
    method: "POST",
    headers: llmHeaders(cfg, true),
    signal: AbortSignal.timeout(cfg.timeoutMs),
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      ...cfg.extraBody,
    }),
  })
  const d = await res.json()
  const choice = d.choices?.[0]
  if (!choice) throw transient(`no choices: ${JSON.stringify(d.error || d).slice(0, 200)}`)
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
  try {
    const r = await fetch(`${cfg.url}/models`, { headers: llmHeaders(cfg), signal: AbortSignal.timeout(10_000) })
    return r.ok && Array.isArray((await r.json()).data)
  } catch {
    return false
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
  const dig = digest == null ? null : norm(digest)
  const unverified = []
  const checkClose = (c) => {
    if (dig == null) return null
    // The quote must really be in the session, must not just copy the item, and must be about it.
    // Only the verbatim quote counts: the model's own "why" can borrow the item's words.
    const q = norm(c.quote).replace(/[.…]+$/, "")
    const itemText = byId.get(c.id).text
    if (c.quote.split(/\s+/).length < 5) return "quote too short"
    if (!dig.includes(q)) return "quote not found in the session"
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
      else if (!dig.includes(q)) failed = "quote not found in the session"
    }
    decide.push(failed ? { ...rec, unverified: failed } : rec)
    if (decide.length >= 3) break
  }
  return { summary: summary.slice(0, 800), close, add, unverified: unverified.slice(0, 5), decide }
}

// ------------------------------------------------------------------ drain

export async function processJob(job, cfg) {
  const ws = await store.getWorkstream(job.ws)
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
  await fs.writeFile(file, matter.stringify(`\n${proposal.summary}\n`, data))
  return { file, proposal }
}

export async function drain({ log = () => {} } = {}) {
  const cfg = await llmConfig()
  if (!cfg) return { done: 0, failed: 0, note: "no llm configured" }
  // One drainer at a time.
  const lock = path.join(QUEUE_DIR, ".drain.lock")
  await fs.mkdir(QUEUE_DIR, { recursive: true })
  try { await fs.mkdir(lock) } catch {
    try { if (Date.now() - (await fs.stat(lock)).mtimeMs < 15 * 60_000) return { done: 0, failed: 0, note: "another drain is running" } } catch {}
    await fs.rm(lock, { recursive: true, force: true }); await fs.mkdir(lock)
  }
  let done = 0, failed = 0
  try {
    if (!(await endpointUp(cfg))) return { done, failed, note: `model endpoint unreachable (${cfg.url}); queue kept` }
    for (const job of await listQueue()) {
      try {
        const r = await processJob(job, cfg)
        await fs.rm(job.file, { force: true })
        done++
        log(`${job.ws} ${store.sessionTag(job.session)}: ${r.skipped || "proposal written"}`)
      } catch (e) {
        failed++
        const isTransient = e.transient || e.name === "TimeoutError" || e.name === "AbortError" || /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(String(e.message))
        if (!isTransient) job.attempts = (job.attempts || 0) + 1
        job.lastError = String(e.message || e).slice(0, 300)
        const { file, ...rest } = job
        if (job.attempts >= MAX_ATTEMPTS) {
          await fs.mkdir(path.join(QUEUE_DIR, "failed"), { recursive: true })
          await fs.writeFile(path.join(QUEUE_DIR, "failed", path.basename(file)), JSON.stringify(rest, null, 2))
          await fs.rm(file, { force: true })
        } else {
          await fs.writeFile(file, JSON.stringify(rest, null, 2))
        }
        log(`${job.ws} ${store.sessionTag(job.session)}: failed (${job.lastError})`)
        if (isTransient) break // endpoint trouble: stop, retry later without charging other jobs
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

export async function acceptProposal(p, { close = true, add = true, summary = true, unverified = [], decide = true, confirmDecisions = [] } = {}) {
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
      const { data, content } = parseMd(await fs.readFile(p.log, "utf-8"))
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
      await fs.writeFile(p.log, matter.stringify(`\n${p.summary}\n`, data))
    } catch (e) { applied.skipped.push(`log: ${e.message}`) }
  }
  await fs.rm(p.file, { force: true })
  return applied
}

export async function rejectProposal(p) {
  await fs.rm(p.file, { force: true })
}
