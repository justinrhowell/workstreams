// Gemini CLI session files (~/.gemini/tmp/<project>/chats/session-*.jsonl).
//
// Current releases write an append-only log, one JSON record per line:
//   - a metadata record first: { sessionId, projectHash, startTime, kind, … }
//   - message records: { id, timestamp, type: "user"|"gemini"|"info"|…, content, toolCalls? }.
//     A message is re-appended in full under the same id every time it changes, so the
//     LAST copy of an id wins (counting lines would count a turn several times).
//   - { $set: {…} }        metadata updates (summary, kind; legacy `messages` checkpoint)
//   - { $rewindTo: id }    drop that message and everything after it
//   - { $patch: {…} }      content / tool-result updates, removeIds, orderIds
// Older releases wrote one JSON object: { sessionId, startTime, messages: [...] }.
// Both are reduced here to { meta, messages } so callers never see the log mechanics.

export function loadGeminiSession(text) {
  const src = String(text || "")
  // Legacy single-object file (a JSONL file never parses as one JSON value once it has 2+ lines).
  try {
    const whole = JSON.parse(src)
    if (whole && typeof whole === "object" && !Array.isArray(whole) && Array.isArray(whole.messages)) {
      const { messages, ...meta } = whole
      return { meta, messages: messages.filter(isMessage) }
    }
  } catch {}

  const meta = {}
  const byId = new Map() // insertion order = conversation order
  // A re-appended message keeps its first position and takes the newer content.
  const put = (m) => byId.set(m.id, m)
  for (const line of src.split("\n")) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (!r || typeof r !== "object") continue
    if (typeof r.$rewindTo === "string") {
      let cut = false
      for (const id of [...byId.keys()]) {
        if (id === r.$rewindTo) cut = true
        if (cut) byId.delete(id)
      }
      if (!cut) byId.clear() // Gemini clears everything when the target is unknown
    } else if (r.$set && typeof r.$set === "object") {
      const { messages, ...rest } = r.$set
      Object.assign(meta, rest)
      if (Array.isArray(messages)) { byId.clear(); for (const m of messages) if (isMessage(m)) put(m) }
    } else if (r.$patch && typeof r.$patch === "object") {
      const p = r.$patch
      if (typeof p.id === "string") patch(byId, p)
      if (Array.isArray(p.updates)) for (const u of p.updates) if (u && typeof u.id === "string") patch(byId, u)
      if (Array.isArray(p.removeIds)) for (const id of p.removeIds) byId.delete(id)
      if (Array.isArray(p.orderIds)) {
        const ordered = p.orderIds.filter((id) => byId.has(id))
        const set = new Set(ordered)
        const entries = [...byId.entries()]
        byId.clear()
        for (const [id, m] of entries) if (!set.has(id)) byId.set(id, m)
        for (const id of ordered) byId.set(id, entries.find(([k]) => k === id)[1])
      }
    } else if (isMessage(r)) {
      put(r)
    } else if (typeof r.sessionId === "string") {
      Object.assign(meta, r)
    }
  }
  return { meta, messages: [...byId.values()] }
}

const isMessage = (m) => m && typeof m === "object" && typeof m.id === "string" && typeof m.type === "string" && "content" in m

function patch(byId, p) {
  const m = byId.get(p.id)
  if (!m) return
  const next = { ...m }
  if (p.content !== undefined) next.content = p.content
  if (Array.isArray(p.toolCalls) && Array.isArray(m.toolCalls)) {
    next.toolCalls = m.toolCalls.map((tc) => {
      const tp = p.toolCalls.find((x) => x && x.id === tc.id)
      return tp && "result" in tp ? { ...tc, result: tp.result } : tc
    })
  }
  byId.set(p.id, next)
}

// Text of a PartListUnion: a string, a Part ({ text }) or an array of either.
export function partText(c) {
  if (c == null) return ""
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map(partText).filter(Boolean).join(" ")
  if (typeof c === "object" && typeof c.text === "string" && !c.thought) return c.text
  return ""
}

// MCP tools are named mcp_<server>_<tool> in current releases and <server>__<tool> in
// some older ones. Returns the bare tool name for the ws server, else null.
export function wsToolName(name) {
  const m = String(name || "").match(/^(?:mcp_ws_|ws__)(ws_[a-z_]+)$/)
  return m ? m[1] : null
}
