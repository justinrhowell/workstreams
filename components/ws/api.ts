"use client"

import type { Board, Detail, SearchHit, SearchResult } from "@/lib/ws/server"

export type { Board, Detail, SearchHit, SearchResult }
export type Workstream = Board["workstreams"][number]
export type InboxRow = { session: string; tool: string; title: string; cwd: string; day: string; turns: number | null; files: number; suggestions: string[] }
export type Proposal = Detail["proposals"][number]
export type TrashRow = { name: string; id: string; title: string; deleted_at: string }

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: "no-store" } : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data as T
}

export const api = {
  board: () => call<Board>("/api/ws"),
  search: (q: string, signal?: AbortSignal) => fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: "no-store", signal })
    .then(async (res) => { const d = await res.json(); if (!res.ok) throw new Error(d?.error || `HTTP ${res.status}`); return d as SearchResult }),
  detail: (id: string) => call<Detail>(`/api/ws/${encodeURIComponent(id)}`),
  act: (id: string, body: Record<string, unknown>) => call(`/api/ws/${encodeURIComponent(id)}`, body),
  inbox: () => call<InboxRow[]>("/api/inbox"),
  inboxAct: (body: Record<string, unknown>) => call("/api/inbox", body),
  review: () => call<Proposal[]>("/api/review"),
  trash: () => call<TrashRow[]>("/api/trash"),
  trashAct: (body: Record<string, unknown>) => call("/api/trash", body),
  reviewAct: (body: Record<string, unknown>) => call("/api/review", body),
}

export function ago(ms: number) {
  const h = (Date.now() - ms) / 36e5
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

export const isStale = (w: { status: string; lastActivity: number }, days: number) =>
  (w.status === "active" || w.status === "waiting") && Date.now() - w.lastActivity > days * 864e5
