import Link from "next/link"
import { Button } from "@/components/ui/button"

// The board has one page; anything else is a mistyped URL.
export default function NotFound() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-16">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">The board has a single page: the workstreams list.</p>
      <Button asChild className="mt-4" size="sm">
        <Link href="/">Back to workstreams</Link>
      </Button>
    </div>
  )
}
