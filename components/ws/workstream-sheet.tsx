"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { api, ago, type Detail } from "./api"
import { ProposalCard } from "./review-list"
import { LoadError, errorText } from "./load-error"

type Props = { id: string | null; onClose: () => void; onCloseFocus?: () => void; onChange: () => void; onError: (m: string) => void }

export function WorkstreamSheet({ id, onClose, onCloseFocus, onChange, onError }: Props) {
  const [d, setD] = useState<Detail | null>(null)
  const [newItem, setNewItem] = useState("")
  const [newWaiting, setNewWaiting] = useState("")
  const [waitingOn, setWaitingOn] = useState("")
  // null: the workstream's own tool (what plain `ws go <id>` launches).
  const [picked, setTool] = useState<"claude" | "codex" | "gemini" | null>(null)
  const [busy, setBusy] = useState(false)
  // A failed detail read (e.g. the workstream was deleted from the CLI) is shown in the panel
  // with Retry, instead of a toast and a "Loading…" that never ends.
  const [loadError, setLoadError] = useState<string | null>(null)
  const current = useRef(id) // ignore a response for a workstream that's no longer open
  useEffect(() => { current.current = id }, [id])

  const load = useCallback(async () => {
    if (!id) return
    try {
      const data = await api.detail(id)
      if (current.current !== id) return
      setD(data)
      setWaitingOn(data.waiting_on)
      setLoadError(null)
    } catch (e) {
      if (current.current === id) setLoadError(errorText(e))
    }
  }, [id])

  // New workstream: clear the old detail and error, then fetch (after mount, outside the effect body).
  useEffect(() => {
    const t = setTimeout(() => { setD(null); setLoadError(null); setTool(null); load() }, 0)
    return () => clearTimeout(t)
  }, [load])

  function retry() {
    setLoadError(null)
    load()
  }

  // Resolves true when the change was saved, so callers only clear input or close on success.
  async function act(body: Record<string, unknown>, done?: string): Promise<boolean> {
    if (!id) return false
    setBusy(true)
    try {
      await api.act(id, body)
      if (done) toast.success(done)
      // A deleted workstream can't be read back, and the panel closes right after anyway.
      if (body.action !== "delete") await load()
      onChange()
      return true
    } catch (e) {
      onError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  function copy(text: string, what: string) {
    navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => onError("Clipboard blocked"))
  }

  const tool = picked ?? d?.tool ?? "claude"
  const prompt = d?.prompt[tool]
  // A flag only when the tab isn't the workstream's own tool, so the command launches the prompt shown.
  const goCommand = d ? `ws go ${d.id}${tool !== d.tool ? ` --${tool}` : ""}` : ""

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={(e) => {
          // The panel has no trigger element; return focus to the card that opened it.
          if (onCloseFocus) { e.preventDefault(); onCloseFocus() }
        }}
      >
        {!d ? (
          <>
            <SheetTitle className={loadError ? "mb-3 pr-6" : "sr-only"}>{loadError ? id : "Workstream"}</SheetTitle>
            <SheetDescription className="sr-only">{loadError ? "Workstream details couldn't be loaded" : "Loading workstream details"}</SheetDescription>
            {loadError
              ? <LoadError what="this workstream" error={loadError} onRetry={retry} />
              : <p role="status" className="text-sm text-muted-foreground">Loading…</p>}
          </>
        ) : (
          <div className="space-y-6">
            {loadError && <LoadError what="the latest changes" error={loadError} onRetry={retry} />}
            <SheetHeader>
              <SheetTitle className="pr-6 leading-snug">{d.title}</SheetTitle>
              <SheetDescription>
                {d.id}
                {d.group ? ` · ${d.group}` : ""}
                {d.cwd ? ` · ${d.cwd}` : ""} · last session {ago(d.lastActivity)} ago
              </SheetDescription>
            </SheetHeader>

            <section className="flex flex-wrap items-end gap-2">
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">Status</span>
                <Select value={d.status} onValueChange={(v) => act({ action: "status", status: v }, `Status: ${v}`)} disabled={busy}>
                  <SelectTrigger className="w-32" aria-label="Status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[...["active", "waiting", "parked", "done"], ...(d.status === "archived" ? ["archived"] : [])].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <form
                className="flex flex-1 items-end gap-2"
                onSubmit={(e) => { e.preventDefault(); act({ action: "status", waiting_on: waitingOn.trim() }, "Saved") }}
              >
                <label className="flex-1 text-xs">
                  <span className="mb-1 block text-muted-foreground">Waiting on</span>
                  <Input value={waitingOn} onChange={(e) => setWaitingOn(e.target.value)} placeholder="nobody" />
                </label>
                <Button type="submit" variant="outline" size="sm" disabled={busy || waitingOn === d.waiting_on}>Save</Button>
              </form>
            </section>

            {d.proposals.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">To review</h3>
                <div className="space-y-2">
                  {d.proposals.map((p) => <ProposalCard key={p.session + p.fingerprint} p={p} onDone={() => { load(); onChange() }} />)}
                </div>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-sm font-medium">Open items <span className="text-muted-foreground">{d.open.length}</span></h3>
              <ul className="divide-y rounded-md border">
                {d.open.map((i) => (
                  <li key={i.id} className="flex items-start gap-3 p-2 text-sm">
                    <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{i.id}</span>
                    <span className="flex-1">
                      {i.text}
                      {i.waiting && <span className="ml-1 text-xs text-muted-foreground">· waiting on {i.waiting}</span>}
                    </span>
                    <Button size="sm" variant="ghost" disabled={busy} aria-label={`Close item ${i.id}: ${i.text}`} onClick={() => act({ action: "close", item: i.id }, `Closed ${i.id}`)}>
                      Close
                    </Button>
                  </li>
                ))}
                {!d.open.length && <li className="p-2 text-sm text-muted-foreground">Nothing open.</li>}
              </ul>
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!newItem.trim()) return
                  act({ action: "add", text: newItem, waiting: newWaiting.trim() || undefined }, "Added").then((ok) => { if (ok) { setNewItem(""); setNewWaiting("") } })
                }}
              >
                <Input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="New open item" aria-label="New open item" />
                <Input className="w-36" value={newWaiting} onChange={(e) => setNewWaiting(e.target.value)} placeholder="waiting on" aria-label="Waiting on" />
                <Button type="submit" size="sm" disabled={busy || !newItem.trim()}>Add</Button>
              </form>
            </section>

            {d.decisions.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">Decided <span className="text-muted-foreground">{d.decisions.length}</span></h3>
                <ul className="divide-y rounded-md border">
                  {d.decisions.map((x) => (
                    <li key={x.id} className="flex items-start gap-3 p-2 text-sm">
                      <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{x.id}</span>
                      <span className="flex-1">
                        {x.text}
                        {x.why && <span className="block text-xs text-muted-foreground">Why: {x.why}</span>}
                        {x.rejected && <span className="block text-xs text-muted-foreground">Rejected: {x.rejected}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Resume prompt</h3>
                <div className="flex gap-1">
                  {(["claude", "codex", "gemini"] as const).map((t) => (
                    <Button key={t} size="sm" variant={tool === t ? "secondary" : "ghost"} aria-pressed={tool === t} aria-label={`Resume prompt for ${t}`} onClick={() => setTool(t)}>{t}</Button>
                  ))}
                </div>
              </div>
              {prompt?.error ? (
                <p className="rounded-md border border-red-300 p-2 text-sm text-red-700 dark:text-red-400">{prompt.error}</p>
              ) : (
                <>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">{prompt?.text}</pre>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => copy(prompt?.text || "", "Prompt")}>Copy prompt</Button>
                    <Button size="sm" variant="outline" onClick={() => copy(goCommand, "Command")}>
                      Copy <code className="ml-1">{goCommand}</code>
                    </Button>
                  </div>
                </>
              )}
            </section>

            {d.sources.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">Sources</h3>
                <ul className="space-y-1 text-xs">
                  {d.sources.map((s) => (
                    <li key={s.path + s.section} className="break-all">
                      <Badge variant="outline" className="mr-2">{s.role || "file"}</Badge>
                      {s.section ? `"${s.section}" in ` : ""}{s.path}
                    </li>
                  ))}
                </ul>
                {d.procedure && <p className="mt-2 text-xs text-muted-foreground">Procedure: {d.procedure}{d.mirror ? ` · mirrored to ${d.mirror}` : ""}</p>}
              </section>
            )}

            <section>
              <h3 className="mb-2 text-sm font-medium">Sessions <span className="text-muted-foreground">{d.logs.length}</span></h3>
              <ol className="space-y-3">
                {d.logs.map((l, n) => (
                  <li key={(l.session || "") + n} className="text-sm">
                    <div className="text-xs text-muted-foreground">
                      {l.day} · {l.tool || "?"}{l.title ? ` · ${l.title}` : ""}
                      {l.closed.length ? ` · closed ${l.closed.join(", ")}` : ""}
                      {l.added.length ? ` · added ${l.added.join(", ")}` : ""}
                      {/model/.test(l.source) ? " · model summary (reviewed)" : ""}
                    </div>
                    <p className={/^\(auto\)/.test(l.summary) ? "text-muted-foreground italic" : ""}>
                      {/^\(auto\)/.test(l.summary) ? "No notes from this session." : l.summary}
                    </p>
                  </li>
                ))}
              </ol>
            </section>

            <section className="flex flex-wrap items-center gap-2 border-t pt-4">
              {d.status === "archived" ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "unarchive" }, "Unarchived")}>Unarchive</Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "archive" }, "Archived").then((ok) => ok && onClose())}>Archive</Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 dark:text-red-400" disabled={busy}>Delete…</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {d.title}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Moves the workstream, its log, decisions and pending drafts to the trash. You can restore it from Recently deleted on the board,
                      or with <code>ws trash restore</code>. Emptying the trash (CLI only) is permanent.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => act({ action: "delete" }, "Moved to trash").then((ok) => ok && onClose())}>Move to trash</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <span className="text-xs text-muted-foreground">Archive hides it but keeps it; delete moves it to the trash.</span>
            </section>

            {d.closed.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">Recently closed</h3>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {d.closed.map((i) => <li key={i.id}><span className="font-mono">{i.id}</span> {i.text}{i.closed ? ` (${i.closed})` : ""}</li>)}
                </ul>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
