#!/usr/bin/env node
// ws: save and recall workstream state across Claude Code and Codex sessions.
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import { parseArgs } from "node:util"
import readline from "node:readline/promises"
import path from "node:path"
import os from "node:os"
import * as store from "../lib/store.mjs"
import { compose, checkSources, stalePathsIn } from "../lib/compose.mjs"
import * as capture from "../lib/capture.mjs"
import * as summarize from "../lib/summarize.mjs"
import { runEval } from "../lib/eval.mjs"
import { loadConfig } from "../lib/config.mjs"
import { fileURLToPath } from "node:url"

const HELP = `ws: workstream state for Claude Code and Codex   (data: ${store.tildify(store.ROOT)})

  ws setup [--claude] [--codex] [--dry-run] [--no-link] [--no-hooks] [--no-mcp]
                                   create the data folder, put ws on PATH, add hooks + MCP to Claude Code / Codex
  ws setup --uninstall [--dry-run] remove ws's hooks, MCP entries and CLI link (your data is kept)
  ws                               pick a workstream, then \`go\`
  ws ls [--all]                    list workstreams (active + waiting; --all adds parked/done/archived)
  ws show <id>                     brief, open items, recent sessions
  ws prompt <id> [--tool codex] [--inline] [--no-copy]
                                   print the resume prompt and copy it to the clipboard
  ws go <id> [--codex] [--resume]  edit the prompt (fill the input slot), then launch in cwd
  ws new <id> --title T --cwd DIR [--group G] [--prefix P] [--tool claude|codex]
  ws archive <id> | ws unarchive <id>   hide a finished workstream (kept; unarchive restores its status)
  ws delete <id> [--yes]           move it to the trash (restorable)
  ws trash [restore <name> | empty [<name>] --yes]
  ws set <id> key=value ...        e.g. status=waiting "waiting_on=client: next batch"
  ws item add <id> "text" [--waiting WHO]
  ws item close <id> <ITEM> [--session S] [--note N]
  ws item edit <id> <ITEM> [--text T] [--waiting WHO]
  ws decide <id> "decision" [--why W] [--rejected "A; B"] [--evidence E] [--supersedes ID]
  ws decisions <id> [--all]        settled choices (--all includes superseded)
  ws log <id> "summary" [--tool T] [--session S] [--closed A-1,A-2] [--added A-3]
  ws doctor [id]                   check every pointer resolves; flag dead paths inside sources
  ws mirror <id> [file] [--force]  opt in: keep a generated open-items block in a project doc
  ws inbox                         sessions that ended outside any workstream
  ws inbox assign <n> <id> ["summary"] | ws inbox new <n> <id> | ws inbox ignore <n> [--cwd] | ws inbox clear
  ws review                        model-drafted proposals for sessions that ended without notes
  ws review show <n> | accept <n> [--no-close] [--no-add] [--no-decide] [--no-summary] [--confirm ID,…] [--confirm-decision K,…] | reject <n>
  ws summarize --drain             process the summary queue now (needs llm.url in config.json)
  ws summarize --requeue           retry jobs that failed 5 times (bad model output)
  ws summarize <id> --session S    queue one linked session for a proposal
  ws eval [--runs N] [--case NAME]  score the summarizer on real sessions in $WS_ROOT/eval; fails below the floors
  ws stale [--days N]              active/waiting workstreams with no session in N days (default 7)
  ws board                         open the board (starts the background service if installed, else a dev server)
  ws board --install | --uninstall install/remove the background service (starts at login; 127.0.0.1:3311)
  ws board --rebuild | --status    rebuild after updating ws, then restart; or show service state
  ws board --dev [--port N]        run a dev server in this terminal instead
  ws hook <claude|codex> <start|end>  hook entry point (reads the hook JSON on stdin; never fails)
`

const { values: opt, positionals: args } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    all: { type: "boolean" }, tool: { type: "string" }, inline: { type: "boolean" },
    "no-copy": { type: "boolean" }, codex: { type: "boolean" }, claude: { type: "boolean" },
    resume: { type: "boolean" }, title: { type: "string" }, cwd: { type: "string" },
    group: { type: "string" }, prefix: { type: "string" }, waiting: { type: "string" },
    session: { type: "string" }, force: { type: "boolean" }, drain: { type: "boolean" }, quiet: { type: "boolean" },
    port: { type: "string" }, install: { type: "boolean" }, uninstall: { type: "boolean" }, rebuild: { type: "boolean" }, status: { type: "boolean" }, dev: { type: "boolean" }, yes: { type: "boolean", short: "y" }, runs: { type: "string" }, case: { type: "string" }, "confirm-decision": { type: "string" }, "no-decide": { type: "boolean" }, why: { type: "string" }, rejected: { type: "string" }, evidence: { type: "string" }, supersedes: { type: "string" }, requeue: { type: "boolean" }, confirm: { type: "string" }, "no-open": { type: "boolean" }, "no-close": { type: "boolean" }, "no-add": { type: "boolean" }, "no-summary": { type: "boolean" }, days: { type: "string" }, note: { type: "string" }, text: { type: "string" },
    closed: { type: "string" }, added: { type: "string" }, help: { type: "boolean", short: "h" },
    "dry-run": { type: "boolean" }, "no-link": { type: "boolean" }, "no-hooks": { type: "boolean" }, "no-mcp": { type: "boolean" },
  },
})

