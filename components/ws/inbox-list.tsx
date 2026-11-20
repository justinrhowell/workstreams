"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, type InboxRow, type Workstream } from "./api"
import { LoadError, errorText } from "./load-error"

// `version` changes whenever the board's poll succeeds, so the list follows the same 10s refresh
// as the tab counts. Rows are kept across reloads (and across a failed one), so a background
// refresh doesn't reset a picked workstream or move focus.
export function InboxList({ workstreams, version, onChange }: { workstreams: Workstream[]; version: number; onChange: () => void }) {
  const [rows, setRows] = useState<InboxRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0) // only the newest request may set state
  const load = useCallback(async () => {
    const n = ++seq.current
    try {
      const data = await api.inbox()
      if (n === seq.current) { setRows(data); setError(null) }
    } catch (e) {
      if (n === seq.current) setError(errorText(e))
    }
  }, [])
  useEffect(() => {
    const t = setTimeout(load, 0) // fetch after mount and on each board refresh, outside the effect body
    return () => clearTimeout(t)
  }, [load, version])

  async function act(body: Record<string, unknown>, done: string) {
    try {
      await api.inboxAct(body)
      toast.success(done)
      await load()
      onChange()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const failed = error && <LoadError what="the inbox" error={error} onRetry={load} />
  if (!rows) return failed || <p role="status" className="text-sm text-muted-foreground">Loading…</p>
  if (!rows.length) {
    return (
      <>
        {failed}
        {!error && <p className="text-sm text-muted-foreground">Inbox empty. Sessions that end outside any workstream folder show up here.</p>}
      </>
    )
  }

  const live = workstreams.filter((w) => w.status !== "done")
  return (
    <>
      {failed}
      <ul className="max-w-4xl divide-y rounded-md border">
        {rows.map((r) => <Row key={r.session} r={r} live={live} act={act} />)}
      </ul>
    </>
  )
}

function Row({ r, live, act }: { r: InboxRow; live: Workstream[]; act: (b: Record<string, unknown>, done: string) => void }) {
  const [target, setTarget] = useState(r.suggestions[0] || "")
  return (
    <li className="flex flex-wrap items-center gap-3 p-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{r.title || "(untitled session)"}</div>
        <div className="truncate text-xs text-muted-foreground">
          {r.day} · {r.tool} · {r.cwd} · {r.turns ?? "?"} prompts, {r.files} files
        </div>
      </div>
      <Select value={target} onValueChange={setTarget}>
        <SelectTrigger className="w-56" aria-label={`Workstream for ${r.title || "untitled session"}`}><SelectValue placeholder="Assign to…" /></SelectTrigger>
        <SelectContent>
          {live.map((w) => (
            <SelectItem key={w.id} value={w.id}>{w.id}{r.suggestions.includes(w.id) ? " (suggested)" : ""}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" disabled={!target} aria-label={`Assign ${r.title || "untitled session"}`} onClick={() => act({ action: "assign", session: r.session, id: target }, `Linked to ${target}`)}>Assign</Button>
      <Button size="sm" variant="ghost" aria-label={`Ignore ${r.title || "untitled session"}`} onClick={() => act({ action: "ignore", session: r.session }, "Ignored")}>Ignore</Button>
      <Button size="sm" variant="ghost" aria-label={`Ignore every future session in ${r.cwd}`} title={`Ignore every future session in ${r.cwd}`} onClick={() => act({ action: "ignore", session: r.session, cwd: true }, `Ignoring ${r.cwd}`)}>
        Ignore folder
      </Button>
    </li>
  )
}
