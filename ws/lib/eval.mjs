// Summarizer evaluation on real sessions.
// Cases live in $WS_ROOT/eval/cases/*.json (private data, never in this repo):
//   { "name", "tool": "claude"|"codex", "transcript": "eval/transcripts/x.jsonl" (relative to $WS_ROOT, or absolute),
//     "title", "open": [{ "id", "text" }], "decided": [{ "id", "text" }],
//     "expect": { "close": ["AB-1"] } }
// Any proposed close not in expect.close is a false close. Floors: $WS_ROOT/eval/floors.json.
// Measurement never mutates workstream data; it only writes a report under eval/reports/.
import { promises as fs } from "node:fs"
import path from "node:path"
import * as store from "./store.mjs"
import * as summarize from "./summarize.mjs"

export const EVAL_DIR = path.join(store.ROOT, "eval")
export const DEFAULT_FLOORS = { verified_precision: 1.0, recall_any: 0.5, max_false_verified: 0 }

export async function loadCases(only) {
  const dir = path.join(EVAL_DIR, "cases")
  let files = []
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort() } catch { return [] }
  const cases = []
  for (const f of files) {
    let c
    try {
      c = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8"))
      if (!c || typeof c !== "object" || typeof c.transcript !== "string") throw new Error("needs a \"transcript\" path")
    } catch (e) { throw new Error(`eval case ${f}: ${e.message}`) }
    c.name ||= f.replace(/\.json$/, "")
    if (only && !c.name.includes(only)) continue
    c.transcriptPath = path.isAbsolute(store.expand(c.transcript)) ? store.expand(c.transcript) : path.join(store.ROOT, c.transcript)
    cases.push(c)
  }
  return cases
}

export async function loadFloors() {
  try { return { ...DEFAULT_FLOORS, ...JSON.parse(await fs.readFile(path.join(EVAL_DIR, "floors.json"), "utf-8")) } } catch { return { ...DEFAULT_FLOORS } }
}

// Pure scoring of one validated proposal against a case.
export function scoreRun(c, proposal) {
  const expect = new Set((c.expect?.close || []).map((x) => x.toUpperCase()))
  // Each ID counts once: repeating a correct close mustn't make up for a missed one.
  const v = [...new Set(proposal.close.map((x) => x.id.toUpperCase()))]
  const u = [...new Set(proposal.unverified.map((x) => x.id.toUpperCase()))].filter((id) => !v.includes(id))
  return {
    tpVerified: v.filter((id) => expect.has(id)).length,
    fpVerified: v.filter((id) => !expect.has(id)),
    tpUnverified: u.filter((id) => expect.has(id) && !v.includes(id)).length,
    fpUnverified: u.filter((id) => !expect.has(id)).length,
    expected: expect.size,
  }
}

export function aggregate(rows) {
  const s = rows.reduce((a, r) => ({
    tpV: a.tpV + r.tpVerified, fpV: a.fpV + r.fpVerified.length, tpU: a.tpU + r.tpUnverified, fpU: a.fpU + r.fpUnverified, exp: a.exp + r.expected,
  }), { tpV: 0, fpV: 0, tpU: 0, fpU: 0, exp: 0 })
  return {
    verified_precision: s.tpV + s.fpV ? s.tpV / (s.tpV + s.fpV) : 1,
    recall_verified: s.exp ? s.tpV / s.exp : 1,
    recall_any: s.exp ? (s.tpV + s.tpU) / s.exp : 1,
    false_verified: s.fpV,
    false_unverified: s.fpU,
  }
}

export function checkFloors(m, floors) {
  const fails = []
  if (m.verified_precision < floors.verified_precision) fails.push(`verified precision ${m.verified_precision.toFixed(2)} < ${floors.verified_precision}`)
  if (m.recall_any < floors.recall_any) fails.push(`recall ${m.recall_any.toFixed(2)} < ${floors.recall_any}`)
  if (m.false_verified > floors.max_false_verified) fails.push(`${m.false_verified} false verified closes > ${floors.max_false_verified}`)
  return fails
}

export async function runEval({ runs = 3, only, log = () => {} } = {}) {
  runs = Number(runs)
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a whole number of at least 1")
  const cfg = await summarize.llmConfig()
  if (!cfg) throw new Error("No model configured (llm.url in config.json)")
  if (!(await summarize.endpointUp(cfg))) throw new Error(`Model endpoint unreachable: ${cfg.url}`)
  const cases = await loadCases(only)
  if (!cases.length) throw new Error(`No eval cases in ${store.tildify(path.join(EVAL_DIR, "cases"))}`)
  const rows = []
  const perCase = []
  let errors = 0
  for (const c of cases) {
    const digest = await summarize.digestTranscript(c.tool || "claude", c.transcriptPath)
    const open = c.open.map((i) => ({ ...i, done: false }))
    const caseRows = []
    for (let r = 0; r < runs; r++) {
      try {
        const { content } = await summarize.callModel(cfg, { id: c.name, title: c.title || c.name }, open, digest, c.decided || [])
        const p = summarize.validateProposal(content, open, digest, c.decided || [])
        const s = scoreRun(c, p)
        caseRows.push(s)
        log(`${c.name} run ${r + 1}: verified ${p.close.map((x) => x.id).join(",") || "-"} | unverified ${p.unverified.map((x) => x.id).join(",") || "-"}${s.fpVerified.length ? `  FALSE: ${s.fpVerified.join(",")}` : ""}`)
      } catch (e) {
        errors++
        log(`${c.name} run ${r + 1}: error ${e.message}`)
      }
    }
    rows.push(...caseRows)
    perCase.push({ name: c.name, runs: caseRows.length, ...aggregate(caseRows) })
  }
  const metrics = aggregate(rows)
  const floors = await loadFloors()
  const fails = checkFloors(metrics, floors)
  // A run that errored scores nothing, and an empty score is "perfect": count errors as failures.
  if (errors) fails.push(`${errors} of ${cases.length * runs} runs failed (model or validation error)`)
  if (!rows.length) fails.push("no run produced a score")
  const report = { at: new Date().toISOString(), model: cfg.model || "(from /models)", runs, errors, metrics, floors, fails, perCase }
  await fs.mkdir(path.join(EVAL_DIR, "reports"), { recursive: true })
  const file = path.join(EVAL_DIR, "reports", `${report.at.replace(/[:.]/g, "-")}.json`)
  await fs.writeFile(file, JSON.stringify(report, null, 2))
  return { ...report, file }
}
