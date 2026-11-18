import type React from "react"
import type { Metadata } from "next"
import Link from "next/link"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "sonner"
import { ErrorBoundary } from "@/components/error-boundary"

export const metadata: Metadata = {
  title: "Workstreams",
  description: "Local board for ws workstreams: open items, sessions, resume prompts.",
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ErrorBoundary>
            <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring">Skip to content</a>
            <header className="border-b">
              <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center gap-5 px-4 py-3 text-sm">
                <Link href="/" className="font-semibold">ws</Link>
                <Link href="/" className="text-muted-foreground hover:text-foreground">Workstreams</Link>
              </nav>
            </header>
            <main id="main" tabIndex={-1} className="focus:outline-none">{children}</main>
            <Toaster position="bottom-right" toastOptions={{ className: "text-sm" }} />
          </ErrorBoundary>
        </ThemeProvider>
      </body>
    </html>
  )
}