// `ws ls | head` closes the pipe early; that is not an error.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e })

const RESUME_WINDOW_H = 12
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)
const need = (v, what) => { if (!v) die(`missing ${what}\n\n${HELP}`); return v }
function die(msg) { console.error(msg); process.exit(1) }
const ago = (ms) => {
  const h = (Date.now() - ms) / 36e5
  return h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`
}

async function counts() {
  const [inbox, props, queue, failed] = await Promise.all([capture.listInbox(), summarize.listProposals(), summarize.listQueue(), summarize.listFailed()])
  const bits = [inbox.length && `${inbox.length} in inbox (ws inbox)`, props.length && `${props.length} to review (ws review)`, queue.length && `${queue.length} queued`,
    failed.length && `${failed.length} summaries failed (ws summarize --requeue)`].filter(Boolean)
  return bits.length ? dim(bits.join(" · ")) : ""
}

async function cmdLs() {
  const all = await store.listWorkstreams()
  const shown = all.filter((w) => opt.all || ["active", "waiting"].includes(w.status))
  if (!shown.length) return console.log(`No workstreams yet. Create one: ws new <id> --title "…" --cwd <dir>`)
  for (const w of shown) {
    const open = (await store.readOpen(w.id)).items.filter((i) => !i.done).length
    console.log(
      `${bold(w.id.padEnd(26))} ${w.status.padEnd(8)} ${String(open).padStart(2)} open  ${dim(ago(w.lastActivity).padStart(4))}  ${w.title}` +
      (w.waiting_on ? dim(`  — waiting on ${w.waiting_on}`) : ""),
    )
  }
  const c = await counts()
  if (c) console.log(`\n${c}`)
  return shown
}

async function cmdShow(id) {
  const w = await store.getWorkstream(id)
  console.log(`${bold(w.title)}  ${dim(`[${w.status}] ${w.group}`)}`)
  if (w.waiting_on) console.log(`waiting on: ${w.waiting_on}`)
  if (w.cwd) console.log(`cwd: ${store.tildify(w.cwd)}`)
  if (w.brief) console.log(`\n${w.brief}`)
  const { items } = await store.readOpen(id)
  console.log(`\n${bold("Open")}`)
  for (const i of items.filter((i) => !i.done)) console.log(`  ${i.id.padEnd(6)} ${i.text}${i.waiting ? dim(`  @${i.waiting}`) : ""}`)
  const decided = (await store.readDecisions(id)).decisions.filter((d) => d.active)
  if (decided.length) {
    console.log(`\n${bold("Decided")}`)
    for (const d of decided) console.log(`  ${d.id.padEnd(8)} ${d.text}${d.why ? dim(`  — ${d.why}`) : ""}`)
  }
  if (w.logs.length) {
    console.log(`\n${bold("Recent sessions")}`)
    for (const l of w.logs.slice(-5)) console.log(`  ${String(l.ended || "").slice(0, 10)} ${dim((l.tool || "").padEnd(6))} ${l.summary.split("\n")[0]}`)
  }
}

// Clipboard and browser helpers: macOS, Linux (Wayland or X11) and Windows.
function copy(text) {
  const tools = process.platform === "darwin" ? [["pbcopy"]]
    : process.platform === "win32" ? [["clip"]]
    : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
  for (const [cmd, ...a] of tools) {
    const r = spawnSync(cmd, a, { input: text })
    if (!r.error && r.status === 0) return true
  }
  return false
}

function openUrl(url) {
  if (opt["no-open"]) return
  const [cmd, ...a] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"]
  spawnSync(cmd, [...a, url], { stdio: "ignore" })
}

async function cmdPrompt(id) {
  const { text } = await compose(id, { tool: opt.tool, inline: opt.inline })
  process.stdout.write(text)
  if (!opt["no-copy"] && copy(text)) console.error(dim("\n(copied to clipboard)"))
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question(q)).trim() } finally { rl.close() }
}

async function cmdGo(id) {
  const tool = opt.codex ? "codex" : opt.claude ? "claude" : opt.tool || undefined
  const { ws, tool: t, text } = await compose(id, { tool, inline: opt.inline })
  const tmp = path.join(os.tmpdir(), `ws-${id}-${Date.now()}.md`)
  await fs.writeFile(tmp, text)
  // $VISUAL, then $EDITOR, then nano. Run through the shell so quoted paths and
  // arguments in the variable ("code --wait", "/Applications/My Editor/bin/ed") work.
  const editor = process.env.VISUAL || process.env.EDITOR || "nano"
  // Put the cursor on the input slot where the editor supports +LINE.
  const slotLine = text.split("\n").findIndex((l) => l.includes(store.fillVars(ws.input, { title: ws.title, ...ws.vars }).split("\n")[0])) + 1
  const edArgs = /(^|\/)(nano|vim?|nvim|emacs|micro)['"]?$/.test(editor.trim().split(/\s+/)[0]) && slotLine > 0 ? [`+${slotLine}`, tmp] : [tmp]
  const ed = spawnSync("sh", ["-c", `${editor} "$@"`, "ws-editor", ...edArgs], { stdio: "inherit" })
  if (ed.status !== 0) die(`editor exited with ${ed.status}; not launching`)
  const edited = (await fs.readFile(tmp, "utf-8")).trim()
  await fs.rm(tmp, { force: true })
  if (!edited) die("Prompt is empty; not launching.")
  if (edited === text.trim() && /\[[^\]]*\]/.test(ws.input)) {
    const a = await ask("The input slot wasn't filled. Launch anyway? [y/N] ")
    if (!/^y/i.test(a)) die("Not launched.")
  }

  let resumeId = null
  if (opt.resume) {
    const last = [...ws.logs].reverse().find((l) => l.session && (l.tool || "claude") === t)
    const fresh = last && Date.now() - new Date(last.ended).getTime() < RESUME_WINDOW_H * 36e5
    if (fresh) resumeId = last.session
    else console.error(dim(`No ${t} session in the last ${RESUME_WINDOW_H}h; starting fresh.`))
  }
  const argv = t === "codex"
    ? (resumeId ? ["resume", resumeId, edited] : [edited])
    : (resumeId ? ["--resume", resumeId, edited] : ["-n", ws.title, edited])
  const cwd = ws.cwd || process.cwd()
  console.error(dim(`→ ${t}${resumeId ? ` (resume ${resumeId.slice(0, 8)})` : ""} in ${store.tildify(cwd)}`))
  const r = spawnSync(t, argv, { stdio: "inherit", cwd, env: { ...process.env, WS_ID: id } })
  process.exit(r.status ?? 0)
}

async function cmdPick() {
  const shown = await cmdLs()
  if (!shown?.length) return
  const a = await ask(`\nPick (number or id, blank to quit): `)
  if (!a) return
  const w = /^\d+$/.test(a) ? shown[Number(a) - 1] : shown.find((w) => w.id.startsWith(a))
  if (!w) die("No match.")
  await cmdGo(w.id)
}

async function cmdNew(id) {
  const w = await store.createWorkstream(need(id, "<id>"), {
    title: opt.title || id, group: opt.group, cwd: opt.cwd && store.tildify(path.resolve(store.expand(opt.cwd))),
    prefix: opt.prefix, tool: opt.tool,
  })
  console.log(`Created ${store.tildify(w.file)}\nAdd sources/procedure/vars there, then: ws prompt ${id}`)
}

async function cmdSet(id, pairs) {
  const patch = {}
  for (const p of pairs) {
    const i = p.indexOf("=")
    if (i < 1) die(`expected key=value, got "${p}"`)
    patch[p.slice(0, i)] = p.slice(i + 1)
  }
  await store.updateWorkstream(need(id, "<id>"), patch)
  console.log(`Updated ${id}: ${Object.keys(patch).join(", ")}`)
}

async function cmdItem(sub, id, rest) {
  need(id, "<id>")
  if (sub === "add") {
    const i = await store.addItem(id, need(rest.join(" "), "text"), { waiting: opt.waiting })
    console.log(`Added ${i.id}: ${i.text}`)
  } else if (sub === "close") {
    for (const itemId of need(rest.length && rest, "<ITEM>")) {
      const i = await store.closeItem(id, itemId, { session: opt.session, note: opt.note })
      console.log(`Closed ${i.id}: ${i.text}`)
    }
  } else if (sub === "edit") {
    const i = await store.editItem(id, need(rest[0], "<ITEM>"), { text: opt.text, waiting: opt.waiting })
    console.log(`Updated ${i.id}: ${i.text}${i.waiting ? ` @${i.waiting}` : ""}`)
  } else if (!sub || sub === "ls") {
    for (const i of (await store.readOpen(id)).items.filter((i) => !i.done)) console.log(`${i.id}\t${i.text}`)
  } else die(`unknown: ws item ${sub}`)
}

async function cmdDecide(id, rest) {
  const r = await store.decide(need(id, "<id>"), need(rest.join(" "), "decision text"), {
    why: opt.why, rejected: opt.rejected, evidence: opt.evidence, session: opt.session, supersedes: opt.supersedes,
  })
  console.log(`Decided ${r.decision.id}: ${r.decision.text}${r.superseded ? ` (supersedes ${r.superseded})` : ""}`)
}

async function cmdDecisions(id) {
  const { decisions } = await store.readDecisions(need(id, "<id>"))
  const shown = decisions.filter((d) => opt.all || d.active)
  if (!shown.length) return console.log("No decisions recorded.")
  for (const d of shown) {
    console.log(`${bold(d.id.padEnd(8))} ${d.text}${d.active ? "" : dim(`  (superseded by ${d.superseded_by})`)}`)
    for (const k of ["why", "rejected", "evidence"]) if (d[k]) console.log(dim(`         ${k}: ${d[k]}`))
  }
}

async function cmdLog(id, rest) {
  const list = (s) => (s ? s.split(",").map((x) => x.trim()) : undefined)
  const file = await store.appendLog(need(id, "<id>"), {
    summary: need(rest.join(" "), "summary"), tool: opt.tool, session: opt.session,
    cwd: store.tildify(process.cwd()), closed: list(opt.closed), added: list(opt.added),
  })
  console.log(`Logged ${store.tildify(file)}`)
}

async function cmdDoctor(id) {
  const all = id ? [await store.getWorkstream(id)] : await store.listWorkstreams()
  let bad = 0
  for (const w of all) {
    const problems = await checkSources(w)
    const warnings = []
    for (const s of w.sources) {
      try { for (const p of await stalePathsIn(s.path)) warnings.push(`${path.basename(s.path)} mentions a path that doesn't exist: ${p}`) } catch {}
    }
    if (problems.length) bad++
    console.log(`${problems.length ? "✗" : "✓"} ${w.id}`)
    for (const p of problems) console.log(`    error: ${p}`)
    for (const p of warnings) console.log(dim(`    warn:  ${p}`))
  }
  if (bad) process.exit(1)
}

