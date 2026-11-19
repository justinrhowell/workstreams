"use client"

import { Badge } from "@/components/ui/badge"
import type { SearchHit, SearchResult } from "./api"

// Words or "quoted phrases", as ws/lib/search.mjs reads them; used only to highlight.
export function queryTerms(q: string) {
  return [...q.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean)
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi")
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-700/60">{part}</mark> : part))}</>
}

// The state goes first and in words, so history never reads as current.
function label(h: SearchHit) {
  switch (h.kind) {
    case "workstream": return { text: `Workstream · ${h.state}`, history: false }
    case "item": return h.state === "closed" ? { text: "Closed item", history: true } : { text: h.waiting ? `Open · waiting on ${h.waiting}` : "Open item", history: false }
    case "decision": return h.state === "superseded" ? { text: `Superseded${h.superseded_by ? ` by ${h.superseded_by}` : ""}`, history: true } : { text: "Decision", history: false }
    case "log": return { text: `Session ${h.date?.slice(0, 10) || ""}${h.tool ? ` · ${h.tool}` : ""}`, history: false }
    case "inbox": return { text: `Inbox ${h.date?.slice(0, 10) || ""}`, history: false }
  }
}

export function SearchResults({ result, query, onOpen, onInbox }: {
  result: SearchResult
  query: string
  onOpen: (id: string) => void
  onInbox: () => void
}) {
  const terms = queryTerms(query)
  return (
    <section aria-labelledby="search-heading" className="mb-6">
      <h2 id="search-heading" className="mb-2 text-sm font-medium">
        {result.total ? `${result.total} ${result.total === 1 ? "match" : "matches"}` : "No matches"}
        {result.total > result.results.length && <span className="ml-2 text-xs font-normal text-muted-foreground">showing the first {result.results.length}; add words to narrow</span>}
      </h2>
      {result.results.length > 0 && (
        <ul className="divide-y rounded-md border">
          {result.results.map((h) => {
            const l = label(h)
            return (
              <li key={`${h.kind}:${h.ws}:${h.id}`}>
                <button
                  onClick={() => (h.ws ? onOpen(h.ws) : onInbox())}
                  className="block w-full p-2 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge variant={l.history ? "outline" : "secondary"} className="shrink-0 font-normal">{l.text}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {h.ws ?? "inbox"}{h.wsStatus && !["active", "waiting"].includes(h.wsStatus) && h.kind !== "workstream" ? ` (${h.wsStatus})` : ""}
                      {(h.kind === "item" || h.kind === "decision") && ` · ${h.id}`}
                    </span>
                  </div>
                  <p className={`mt-1 text-sm ${l.history ? "text-muted-foreground line-through decoration-muted-foreground/40" : ""}`}>
                    <Highlight text={h.text || "(untitled)"} terms={terms} />
                  </p>
                  {h.snippet && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground"><Highlight text={h.snippet} terms={terms} /></p>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
