// Builds a resume prompt from the fact owners in docs/ARCHITECTURE.md. Fails loudly on any pointer
// that doesn't resolve, rather than quietly dropping it.
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import matter from "gray-matter"

// gray-matter caches parses by text and shares the data object; mutating it poisons
// later reads of identical text. Passing options disables the cache.
const parseMd = (text) => matter(text, {})
import { getWorkstream, getProcedure, readOpen, readDecisions, fillVars, variablesIn, tildify, expand } from "./store.mjs"
import { listProposals } from "./summarize.mjs"

// Claude names memory dirs after the cwd with every non-alphanumeric char → "-".
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-")
}

function memorySlugOf(p) {
  const m = p.match(/\/projects\/([^/]+)\/memory\//) // ~/.claude or $CLAUDE_CONFIG_DIR
  return m ? m[1] : null
}

export function findSection(text, needle) {
  const lines = text.split("\n")
  let hit = -1
  lines.forEach((l, i) => {
    if (/^#{1,6}\s/.test(l) && l.toLowerCase().includes(needle.toLowerCase())) hit = i
  })
  if (hit < 0) return null
  const level = lines[hit].match(/^#+/)[0].length
  let end = lines.length
  for (let i = hit + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/)
    if (m && m[1].length <= level) { end = i; break }
  }
  return { heading: lines[hit].replace(/^#+\s*/, ""), body: lines.slice(hit, end).join("\n").trim() }
}

// Returns { problems: string[] } describing every pointer that fails to resolve.
export async function checkSources(ws) {
  const problems = []
  if (ws.cwd && !path.isAbsolute(ws.cwd)) {
    problems.push(`cwd must be an absolute folder, not "${ws.data.cwd}": sessions won't be matched until it is fixed (ws set ${ws.id} cwd=<folder>)`)
  } else if (ws.cwd) {
    try { await fs.access(ws.cwd) } catch { problems.push(`cwd does not exist: ${tildify(ws.cwd)}`) }
  }
  for (const s of ws.sources) {
    let text
    try { text = await fs.readFile(s.path, "utf-8") } catch {
      problems.push(`source missing: ${tildify(s.path)}`); continue
    }
    if (s.section && !findSection(text, s.section)) {
      problems.push(`no heading containing "${s.section}" in ${tildify(s.path)}`)
    }
  }
  if (ws.data.mirror) {
    try { await fs.access(expand(ws.data.mirror)) } catch { problems.push(`mirror doc missing: ${ws.data.mirror}`) }
  }
  if (ws.procedure) {
    try {
      const proc = await getProcedure(ws.procedure)
      const missing = variablesIn(proc.body + ws.input).filter((v) => !(v in ws.vars))
      if (missing.length) problems.push(`vars not set: ${missing.join(", ")}`)
    } catch (e) { problems.push(e.message) }
  }
  return problems
}

// Absolute paths mentioned in a source that no longer exist (pointer rot inside docs).
export async function stalePathsIn(file) {
  const text = await fs.readFile(file, "utf-8")
  const found = new Set()
  for (const m of text.matchAll(/`((?:~|\/Users\/|\/home\/)[^`\n*]+)`/g)) {
    const p = m[1].replace(/^~(?=\/)/, os.homedir()).replace(/[\s:,.]+$/, "")
    if (/[{}<>$*]/.test(p)) continue
    try { await fs.access(p) } catch { found.add(m[1]) }
  }
  return [...found]
}

/** @param {string} id @param {{ tool?: string, inline?: boolean }} [opts] */
export async function compose(id, { tool, inline = false } = {}) {
  const ws = await getWorkstream(id)
  tool = tool || ws.tool
  const problems = await checkSources(ws)
  if (problems.length) {
    throw new Error(`Can't compose ${id}:\n  - ${problems.join("\n  - ")}\nFix the pointers (ws doctor ${id}).`)
  }

  const vars = { title: ws.title, ...ws.vars }
  const read = []
  const included = []
  for (const s of ws.sources) {
    const name = path.basename(s.path)
    const memoryHere = memorySlugOf(s.path) && ws.cwd && memorySlugOf(s.path) === claudeProjectSlug(ws.cwd)
    const mustInline = inline || (s.role === "memory" && !(tool === "claude" && memoryHere))
    if (mustInline) {
      const raw = await fs.readFile(s.path, "utf-8")
      let body = parseMd(raw).content.trim()
      if (s.section) body = findSection(raw, s.section).body
      read.push(s.role === "memory"
        ? `- my memory note ${name} (included below)`
        : `- ${s.section ? `the latest "${s.section}" section of ` : ""}${tildify(s.path)} (included below)`)
      included.push(`### ${s.section ? `${findSection(raw, s.section).heading} — ` : ""}${tildify(s.path)}\n\n${body}`)
    } else if (s.role === "memory") {
      read.push(`- my memory note ${name} (${tildify(s.path)})`)
    } else if (s.section) {
      read.push(`- the latest "${s.section}" section in ${tildify(s.path)}`)
    } else {
      read.push(`- ${tildify(s.path)}${s.role ? ` (${s.role})` : ""}`)
    }
  }

  const parts = [`Continuing ${ws.title}.${ws.brief ? " " + ws.brief : ""}`]
  if (read.length) parts.push(`Read these first:\n${read.join("\n")}`)
  parts.push(fillVars(ws.input, vars))
  if (ws.procedure) parts.push(fillVars((await getProcedure(ws.procedure)).body, vars))

  const decided = (await readDecisions(id)).decisions.filter((d) => d.active)
  if (decided.length) {
    parts.push("Decided (don't reopen these without new evidence; if something contradicts one, say so):\n" +
      decided.map((d) => `- ${d.id} ${d.text}${d.why ? `. Why: ${d.why}` : ""}${d.rejected ? `. Rejected: ${d.rejected}` : ""}`).join("\n"))
  }

  const { items } = await readOpen(id)
  const open = items.filter((i) => !i.done)
  if (open.length) {
    parts.push("Still open:\n" + open.map((i) => `- ${i.id} ${i.text}${i.waiting ? ` (waiting on ${i.waiting})` : ""}`).join("\n"))
  }

  // Prefer the newest session with a real summary; mention unsummarized ones after it.
  const isAuto = (l) => /^\(auto\)/.test(l.summary || "")
  const lastIdx = ws.logs.findLastIndex((l) => l.summary && !isAuto(l))
  const later = ws.logs.slice(lastIdx + 1).filter(isAuto)
  if (lastIdx >= 0) {
    const last = ws.logs[lastIdx]
    const when = String(last.ended || "").slice(0, 10)
    parts.push(`Last session (${[when, last.tool].filter(Boolean).join(", ")}): ${last.summary.split("\n")[0]}`)
  }
  if (later.length) {
    const drafts = new Map((await listProposals(id)).map((p) => [p.session, p.summary]))
    parts.push(`Sessions since then with no notes (check their changes):\n` +
      later.slice(-3).map((l) => {
        const d = drafts.get(l.session)
        return `- ${String(l.ended || "").slice(0, 10)} ${l.tool || ""} "${l.title || "untitled"}"` +
          (d ? `. Unreviewed machine summary: ${d.split("\n")[0]}` : "")
      }).join("\n"))
  }

  parts.push(
    `When you finish, record changes in workstream "${id}" with the ws MCP tools ` +
    `(\`ws_item_close\`, \`ws_item_add\`, \`ws_decide\`, \`ws_log\`). If they aren't available, use the CLI from any folder:\n` +
    `- \`ws item close ${id} <ID>\` / \`ws item add ${id} "<text>" [--waiting <who>]\`\n` +
    `- \`ws decide ${id} "<decision>" --why "…" [--rejected "…"] [--supersedes <ID>]\` for settled choices\n` +
    `- \`ws log ${id} "<one-line summary>" --tool ${tool}\``,
  )
  if (included.length) parts.push(`## Included files\n\n${included.join("\n\n")}`)

  const text = parts.join("\n\n") + "\n"
  const leftover = variablesIn(text.split("## Included files")[0])
  if (leftover.length) throw new Error(`Unfilled vars in ${id}: ${leftover.join(", ")}`)
  return { ws, tool, text }
}
