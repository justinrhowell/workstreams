// Server-side bridge to ws/lib. The board reads and writes only through these
// functions so the open.md lock, ID allocation and mirror sync always apply.
import * as store from "@/ws/lib/store.mjs"
import * as capture from "@/ws/lib/capture.mjs"
import * as summarize from "@/ws/lib/summarize.mjs"
import { compose } from "@/ws/lib/compose.mjs"

export const STALE_DAYS = 7

export type Item = { id: string; done: boolean; text: string; waiting: string | null; closed: string | null }

const day = (v: unknown) => String(v ?? "").slice(0, 10)

export async function boardData() {
  const [list, proposals, inbox, queue] = await Promise.all([
    store.listWorkstreams(),
    summarize.listProposals(),
    capture.listInbox(),
    summarize.listQueue(),
  ])
  const workstreams = await Promise.all(
    list.map(async (w: any) => {
      const items: Item[] = (await store.readOpen(w.id)).items
      const open = items.filter((i) => !i.done)
      const lastReal = [...w.logs].reverse().find((l: any) => l.summary && !/^\(auto\)/.test(l.summary))
      return {
        id: w.id as string,
        title: w.title as string,
        group: (w.group as string) || "",
        status: w.status as string,
        waiting_on: (w.waiting_on as string) || "",
        cwd: w.cwd ? store.tildify(w.cwd) : "",
        lastActivity: w.lastActivity as number,
        sessions: w.logs.length as number,
        open: open.length,
        waitingItems: open.filter((i) => i.waiting).length,
        proposals: proposals.filter((p: any) => p.ws === w.id).length,
        lastSummary: lastReal ? { day: day(lastReal.ended), tool: lastReal.tool || "", text: String(lastReal.summary).split("\n")[0] } : null,
      }
    }),
  )
  const trash = await store.listTrash()
  return { workstreams, counts: { inbox: inbox.length, review: proposals.length, queued: queue.length, trash: trash.length }, root: store.tildify(store.ROOT), staleDays: STALE_DAYS }
}

export type Board = Awaited<ReturnType<typeof boardData>>

async function tryCompose(id: string, tool: string) {
  try {
    return { text: (await compose(id, { tool })).text as string, error: null }
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e) }
  }
}

export async function detailData(id: string) {
  const w: any = await store.getWorkstream(id)
  const items: Item[] = (await store.readOpen(id)).items
  const decisions = ((await store.readDecisions(id)).decisions as any[]).filter((d) => d.active).map((d) => ({
    id: d.id as string, text: d.text as string, why: (d.why || "") as string, rejected: (d.rejected || "") as string, date: (d.date || "") as string,
  }))
  const [claude, codex, proposals] = await Promise.all([tryCompose(id, "claude"), tryCompose(id, "codex"), summarize.listProposals(id)])
  return {
    id,
    title: w.title as string,
    group: (w.group as string) || "",
    status: w.status as string,
    waiting_on: (w.waiting_on as string) || "",
    cwd: w.cwd ? store.tildify(w.cwd) : "",
    brief: w.brief as string,
    procedure: (w.procedure as string) || null,
    mirror: w.data.mirror ? String(w.data.mirror) : null,
    sources: (w.sources as any[]).map((s) => ({ path: store.tildify(s.path) as string, role: (s.role || "") as string, section: (s.section || "") as string })),
    open: items.filter((i) => !i.done),
    decisions,
    closed: items.filter((i) => i.done).slice(-10).reverse(),
    logs: ([...w.logs] as any[]).reverse().slice(0, 25).map((l) => ({
      day: day(l.ended), tool: l.tool || "", title: l.title || "", summary: String(l.summary || ""), source: l.source || "",
      session: (l.session || "") as string, closed: (l.closed || []) as string[], added: (l.added || []) as string[], files: (l.files_touched || []).length as number,
    })),
    proposals: proposals.map(proposalView),
    prompt: { claude, codex },
    lastActivity: w.lastActivity as number,
  }
}

export type Detail = Awaited<ReturnType<typeof detailData>>

function proposalView(p: any) {
  return {
    ws: p.ws as string, session: p.session as string, tool: p.tool as string, created: day(p.created), model: p.model as string, summary: p.summary as string,
    close: (p.close || []) as { id: string; evidence: string }[], add: (p.add || []) as { text: string; waiting: string | null }[],
    unverified: (p.unverified || []) as { id: string; evidence: string; failed: string }[],
    decide: (p.decide || []) as { text: string; why: string | null; rejected: string[]; quote: string; unverified?: string }[],
  }
}