async function cmdInbox(sub, a, b, rest) {
  const rows = await capture.listInbox()
  const pickRow = (n) => {
    const r = /^\d+$/.test(n || "") ? rows[Number(n) - 1] : rows.find((r) => r.session?.startsWith(n || "\0"))
    if (!r) die(`No inbox row "${n}". Run \`ws inbox\` to see numbers.`)
    return r
  }
  if (!sub || sub === "ls") {
    if (!rows.length) return console.log("Inbox empty.")
    rows.forEach((r, i) => console.log(
      `${String(i + 1).padStart(3)}. ${String(r.ended || "").slice(0, 10)} ${(r.tool || "").padEnd(6)} ${bold(r.title || "(untitled)")}\n` +
      dim(`     ${r.cwd}  ·  ${r.user_turns ?? "?"} turns, ${(r.files_touched || []).length} files`) +
      (r.suggestions?.length ? `\n     → ${r.suggestions.join(", ")}` : ""),
    ))
    console.log(dim(`\nws inbox assign <n> <id> | new <n> <id> | ignore <n> [--cwd] | clear`))
  } else if (sub === "assign") {
    const r = pickRow(a)
    const id = need(b || r.suggestions?.[0], "<id>")
    console.log(`Linked to ${id}: ${store.tildify(await capture.assignInbox(r, id, rest.join(" ")))}`)
  } else if (sub === "new") {
    const r = pickRow(a)
    await store.createWorkstream(need(b, "<id>"), { title: opt.title || r.title || b, cwd: r.cwd, group: opt.group, prefix: opt.prefix, tool: r.tool })
    console.log(`Created ${b}; ` + `linked: ${store.tildify(await capture.assignInbox(r, b))}`)
  } else if (sub === "ignore") {
    const r = pickRow(a)
    await capture.ignoreInbox(r, { cwd: opt.cwd !== undefined })
    console.log(`Ignored${opt.cwd !== undefined ? ` (and all future sessions in ${r.cwd})` : ""}.`)
  } else if (sub === "clear") {
    for (const r of rows) await capture.ignoreInbox(r)
    console.log(`Cleared ${rows.length}.`)
  } else die(`unknown: ws inbox ${sub}`)
}

