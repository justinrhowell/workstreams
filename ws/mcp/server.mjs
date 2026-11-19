#!/usr/bin/env node
// ws MCP server (stdio). Reads and writes the same files as the ws CLI, so Claude
// Code and Codex share one state. Register with:
//   claude mcp add --scope user ws -- node /abs/path/ws/mcp/server.mjs
//   codex mcp add ws -- node /abs/path/ws/mcp/server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as store from "../lib/store.mjs"
import { platformProblem } from "../lib/platform.mjs"
import { compose } from "../lib/compose.mjs"
import * as capture from "../lib/capture.mjs"

const text = (value) => ({ content: [{ type: "text", text: value }] })
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true })
const safe = (fn) => async (args) => { try { return await fn(args) } catch (e) { return fail(e) } }
const id = z.string().describe("Workstream id, e.g. acme-site (see ws_list)")

if (platformProblem() || store.ROOT_PROBLEM) {
  console.error(`ws MCP server: ${platformProblem() || store.ROOT_PROBLEM}`)
  process.exit(1)
}

const server = new McpServer({ name: "ws", version: "0.1.0" })

server.registerTool(
  "ws_list",
  {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    title: "List workstreams",
    description:
      "List workstreams (ongoing pieces of work that span many sessions) with status, open-item count and what each is waiting on. Call this when the user refers to ongoing work by name, or to find which workstream the current task belongs to.",
    inputSchema: { all: z.boolean().optional().describe("Include parked and done workstreams") },
  },
  safe(async ({ all }) => {
    const list = (await store.listWorkstreams()).filter((w) => all || ["active", "waiting"].includes(w.status))
    if (!list.length) return text(`No workstreams. Data: ${store.tildify(store.ROOT)}`)
    const rows = []
    for (const w of list) {
      const open = (await store.readOpen(w.id)).items.filter((i) => !i.done).length
      rows.push(`- ${w.id} [${w.status}] ${w.title}: ${open} open${w.waiting_on ? `; waiting on ${w.waiting_on}` : ""}${w.cwd ? `; cwd ${store.tildify(w.cwd)}` : ""}`)
    }
    return text(rows.join("\n"))
  }),
)

server.registerTool(
  "ws_show",
  {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    title: "Show a workstream",
    description: "Status, brief, open items (with IDs) and the last few session summaries for one workstream.",
    inputSchema: { id },
  },
  safe(async ({ id }) => {
    const w = await store.getWorkstream(id)
    const { items } = await store.readOpen(id)
    const open = items.filter((i) => !i.done)
    const closed = items.filter((i) => i.done).slice(-5)
    const decided = (await store.readDecisions(id)).decisions.filter((d) => d.active)
    return text([
      `${w.title} [${w.status}]${w.waiting_on ? `, waiting on ${w.waiting_on}` : ""}`,
      w.cwd ? `cwd: ${store.tildify(w.cwd)}` : null,
      w.brief || null,
      `Open items:\n${open.map((i) => `- ${i.id} ${i.text}${i.waiting ? ` (waiting on ${i.waiting})` : ""}`).join("\n") || "(none)"}`,
      decided.length ? `Decided:\n${decided.map((d) => `- ${d.id} ${d.text}${d.why ? ` (why: ${d.why})` : ""}${d.rejected ? ` (rejected: ${d.rejected})` : ""}`).join("\n")}` : null,
      closed.length ? `Recently closed:\n${closed.map((i) => `- ${i.id} ${i.text} (closed ${i.closed})`).join("\n")}` : null,
      w.logs.length ? `Recent sessions:\n${w.logs.slice(-5).map((l) => `- ${String(l.ended || "").slice(0, 10)} ${l.tool || ""}: ${l.summary.split("\n")[0]}`).join("\n")}` : null,
      `Sources: ${w.sources.map((s) => store.tildify(s.path)).join(", ") || "(none)"}`,
    ].filter(Boolean).join("\n\n"))
  }),
)

server.registerTool(
  "ws_compose",
  {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    title: "Compose a resume prompt",
    description:
      "Build the full resume prompt for a workstream: files to read first, the procedure, open items and the last session. Use it to pick up a workstream from scratch, or to hand it to another agent.",
    inputSchema: {
      id,
      tool: z.enum(["claude", "codex"]).optional().describe("Target tool; codex inlines Claude memory notes"),
      inline: z.boolean().optional().describe("Inline every source file's content"),
    },
  },
  safe(async ({ id, tool, inline }) => text((await compose(id, { tool, inline })).text)),
)

server.registerTool(
  "ws_item_add",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    title: "Add an open item",
    description: "Record a new open item (something still to do, or waiting on someone). Returns its stable ID.",
    inputSchema: {
      id,
      text: z.string().describe("One line: what is open, specific enough to act on later"),
      waiting: z.string().optional().describe("Who it's waiting on, if anyone"),
    },
  },
  safe(async ({ id, text: t, waiting }) => {
    const i = await store.addItem(id, t, { waiting })
    return text(`Added ${i.id}: ${i.text}`)
  }),
)