export async function reviewData() {
  return (await summarize.listProposals()).map(proposalView)
}

export async function inboxData() {
  return (await capture.listInbox()).map((r: any) => ({
    session: r.session as string, tool: r.tool as string, title: r.title || "", cwd: r.cwd || "", day: day(r.ended),
    turns: r.user_turns ?? null, files: (r.files_touched || []).length, suggestions: r.suggestions || [],
  }))
}

// ---------------------------------------------------------------- mutations
// Request bodies are checked here: ws/lib coerces values with String(), so a status
// outside the columns would hide a workstream from every view, and an object for
// waiting_on would be stored as YAML and break rendering.

const BOARD_STATUSES = ["active", "waiting", "parked", "done"] // archived: use archive/unarchive
const MAX_TEXT = 4000

function text(v: unknown, what: string): string
function text(v: unknown, what: string, optional: true): string | undefined
function text(v: unknown, what: string, optional = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined
    throw new Error(`${what} is required`)
  }
  if (typeof v !== "string") throw new Error(`${what} must be text`)
  if (v.length > MAX_TEXT) throw new Error(`${what} is too long (over ${MAX_TEXT} characters)`)
  return v
}

export async function workstreamAction(id: string, body: any) {
  switch (body?.action) {
    case "add":
      return store.addItem(id, text(body.text, "item text").trim(), { waiting: text(body.waiting, "waiting", true) })
    case "close":
      return store.closeItem(id, text(body.item, "item"), { note: text(body.note, "note", true) || "closed on the board" })
    case "edit":
      return store.editItem(id, text(body.item, "item"), {
        text: text(body.text, "item text", true),
        // null or "" clears who the item is waiting on; leaving it out keeps it
        waiting: body.waiting === null || body.waiting === "" ? null : text(body.waiting, "waiting", true),
      })
    case "status": {
      const patch: Record<string, string> = {}
      if (body.status !== undefined) {
        if (!BOARD_STATUSES.includes(body.status)) throw new Error(`status must be one of ${BOARD_STATUSES.join(", ")}`)
        patch.status = body.status
      }
      if (body.waiting_on !== undefined) patch.waiting_on = body.waiting_on === null ? "" : text(body.waiting_on, "waiting on", true) ?? ""
      if (!Object.keys(patch).length) throw new Error("nothing to change")
      return store.updateWorkstream(id, patch)
    }
    case "log":
      return store.appendLog(id, { summary: text(body.summary, "summary").trim(), tool: "board" })
    case "archive":
      return store.archiveWorkstream(id)
    case "unarchive":
      return store.unarchiveWorkstream(id)
    case "delete":
      return store.deleteWorkstream(id)
    default:
      throw new Error(`unknown action ${body?.action}`)
  }
}

export async function trashData() {
  return (await store.listTrash()) as { name: string; id: string; title: string; deleted_at: string }[]
}

export async function trashAction(body: any) {
  if (body?.action === "restore") return store.restoreWorkstream(text(body.name, "name"))
  throw new Error(`unknown action ${body?.action}`) // emptying the trash is CLI-only (ws trash empty --yes)
}

export async function inboxAction(body: any) {
  const rows = await capture.listInbox()
  const row = rows.find((r: any) => r.session === body?.session)
  if (!row) throw new Error("inbox row not found (already handled?)")
  if (body.action === "assign") return capture.assignInbox(row, text(body.id, "workstream"), text(body.summary, "summary", true))
  if (body.action === "ignore") return capture.ignoreInbox(row, { cwd: !!body.cwd })
  throw new Error(`unknown action ${body.action}`)
}

export async function reviewAction(body: any) {
  const p = (await summarize.listProposals(body?.ws)).find((x: any) => x.session === body?.session)
  if (!p) throw new Error("proposal not found (already handled?)")
  if (body.action === "accept") {
    const unverified = Array.isArray(body.unverified) ? body.unverified.map(String) : []
    const confirmDecisions = Array.isArray(body.confirmDecisions) ? body.confirmDecisions.map(Number) : []
    return summarize.acceptProposal(p, { close: body.close !== false, add: body.add !== false, summary: body.summary !== false, unverified, decide: body.decide !== false, confirmDecisions })
  }
  if (body.action === "reject") return summarize.rejectProposal(p)
  throw new Error(`unknown action ${body.action}`)
}