async function cmdMirror(id, file) {
  need(id, "<id>")
  if (file) await store.updateWorkstream(id, { mirror: store.tildify(path.resolve(store.expand(file))) })
  const r = await store.syncMirror(id, { force: opt.force || !!file, init: !!file })
  const where = r.file ? store.tildify(r.file) : ""
  const msg = {
    none: `${id} has no mirror. Opt in with: ws mirror ${id} <path/to/STATUS.md>`,
    written: `Updated the open-items block in ${where}`,
    unchanged: `Block in ${where} is already current`,
    deferred: `${where} changed in the last 2 minutes, so it was left alone. Re-run with --force, or it syncs on the next item change.`,
    "missing-block": `No ws block in ${where}. Re-run with the file argument to add one at the end.`,
  }[r.action]
  console.log(msg)
}

async function cmdEval() {
  const r = await runEval({ runs: Number(opt.runs || 3), only: opt.case, log: (m) => console.log(dim(m)) })
  const pct = (x) => `${Math.round(x * 100)}%`
  console.log(`\n${bold("Per case")}`)
  for (const c of r.perCase) console.log(`  ${c.name.padEnd(28)} precision ${pct(c.verified_precision).padStart(4)}  recall ${pct(c.recall_any).padStart(4)}  false ${c.false_verified}`)
  const m = r.metrics
  console.log(`\n${bold("Overall")}  verified precision ${pct(m.verified_precision)} · recall (verified + unverified) ${pct(m.recall_any)} · verified recall ${pct(m.recall_verified)} · false verified closes ${m.false_verified}`)
  console.log(dim(`report: ${store.tildify(r.file)}`))
  if (r.fails.length) { console.error(`\nBelow floor: ${r.fails.join("; ")}`); process.exit(1) }
  console.log("Floors met.")
}

