"use client"

import { Button } from "@/components/ui/button"

// A failed read, shown in place (or on top of what was loaded before) with a way to try again.
// role="alert" because it replaces content the user is waiting for.
export function LoadError({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mb-3 flex max-w-4xl flex-wrap items-center gap-3 rounded-md border border-red-300 p-3 text-sm text-red-700 dark:text-red-400">
      <span className="min-w-0 flex-1">Couldn&apos;t load {what}: {error}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
    </div>
  )
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
