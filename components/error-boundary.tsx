"use client"

import { Component, type ErrorInfo, type ReactNode } from "react"
import { ErrorFallback } from "@/components/error-fallback"

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface State {
  error: Error | null
  componentStack: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo)
    this.setState({ componentStack: errorInfo.componentStack ?? null })
    this.props.onError?.(error, errorInfo)
  }

  handleReset = () => {
    this.setState({ error: null, componentStack: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback) return this.props.fallback
    return <ErrorFallback error={this.state.error} componentStack={this.state.componentStack} onReset={this.handleReset} />
  }
}
