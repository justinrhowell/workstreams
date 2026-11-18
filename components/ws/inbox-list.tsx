"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, type InboxRow, type Workstream } from "./api"

export function InboxList({ workstreams, onChange }: { workstreams: Workstream[]; onChange: () => void }) {
  const [rows, setRows] = useState<InboxRow[] | null>(null)
  const load = useCallback(async () => setRows(await api.inbox().catch(() => [])), [])
  useEffect(() => {
    const t = setTimeout(load, 0) // fetch after mount, outside the effect body
    return () => clearTimeout(t)
  }, [load])

  async function act(body: Record<string, unknown>, done: string) {
    try {
      await api.inboxAct(body)
      toast.success(done)
      await load()
      onChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  if (!rows) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!rows.length) return <p className="text-sm text-muted-foreground">Inbox empty. Sessions that end outside any workstream folder show up here.</p>

  const live = workstreams.filter((w) => w.status !== "done")
  return (
    <ul className="max-w-4xl divide-y rounded-md border">
      {rows.map((r) => <Row key={r.session} r={r} live={live} act={act} />)}
    </ul>
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