async function cmdArchive(id, un) {
  if (un) { const r = await store.unarchiveWorkstream(need(id, "<id>")); return console.log(`Unarchived ${id} (status: ${r.to})`) }
  const r = await store.archiveWorkstream(need(id, "<id>"))
  console.log(`Archived ${id} (was ${r.from}). Hidden from the board, picker and session matching; \`ws unarchive ${id}\` brings it back.`)
}

async function cmdDelete(id) {
  const w = await store.getWorkstream(need(id, "<id>"))
  if (!opt.yes) {
    if (!process.stdin.isTTY) die(`Refusing to delete ${id} without --yes`)
    const a = await ask(`Move "${w.title}" (${id}) to the trash? It can be restored with ws trash restore. [y/N] `)
    if (!/^y/i.test(a)) die("Not deleted.")
  }
  const r = await store.deleteWorkstream(id)
  console.log(`Moved ${id} to the trash (${r.trash}). Restore: ws trash restore ${r.trash}`)
}

async function cmdTrash(sub, name) {
  if (!sub || sub === "ls") {
    const t = await store.listTrash()
    if (!t.length) return console.log("Trash is empty.")
    for (const x of t) console.log(`${bold(x.name)}  ${x.title}${x.deleted_at ? dim(`  deleted ${x.deleted_at.slice(0, 10)}`) : ""}`)
    return console.log(dim(`\nws trash restore <name> | ws trash empty [<name>] --yes`))
  }
  if (sub === "restore") { const r = await store.restoreWorkstream(need(name, "<name>")); return console.log(`Restored ${r.id}`) }
  if (sub === "empty") {
    if (!opt.yes) die("This permanently deletes trashed workstreams. Re-run with --yes.")
    return console.log(`Permanently deleted ${await store.emptyTrash(name)} trashed workstream(s).`)
  }
  die(`unknown: ws trash ${sub}`)
}

async function cmdStale() {
  const days = Number(opt.days || 7)
  const cutoff = Date.now() - days * 864e5
  const rows = (await store.listWorkstreams()).filter((w) => ["active", "waiting"].includes(w.status) && w.lastActivity < cutoff)
  if (!rows.length) return console.log(`Nothing active or waiting has gone ${days}+ days without a session.`)
  for (const w of rows.sort((a, b) => a.lastActivity - b.lastActivity)) {
    console.log(`${bold(w.id.padEnd(26))} ${ago(w.lastActivity).padStart(4)} since last session  ${w.status}${w.waiting_on ? ` (waiting on ${w.waiting_on})` : ""}`)
  }
  console.log(dim(`\nNudge: ws go <id> · park it: ws set <id> status=parked`))
}

async function cmdSummarize(id) {
  if (opt.requeue) return console.log(`Requeued ${await summarize.requeueFailed()} failed job(s). Run: ws summarize --drain`)
  if (opt.drain) {
    const r = await summarize.drain({ log: opt.quiet ? () => {} : (m) => console.log(m) })
    if (!opt.quiet) console.log(r.note || `${r.done} done, ${r.failed} failed`)
    return
  }
  const w = await store.getWorkstream(need(id, "<id>"))
  const l = w.logs.find((x) => x.session && x.session.startsWith(need(opt.session, "--session")))
  if (!l) die(`No logged session ${opt.session} in ${id}`)
  if (!(await summarize.llmConfig())) die(`No model configured. Add {"llm":{"url":"http://host:port/v1"}} to ${store.tildify(path.join(store.ROOT, "config.json"))}`)
  await summarize.enqueue({ ws: id, session: l.session, tool: l.tool, transcript: l.transcript, log: l.file })
  console.log(`Queued. Run: ws summarize --drain`)
}

