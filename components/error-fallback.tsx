"use client"

import { useState } from "react"
import { AlertTriangle, Bug, Copy, Home, RefreshCw } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button, buttonVariants } from "@/components/ui/button"

const ISSUES_URL = "https://github.com/justinrhowell/workstreams/issues"

type Props = {
  error: Error & { digest?: string }
  componentStack?: string | null
  onReset: () => void
}

// Shared by app/error.tsx (route errors) and ErrorBoundary (render errors outside a route).
// The board is local-only, so errors are logged to the console and nowhere else.
export function ErrorFallback({ error, componentStack, onReset }: Props) {
  // Shown inline: the sonner Toaster sits inside the ErrorBoundary, so a toast may not render here.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")

  async function copyDetails() {
    const details = {
      message: error.message || "Unknown error",
      stack: error.stack || "No stack trace available",
      digest: error.digest,
      componentStack: componentStack || undefined,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: window.location.href,
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(details, null, 2))
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-6 w-6" aria-hidden="true" />
            Something went wrong
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            The board hit an unexpected error. Your workstream files weren&apos;t changed by it. Try again, or reload the page.
          </p>

          {process.env.NODE_ENV === "development" && (
            <details className="cursor-pointer">
              <summary className="text-sm font-medium">Error details (development only)</summary>
              <div className="mt-2 space-y-2">
                <p className="break-all rounded-md bg-muted p-3 font-mono text-xs">{error.message}</p>
                {error.stack && <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">{error.stack}</pre>}
              </div>
            </details>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={onReset}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Reload page
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                // A full reload is deliberate here: the app is in an error state, so start clean.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.href = "/"
              }}
            >
              <Home className="mr-2 h-4 w-4" aria-hidden="true" />
              Go home
            </Button>
            <Button variant="outline" onClick={copyDetails}>
              <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              Copy error details
            </Button>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
              <Bug className="mr-2 h-4 w-4" aria-hidden="true" />
              Report an issue
            </a>
          </div>

          <p role="status" className="text-xs text-muted-foreground">
            {copyState === "copied" ? "Error details copied." : copyState === "failed" ? "Couldn't copy: the browser blocked clipboard access." : ""}
          </p>

          {error.digest && <p className="text-xs text-muted-foreground">Error ID: {error.digest}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