server.registerTool(
  "ws_item_close",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    title: "Close open items",
    description: "Mark open items done by ID. Only close what was actually finished and verified.",
    inputSchema: {
      id,
      items: z.array(z.string()).min(1).describe("Item IDs, e.g. [\"BA-3\"]"),
      note: z.string().optional().describe("Short note on how it was resolved"),
    },
  },
  safe(async ({ id, items, note }) => {
    const out = []
    for (const it of items) out.push(await store.closeItem(id, it, { note }))
    return text(out.map((i) => `Closed ${i.id}: ${i.text}`).join("\n"))
  }),
)

server.registerTool(
  "ws_item_edit",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    title: "Edit an open item",
    description: "Reword an open item or change who it's waiting on (empty string clears it).",
    inputSchema: { id, item: z.string(), text: z.string().optional(), waiting: z.string().optional() },
  },
  safe(async ({ id, item, text: t, waiting }) => {
    const i = await store.editItem(id, item, { text: t, waiting })
    return text(`Updated ${i.id}: ${i.text}${i.waiting ? ` (waiting on ${i.waiting})` : ""}`)
  }),
)

server.registerTool(
  "ws_decide",
  {
    title: "Record a decision",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description:
      "Record a settled choice for a workstream, with why and the alternatives rejected, so later sessions don't reopen it. To change a decision, record the new one with supersedes; decisions are never edited in place. Only record what the user actually decided or confirmed.",
    inputSchema: {
      id,
      text: z.string().describe("The decision, one line"),
      why: z.string().optional().describe("The reason"),
      rejected: z.array(z.string()).optional().describe("Alternatives rejected, each with a short reason"),
      evidence: z.string().optional().describe("Where it was decided: file, message, PR"),
      supersedes: z.string().optional().describe("ID of the decision this replaces, e.g. AB-D2"),
    },
  },
  safe(async ({ id, text: t, why, rejected, evidence, supersedes }) => {
    const r = await store.decide(id, t, { why, rejected, evidence, supersedes })
    return text(`Decided ${r.decision.id}: ${r.decision.text}${r.superseded ? ` (supersedes ${r.superseded})` : ""}`)
  }),
)

server.registerTool(
  "ws_log",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    title: "Log this session",
    description:
      "Write the one-paragraph summary of what this session did for a workstream. Call it once, near the end. The session-end hook attaches the session ID automatically.",
    inputSchema: {
      id,
      summary: z.string().describe("What changed, in 1–3 sentences; first sentence is shown in future resume prompts"),
      tool: z.enum(["claude", "codex"]).optional(),
      closed: z.array(z.string()).optional().describe("Item IDs closed this session"),
      added: z.array(z.string()).optional().describe("Item IDs added this session"),
    },
  },
  safe(async ({ id, summary, tool, closed, added }) => {
    const file = await store.appendLog(id, { summary, tool, closed, added, cwd: store.tildify(process.cwd()), via: "agent" })
    return text(`Logged ${store.tildify(file)}`)
  }),
)

server.registerTool(
  "ws_set_status",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    title: "Set workstream status",
    description: "Change status (active, waiting, parked, done) and/or what it's waiting on.",
    inputSchema: {
      id,
      status: z.enum(["active", "waiting", "parked", "done"]).optional(),
      waiting_on: z.string().optional().describe("Who or what it's waiting on; empty string clears"),
    },
  },
  safe(async ({ id, status, waiting_on }) => {
    const patch = {}
    if (status) patch.status = status
    if (waiting_on !== undefined) patch.waiting_on = waiting_on
    if (!Object.keys(patch).length) throw new Error("Nothing to change")
    await store.updateWorkstream(id, patch)
    return text(`Updated ${id}: ${Object.entries(patch).map(([k, v]) => `${k}=${v || "(cleared)"}`).join(", ")}`)
  }),
)

server.registerTool(
  "ws_inbox",
  {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    title: "List unassigned sessions",
    description: "Recent sessions that ended outside any workstream, with suggested workstreams. Read-only: assigning is the user's call (ws inbox assign).",
    inputSchema: {},
  },
  safe(async () => {
    const rows = await capture.listInbox()
    if (!rows.length) return text("Inbox empty.")
    return text(rows.map((r, i) =>
      `${i + 1}. ${String(r.ended || "").slice(0, 10)} ${r.tool} "${r.title || "untitled"}" in ${r.cwd}` +
      (r.suggestions?.length ? ` → ${r.suggestions.join(", ")}` : "")).join("\n"))
  }),
)

await server.connect(new StdioServerTransport())