async function cmdReview(sub, n) {
  const props = await summarize.listProposals()
  const pick = () => props[Number(need(n, "<n>")) - 1] || die(`No proposal ${n}. Run \`ws review\`.`)
  if (!sub || sub === "ls") {
    if (!props.length) return console.log("Nothing to review.")
    props.forEach((p, i) => console.log(
      `${String(i + 1).padStart(3)}. ${bold(p.ws)} ${dim(`${String(p.created).slice(0, 10)} ${p.tool} ${store.sessionTag(p.session)}`)}\n` +
      `     ${p.summary.split("\n")[0]}\n` +
      (p.close || []).map((c) => `     close ${c.id}  ${dim(c.evidence)}`).join("\n") + ((p.close || []).length ? "\n" : "") +
      (p.add || []).map((a) => `     add   ${a.text}${a.waiting ? dim(`  @${a.waiting}`) : ""}`).join("\n") + ((p.add || []).length ? "\n" : "") +
      (p.unverified || []).map((u) => dim(`     unverified close ${u.id} (${u.failed}): ${u.evidence}  → add --confirm ${u.id}`)).join("\n") + ((p.unverified || []).length ? "\n" : "") +
      (p.decide || []).map((d, k) => d.unverified
        ? dim(`     unverified decision [${k}] (${d.unverified}): ${d.text}  → add --confirm-decision ${k}`)
        : `     decide ${d.text}${d.why ? dim(`  — ${d.why}`) : ""}`).join("\n"),
    ))
    console.log(dim(`\nws review accept <n> [--no-close] [--no-add] [--no-summary] | reject <n>`))
  } else if (sub === "show") {
    const p = pick(); console.log(JSON.stringify({ ...p, file: store.tildify(p.file) }, null, 2))
  } else if (sub === "accept") {
    const p = pick()
    const confirm = opt.confirm ? String(opt.confirm).split(",").map((x) => x.trim().toUpperCase()) : []
    const confirmDecisions = opt["confirm-decision"] ? String(opt["confirm-decision"]).split(",").map((x) => Number(x.trim())) : []
    const r = await summarize.acceptProposal(p, { close: !opt["no-close"], add: !opt["no-add"], summary: !opt["no-summary"], unverified: confirm, decide: !opt["no-decide"], confirmDecisions })
    console.log(`Applied to ${p.ws}: closed ${r.closed.join(", ") || "none"}; added ${r.added.join(", ") || "none"}; decided ${r.decided.join(", ") || "none"}` + (r.skipped.length ? `\nSkipped: ${r.skipped.join("; ")}` : ""))
  } else if (sub === "reject") {
    const p = pick(); await summarize.rejectProposal(p); console.log(`Rejected proposal for ${p.ws}.`)
  } else die(`unknown: ws review ${sub}`)
}

