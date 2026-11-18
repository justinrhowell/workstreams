"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { api, ago, isStale, type Board, type TrashRow, type Workstream } from "./api"
import { WorkstreamSheet } from "./workstream-sheet"
import { InboxList } from "./inbox-list"
import { ReviewList } from "./review-list"

const COLUMNS: { status: string; label: string; hint: string }[] = [
  { status: "active", label: "Active", hint: "next move is yours" },
  { status: "waiting", label: "Waiting", hint: "on someone else" },
  { status: "parked", label: "Parked", hint: "paused" },
  { status: "done", label: "Done", hint: "" },
]

export function BoardApp() {
  const [board, setBoard] = useState<Board | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [trash, setTrash] = useState<TrashRow[]>([])
  // Where focus was when a workstream was opened, so closing the panel puts it back there.
  const opener = useRef<HTMLElement | null>(null)
  const open = useCallback((id: string) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelected(id)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const b = await api.board()
      setBoard(b)
      setTrash(b.counts.trash ? await api.trash() : [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Sessions end in other windows; keep the board current without a reload.
  // The first load runs from a timer too, so no state is set synchronously in the effect.
  useEffect(() => {
    const first = setTimeout(refresh, 0)
    const t = setInterval(refresh, 10_000)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [refresh])

  if (error && !board) return <p role="alert" className="p-8 text-sm text-red-600">Couldn&apos;t read workstreams: {error}</p>
  if (!board) return <p role="status" className="p-8 text-sm text-muted-foreground">Loading…</p>

  const stale = board.workstreams.filter((w) => isStale(w, board.staleDays))
  const archived = board.workstreams.filter((w) => w.status === "archived")
  const columns = showArchived ? [...COLUMNS, { status: "archived", label: "Archived", hint: "hidden everywhere else" }] : COLUMNS
  async function restore(name: string) {
    try {
      await api.trashAct({ action: "restore", name })
      toast.success("Restored")
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Workstreams</h1>
        <p className="text-xs text-muted-foreground">
          {board.root}
          {board.counts.queued ? ` · ${board.counts.queued} summaries queued` : ""}
        </p>
      </div>

      <Tabs defaultValue="board">
        <TabsList>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="inbox">Inbox{board.counts.inbox ? ` (${board.counts.inbox})` : ""}</TabsTrigger>
          <TabsTrigger value="review">Review{board.counts.review ? ` (${board.counts.review})` : ""}</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="mt-4">
          {stale.length > 0 && (
            <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
              {stale.length} {stale.length === 1 ? "workstream has" : "workstreams have"} had no session in {board.staleDays}+ days:{" "}
              {stale.map((w, i) => (
                <button key={w.id} className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => open(w.id)}>
                  {w.id}{i < stale.length - 1 ? ", " : ""}
                </button>
              ))}
            </p>
          )}
          <div className={`grid gap-4 md:grid-cols-2 ${showArchived ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
            {columns.map((col) => {
              const cards = board.workstreams.filter((w) => w.status === col.status)
              return (
                <section key={col.status} aria-labelledby={`col-${col.status}`}>
                  <h2 id={`col-${col.status}`} className="mb-2 flex items-baseline gap-2 text-sm font-medium">
                    {col.label} <span className="text-muted-foreground">{cards.length}</span>
                    {col.hint && <span className="text-xs font-normal text-muted-foreground">{col.hint}</span>}
                  </h2>
                  {cards.length ? (
                    <ul className="space-y-2">
                      {cards.map((w) => (
                        <li key={w.id}>
                          <Card w={w} stale={isStale(w, board.staleDays)} onOpen={() => open(w.id)} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">None</p>
                  )}
                </section>
              )
            })}
          </div>

        {(archived.length > 0 || trash.length > 0) && (
          <div className="mt-6 space-y-3 border-t pt-4 text-sm">
            {archived.length > 0 && (
              <Button size="sm" variant="ghost" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
              </Button>
            )}
            {trash.length > 0 && (
              <div>
                <h2 className="mb-2 text-sm font-medium">Recently deleted <span className="text-muted-foreground">{trash.length}</span></h2>
                <ul className="divide-y rounded-md border">
                  {trash.map((t) => (
                    <li key={t.name} className="flex items-center gap-3 p-2">
                      <span className="flex-1">{t.title || t.id} <span className="text-xs text-muted-foreground">{t.id} · deleted {t.deleted_at.slice(0, 10)}</span></span>
                      <Button size="sm" variant="outline" aria-label={`Restore ${t.title || t.id}`} onClick={() => restore(t.name)}>Restore</Button>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">Emptying the trash is permanent and CLI-only: <code>ws trash empty --yes</code></p>
              </div>
            )}
          </div>
        )}
        </TabsContent>

        <TabsContent value="inbox" className="mt-4">
          <InboxList workstreams={board.workstreams} onChange={refresh} />
        </TabsContent>

        <TabsContent value="review" className="mt-4">
          <ReviewList onChange={refresh} onOpen={setSelected} />
        </TabsContent>
      </Tabs>

      <WorkstreamSheet
        id={selected}
        onClose={() => setSelected(null)}
        onCloseFocus={() => opener.current?.focus()}
        onChange={() => {
          refresh()
        }}
        onError={(m) => toast.error(m)}
      />
    </div>
  )
}

function Card({ w, stale, onOpen }: { w: Workstream; stale: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="block w-full rounded-md border bg-card p-3 text-left transition-colors hover:border-foreground/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug">{w.title}</span>
        <span className={`shrink-0 text-xs tabular-nums ${stale ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
          {ago(w.lastActivity)}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {w.id}
        {w.group ? ` · ${w.group}` : ""}
      </div>
      {w.waiting_on && <div className="mt-1 text-xs">Waiting on {w.waiting_on}</div>}
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="secondary">{w.open} open</Badge>
        {w.waitingItems > 0 && <Badge variant="outline">{w.waitingItems} waiting</Badge>}
        {w.proposals > 0 && <Badge>{w.proposals} to review</Badge>}
      </div>
      {w.lastSummary && <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{w.lastSummary.text}</p>}
    </button>
  )
}
