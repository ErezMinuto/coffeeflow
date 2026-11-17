/**
 * ErrorBoundary
 *
 * Catches React render errors in its children and shows a fallback UI
 * instead of crashing the whole app. Wrap each top-level page with one
 * of these so a bug in /marketing doesn't take down /meta, /google, etc.
 *
 * React default behavior without error boundaries: any uncaught error
 * during render unmounts the entire React tree and leaves the user with
 * a blank white page. With error boundaries, the crash is contained to
 * the wrapped subtree — neighboring routes keep working.
 *
 * Usage:
 *   <ErrorBoundary sectionName="Marketing">
 *     <MarketingPage />
 *   </ErrorBoundary>
 *
 * The boundary catches errors in:
 *   - render() / function component bodies
 *   - lifecycle methods
 *   - constructors of children
 *
 * It does NOT catch errors in:
 *   - Event handlers (click/submit — handle with try/catch)
 *   - Async code (use .catch or try/await)
 *   - Server-side rendering
 *   - Errors thrown in the boundary itself
 */

import React from 'react'
import { AlertTriangle, ChevronLeft, Home, RotateCcw } from 'lucide-react'

interface Props {
  children: React.ReactNode
  sectionName: string
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    // Called during the "render" phase — use this to update state so the
    // next render shows the fallback UI.
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Called during the "commit" phase — for side effects like logging.
    // Visible in the browser console during development, and could be
    // wired to an external logger (Sentry etc.) later.
    console.error(
      `[ErrorBoundary:${this.props.sectionName}] render crashed:`,
      error,
      errorInfo,
    )
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div dir="rtl" role="alert" className="max-w-[560px] mx-auto my-10 bg-white border border-surface-200 rounded-[10px] px-6 py-8 text-center">
          <span className="grid place-items-center w-10 h-10 mx-auto mb-4 rounded-full bg-[#FDF1EF] text-[#B42318]">
            <AlertTriangle size={20} aria-hidden="true" />
          </span>
          <h2 className="text-[17px] text-surface-900 m-0">
            שגיאה בטעינת המסך "{this.props.sectionName}"
          </h2>
          <p className="text-sm text-surface-500 leading-relaxed mt-2 mb-0">
            משהו השתבש בטעינת המסך הזה. שאר המערכת ממשיכה לעבוד כרגיל.
            <br />
            כדאי לרענן את המסך. אם זה חוזר, אפשר לפנות למנהל/ת המערכת.
          </p>

          {/* Technical detail for debugging — collapsed by default */}
          {this.state.error && (
            <details className="group mt-5 text-start">
              <summary className="inline-flex items-center gap-1 min-h-9 px-2 -mx-2 rounded-md cursor-pointer list-none text-[13px] font-medium text-surface-700 hover:bg-surface-100 transition-colors [&::-webkit-details-marker]:hidden">
                <ChevronLeft size={15} aria-hidden="true" className="text-surface-500 transition-transform duration-150 group-open:-rotate-90" />
                פרטים טכניים
              </summary>
              <pre dir="ltr" className="mt-2 p-3 rounded-lg bg-surface-50 border border-surface-200 text-left font-mono text-xs text-surface-700 whitespace-pre-wrap break-words overflow-auto max-h-[200px]">
                {this.state.error.message}
                {'\n\n'}
                {this.state.error.stack}
              </pre>
            </details>
          )}

          <div className="flex flex-wrap justify-center gap-2 mt-6">
            <button onClick={this.handleReset} className="btn-primary">
              <RotateCcw size={16} aria-hidden="true" />
              ניסיון חוזר
            </button>
            <button onClick={() => (window.location.href = '/')} className="btn-secondary">
              <Home size={16} aria-hidden="true" />
              חזרה לדף הבית
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