// ------------------------------------------------------------------ board service
// Overridable in $WS_ROOT/config.json: {"board": {"port": 3311, "label": "ws.board"}}
// Validated config; loadConfig never throws, so a broken config.json can't break `ws hook`.
const CONFIG = await loadConfig()
const envPort = Number(process.env.WS_BOARD_PORT)
const BOARD_LABEL = (process.env.WS_BOARD_LABEL && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(process.env.WS_BOARD_LABEL) ? process.env.WS_BOARD_LABEL : null) || CONFIG.board.label || "ws.board"
const BOARD_PORT = String(Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : CONFIG.board.port || 3311)
const BOARD_URL = `http://127.0.0.1:${BOARD_PORT}`
const BOARD_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${BOARD_LABEL}.plist`)
const BOARD_LOG = path.join(os.homedir(), "Library", "Logs", "ws-board.log")
const BOARD_DIST = ".next-prod"
const boardApp = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const gui = () => `gui/${process.getuid()}`

async function boardUp(timeoutMs = 0) {
  const until = Date.now() + timeoutMs
  for (;;) {
    try { if ((await fetch(`${BOARD_URL}/api/ws`, { signal: AbortSignal.timeout(2000) })).ok) return true } catch {}
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 500))
  }
}

function stableNode() {
  // The Homebrew symlink survives Node upgrades; the resolved Cellar path doesn't.
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) { try { if (spawnSync(p, ["-v"]).status === 0) return p } catch {} }
  return process.execPath
}

function buildBoard() {
  console.log("Building the board (production)…")
  const r = spawnSync("npx", ["next", "build"], { cwd: boardApp(), stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, NEXT_DIST_DIR: BOARD_DIST } })
  if (r.status !== 0) die("Build failed; the service was not changed.")
}

// bootout returns before launchd has finished; wait until the job is really gone.
async function unloadBoard() {
  const loaded = () => spawnSync("launchctl", ["print", `${gui()}/${BOARD_LABEL}`]).status === 0
  if (!loaded()) return
  spawnSync("launchctl", ["bootout", `${gui()}/${BOARD_LABEL}`])
  for (let i = 0; i < 20 && loaded(); i++) await new Promise((ok) => setTimeout(ok, 500))
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

async function cmdBoard() {
  const app = boardApp()
  const installed = process.platform === "darwin" && await fs.access(BOARD_PLIST).then(() => true, () => false)
  if ((opt.install || opt.rebuild) && process.platform !== "darwin") {
    die("The background service uses launchd, so it is macOS-only for now. Use `ws board` (a dev server in this terminal).\nA systemd user unit for Linux would be a welcome contribution: see CONTRIBUTING.md.")
  }

  if (opt.install) {
    buildBoard()
    const node = stableNode()
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${BOARD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string>
    <string>${xml(path.join(app, "node_modules", "next", "dist", "bin", "next"))}</string>
    <string>start</string><string>-H</string><string>127.0.0.1</string><string>-p</string><string>${BOARD_PORT}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(app)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>NEXT_DIST_DIR</key><string>${BOARD_DIST}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>${xml(path.join(os.homedir(), ".local", "bin"))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>WS_ROOT</key><string>${xml(store.ROOT)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>${xml(BOARD_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(BOARD_LOG)}</string>
</dict>
</plist>
`
    await unloadBoard()
    await fs.mkdir(path.dirname(BOARD_PLIST), { recursive: true })
    await fs.writeFile(BOARD_PLIST, plist)
    // launchd can still be tearing down the old job; retry the load briefly.
    let r
    for (let i = 0; i < 10; i++) {
      r = spawnSync("launchctl", ["bootstrap", gui(), BOARD_PLIST], { encoding: "utf-8" })
      if (r.status === 0) break
      await new Promise((ok) => setTimeout(ok, 1000))
    }
    if (r.status !== 0) die(`launchctl bootstrap failed: ${r.stderr || r.status}`)
    if (!(await boardUp(20_000))) die(`Service installed but not answering yet; check ${store.tildify(BOARD_LOG)}`)
    console.log(`Board service running at ${BOARD_URL} (starts at login; log: ${store.tildify(BOARD_LOG)})`)
    openUrl(BOARD_URL)
    return
  }

  if (opt.uninstall) {
    if (!installed) return console.log("Board service isn't installed.")
    await unloadBoard()
    await fs.rm(BOARD_PLIST, { force: true })
    return console.log("Board service removed. `ws board --dev` still runs it on demand.")
  }

  if (opt.rebuild) {
    if (!installed) die("Board service isn't installed (ws board --install).")
    buildBoard()
    spawnSync("launchctl", ["kickstart", "-k", `${gui()}/${BOARD_LABEL}`])
    if (!(await boardUp(20_000))) die(`Rebuilt, but the service isn't answering; check ${store.tildify(BOARD_LOG)}`)
    return console.log(`Rebuilt and restarted: ${BOARD_URL}`)
  }

  if (opt.status) {
    const up = await boardUp()
    const p = spawnSync("launchctl", ["print", `${gui()}/${BOARD_LABEL}`], { encoding: "utf-8" })
    const pid = p.stdout?.match(/\bpid = (\d+)/)?.[1]
    console.log(`service: ${installed ? "installed" : "not installed"}${pid ? ` (pid ${pid})` : ""}\nanswering: ${up ? `yes, ${BOARD_URL}` : "no"}\nlog: ${store.tildify(BOARD_LOG)}`)
    return
  }

  if (installed && !opt.dev) {
    if (!(await boardUp())) {
      spawnSync("launchctl", ["kickstart", `${gui()}/${BOARD_LABEL}`])
      if (!(await boardUp(15_000))) die(`The board service isn't answering; check ${store.tildify(BOARD_LOG)} or run ws board --rebuild`)
    }
    console.log(BOARD_URL)
    openUrl(BOARD_URL)
    return
  }

  // No service (or --dev): a dev server in this terminal.
  const port = String(opt.port || BOARD_PORT)
  if (!opt.dev) console.log(dim("Tip: ws board --install keeps it running in the background."))
  console.log(`Board: http://127.0.0.1:${port}  (data: ${store.tildify(store.ROOT)}; Ctrl-C to stop)`)
  setTimeout(() => openUrl(`http://127.0.0.1:${port}`), 4000).unref?.()
  const r = spawnSync("npx", ["next", "dev", "-H", "127.0.0.1", "-p", port], { cwd: app, stdio: "inherit", env: process.env })
  process.exit(r.status ?? 0)
}

async function cmdSetup() {
  // Loaded only here, so nothing in setup can affect hooks or other commands.
  const { runSetup, runUninstall, detectTools } = await import("../lib/setup.mjs")
  const tools = await detectTools({ claude: opt.claude, codex: opt.codex })
  if (opt.uninstall) {
    const { problems } = await runUninstall({ tools, dryRun: opt["dry-run"] })
    if (problems.length) die(`\nNot everything was removed:\n  ${problems.join("\n  ")}`)
    return
  }
  if (!tools.length && !opt["no-hooks"]) console.log("Neither Claude Code nor Codex was found; setting up the data folder and CLI only. Re-run with --claude or --codex later.")
  const { problems } = await runSetup({ tools, link: !opt["no-link"], hooks: !opt["no-hooks"], mcp: !opt["no-mcp"], dryRun: opt["dry-run"] })
  if (problems.length) die(`\nSetup finished with problems:\n  ${problems.join("\n  ")}`)
  if (!opt["dry-run"]) console.log(`\nNext: ws new <id> --title "…" --cwd <project folder>, then start a session in that folder. \`ws board\` opens the board.`)
}

