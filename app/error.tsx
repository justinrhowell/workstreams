"use client"

import { useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertTriangle, RefreshCw, Home, Bug } from "lucide-react"
import { toast } from "sonner"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error("Application error:", error)
    
    // In production, send to error reporting service
    if (process.env.NODE_ENV === "production") {
      // TODO: Send to Sentry or similar
      // Sentry.captureException(error)
    }
  }, [error])

  const handleReload = () => {
    window.location.reload()
  }

  const handleGoHome = () => {
    window.location.href = "/"
  }

  const handleReportBug = () => {
    const errorDetails = {
      message: error.message || "Unknown error",
      stack: error.stack || "No stack trace available",
      digest: error.digest || "No digest available",
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: window.location.href,
    }

    // Copy error details to clipboard
    navigator.clipboard.writeText(JSON.stringify(errorDetails, null, 2))
    toast.success("Error details copied to clipboard")
    
    // Open this project's issue tracker
    window.open("https://github.com/justinrhowell/workstreams/issues", "_blank")
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-lg w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-6 w-6" />
            Something went wrong!
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            An unexpected error occurred while processing your request. 
            Please try again or contact support if the issue persists.
          </p>

          {process.env.NODE_ENV === "development" && (
            <div className="space-y-2">
              <details className="cursor-pointer">
                <summary className="text-sm font-medium">
                  Error Details (Development Only)
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="p-3 bg-muted rounded-md">
                    <p className="text-xs font-mono break-all">
                      {error.message}
                    </p>
                  </div>
                  {error.stack && (
                    <div className="p-3 bg-muted rounded-md max-h-48 overflow-auto">
                      <pre className="text-xs">{error.stack}</pre>
                    </div>
                  )}
                  {error.digest && (
                    <div className="p-3 bg-muted rounded-md">
                      <p className="text-xs">
                        <strong>Error ID:</strong> {error.digest}
                      </p>
                    </div>
                  )}
                </div>
              </details>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={reset} variant="default">
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
            <Button onClick={handleReload} variant="outline">
              <RefreshCw className="h-4 w-4 mr-2" />
              Reload Page
            </Button>
            <Button onClick={handleGoHome} variant="outline">
              <Home className="h-4 w-4 mr-2" />
              Go Home
            </Button>
            <Button onClick={handleReportBug} variant="outline">
              <Bug className="h-4 w-4 mr-2" />
              Report Issue
            </Button>
          </div>

          {error.digest && (
            <p className="text-xs text-muted-foreground">
              Error ID: {error.digest}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}