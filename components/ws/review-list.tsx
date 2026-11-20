"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { api, type Proposal } from "./api"
import { LoadError, errorText } from "./load-error"

// `version` changes whenever the board's poll succeeds, so the list follows the same refresh as
// the "Review (n)" count. Rows are kept across reloads (and across a failed one), so ticked boxes
// survive and focus can return to the workstream link that opened the panel.
export function ReviewList({ version, onChange, onOpen }: { version: number; onChange: () => void; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0) // only the newest request may set state
  const load = useCallback(async () => {
    const n = ++seq.current
    try {
      const data = await api.review()
      if (n === seq.current) { setRows(data); setError(null) }
    } catch (e) {
      if (n === seq.current) setError(errorText(e))
    }
  }, [])
  useEffect(() => {
    const t = setTimeout(load, 0) // fetch after mount and on each board refresh, outside the effect body
    return () => clearTimeout(t)
  }, [load, version])

  const failed = error && <LoadError what="drafts to review" error={error} onRetry={load} />
  if (!rows) return failed || <p role="status" className="text-sm text-muted-foreground">Loading…</p>
  if (!rows.length) {
    return (
      <>
        {failed}
        {!error && (
          <p className="text-sm text-muted-foreground">
            Nothing to review. When a linked session ends without notes, the local model drafts a summary and item changes here. Nothing is applied until you accept it.
          </p>
        )}
      </>
    )
  }
  return (
    <>
      {failed}
      <div className="max-w-3xl space-y-3">
        {rows.map((p) => (
          // Keyed by the draft's fingerprint too: a newer draft for the session starts with nothing ticked.
          <div key={p.ws + p.session + p.fingerprint}>
            <button className="mb-1 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => onOpen(p.ws)}>{p.ws}</button>
            <ProposalCard p={p} onDone={() => { load(); onChange() }} />
          </div>
        ))}
      </div>
    </>
  )
}

export function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const [close, setClose] = useState(true)
  const [add, setAdd] = useState(true)
  const [confirm, setConfirm] = useState<string[]>([]) // unverified closes: off until ticked
  const [decide, setDecide] = useState(true)
  const [confirmDec, setConfirmDec] = useState<number[]>([]) // unverified decisions: off until ticked
  const [busy, setBusy] = useState(false)

  async function act(action: "accept" | "reject") {
    setBusy(true)
    try {
      const r = await api.reviewAct({ action, ws: p.ws, session: p.session, fingerprint: p.fingerprint, close, add, unverified: confirm, decide, confirmDecisions: confirmDec }) as { skipped?: string[] }
      if (action === "reject") toast.success("Rejected")
      else if (r?.skipped?.length) toast.warning(`Applied; skipped: ${r.skipped.join("; ")}`)
      else toast.success("Applied")
      onDone()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="text-xs text-muted-foreground">
        {p.created} · {p.tool} session {p.session.slice(0, 8)} · drafted by {p.model}
      </div>
      <p className="mt-1">{p.summary}</p>
      {p.close.length > 0 && (
        <label className="mt-2 flex items-start gap-2">
          <Checkbox checked={close} onCheckedChange={(v) => setClose(v === true)} className="mt-0.5" />
          <span>
            Close {p.close.map((c) => (
              <span key={c.id} className="block text-xs"><span className="font-mono">{c.id}</span> {c.item ? <>{c.item} · </> : null}<span className="text-muted-foreground">{c.evidence}</span></span>
            ))}
          </span>
        </label>
      )}
      {p.add.length > 0 && (
        <label className="mt-2 flex items-start gap-2">
          <Checkbox checked={add} onCheckedChange={(v) => setAdd(v === true)} className="mt-0.5" />
          <span>
            Add {p.add.map((a: { text: string; waiting: string | null }) => (
              <span key={a.text} className="block text-xs">{a.text}{a.waiting ? <span className="text-muted-foreground"> · waiting on {a.waiting}</span> : null}</span>
            ))}
          </span>
        </label>
      )}
      {p.unverified.map((u) => (
        <label key={u.id} className="mt-2 flex items-start gap-2">
          <Checkbox
            checked={confirm.includes(u.id)}
            onCheckedChange={(v) => setConfirm((c) => (v === true ? [...c, u.id] : c.filter((x) => x !== u.id)))}
            className="mt-0.5"
          />
          <span className="text-xs">
            Also close <span className="font-mono">{u.id}</span>{u.item ? ` (${u.item})` : ""}? <span className="text-muted-foreground">Unverified ({u.failed}): {u.evidence}</span>
          </span>
        </label>
      ))}
      {p.decide.some((d) => !d.unverified) && (
        <label className="mt-2 flex items-start gap-2">
          <Checkbox checked={decide} onCheckedChange={(v) => setDecide(v === true)} className="mt-0.5" />
          <span>
            Record decision{p.decide.filter((d) => !d.unverified).length > 1 ? "s" : ""}{" "}
            {p.decide.filter((d) => !d.unverified).map((d) => (
              <span key={d.text} className="block text-xs">{d.text}{d.why ? <span className="text-muted-foreground"> · {d.why}</span> : null}</span>
            ))}
          </span>
        </label>
      )}
      {p.decide.map((d, k) => d.unverified ? (
        <label key={`u${k}`} className="mt-2 flex items-start gap-2">
          <Checkbox
            checked={confirmDec.includes(k)}
            onCheckedChange={(v) => setConfirmDec((c) => (v === true ? [...c, k] : c.filter((x) => x !== k)))}
            className="mt-0.5"
          />
          <span className="text-xs">Also record decision? <span className="text-muted-foreground">Unverified ({d.unverified}): {d.text}</span></span>
        </label>
      ) : null)}
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} aria-label={`Accept draft for ${p.ws}`} onClick={() => act("accept")}>Accept</Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" disabled={busy} aria-label={`Reject draft for ${p.ws}`}>Reject…</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reject this draft for {p.ws}?</AlertDialogTitle>
              <AlertDialogDescription>
                Deletes the drafted summary, item changes and decisions for session {p.session.slice(0, 8)}. Nothing is applied to the
                workstream, and the session stays in its log without notes. This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => act("reject")}>Reject draft</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