async function cmdHook(tool, event) {
  // Hooks must never break a session: swallow everything, log errors to a file.
  try {
    let raw = ""
    for await (const chunk of process.stdin) raw += chunk
    const p = raw.trim() ? JSON.parse(raw) : {}
    const ctx = { tool, session_id: p.session_id, transcript_path: p.transcript_path, cwd: p.cwd, reason: p.reason, wsId: process.env.WS_ID }
    if (event === "start") {
      // Structured output: Codex parses stdout that starts with "[" as JSON, and both tools accept this form.
      // Retry any queued summaries while we're here (detached; never blocks startup).
      try { if (process.env.WS_NO_SPAWN !== "1" && (await summarize.listQueue()).length && (await summarize.llmConfig())) summarize.spawnDrain() } catch {}
      const note = await capture.startContext(ctx)
      if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } }) + "\n")
    } else if (event === "end") {
      const r = await capture.captureSession(ctx)
      if (process.env.WS_DEBUG) console.error(JSON.stringify(r))
    }
  } catch (e) {
    try { await fs.appendFile(path.join(store.ROOT, "hook-errors.log"), `${new Date().toISOString()} ${tool} ${event}: ${e.stack || e}\n`) } catch {}
  }
  process.exit(0)
}

// Options that only mean something to one command; anything else is an error there,
// so `ws setup --unistall` (typo) or `ws board --dry-run` doesn't silently do the default.
const ONLY = {
  setup: ["claude", "codex", "dry-run", "no-link", "no-hooks", "no-mcp", "uninstall", "help"],
  board: ["install", "uninstall", "rebuild", "status", "dev", "port", "no-open", "help"],
}

try {
  const [cmd, ...rest] = args
  if (store.ROOT_PROBLEM) {
    if (cmd === "hook") process.exit(0) // hooks never fail a session
    die(store.ROOT_PROBLEM)
  }
  if (ONLY[cmd]) {
    const bad = Object.keys(opt).filter((k) => !ONLY[cmd].includes(k))
    if (bad.length) die(`ws ${cmd}: unknown option ${bad.map((b) => `--${b}`).join(", ")}\n\n${HELP}`)
  }
  if (cmd !== "hook" && CONFIG.problems.length) console.error(dim(`config.json: ${CONFIG.problems.join("; ")}`))
  if (opt.help || cmd === "help") console.log(HELP)
  else if (!cmd) await cmdPick()
  else if (cmd === "setup") await cmdSetup()
  else if (cmd === "ls") await cmdLs()
  else if (cmd === "show") await cmdShow(need(rest[0], "<id>"))
  else if (cmd === "prompt") await cmdPrompt(need(rest[0], "<id>"))
  else if (cmd === "go") await cmdGo(need(rest[0], "<id>"))
  else if (cmd === "new") await cmdNew(rest[0])
  else if (cmd === "set") await cmdSet(rest[0], rest.slice(1))
  else if (cmd === "item") await cmdItem(rest[0], rest[1], rest.slice(2))
  else if (cmd === "decide") await cmdDecide(rest[0], rest.slice(1))
  else if (cmd === "decisions") await cmdDecisions(rest[0])
  else if (cmd === "log") await cmdLog(rest[0], rest.slice(1))
  else if (cmd === "doctor") await cmdDoctor(rest[0])
  else if (cmd === "board") await cmdBoard()
  else if (cmd === "review") await cmdReview(rest[0], rest[1])
  else if (cmd === "summarize") await cmdSummarize(rest[0])
  else if (cmd === "eval") await cmdEval()
  else if (cmd === "archive") await cmdArchive(rest[0], false)
  else if (cmd === "unarchive") await cmdArchive(rest[0], true)
  else if (cmd === "delete") await cmdDelete(rest[0])
  else if (cmd === "trash") await cmdTrash(rest[0], rest[1])
  else if (cmd === "stale") await cmdStale()
  else if (cmd === "mirror") await cmdMirror(rest[0], rest[1])
  else if (cmd === "inbox") await cmdInbox(rest[0], rest[1], rest[2], rest.slice(3))
  else if (cmd === "hook") await cmdHook(need(rest[0], "claude|codex"), need(rest[1], "start|end"))
  else die(`unknown command "${cmd}"\n\n${HELP}`)
} catch (e) {
  die(`ws: ${e.message}`)
}
