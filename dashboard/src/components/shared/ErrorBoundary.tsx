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
        <div
          dir="rtl"
          style={{
            padding: '40px 24px',
            maxWidth: '640px',
            margin: '40px auto',
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            borderRadius: '16px',
            textAlign: 'center',
            fontFamily: "'Heebo', Arial, sans-serif",
          }}
        >
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>⚠️</div>
          <h2
            style={{
              margin: '0 0 8px',
              color: '#991B1B',
              fontSize: '1.25rem',
              fontWeight: 700,
            }}
          >
            שגיאה בטעינת המסך "{this.props.sectionName}"
          </h2>
          <p
            style={{
              margin: '0 0 20px',
              color: '#7F1D1D',
              fontSize: '0.95rem',
              lineHeight: 1.6,
            }}
          >
            משהו השתבש בטעינת המסך הזה. שאר המערכת ממשיכה לעבוד כרגיל.
            <br />
            נסה/י לרענן את המסך. אם זה חוזר — פנה/י למנהל המערכת.
          </p>

          {/* Technical detail for debugging — collapsed by default */}
          {this.state.error && (
            <details
              style={{
                textAlign: 'left',
                marginBottom: '20px',
                direction: 'ltr',
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                color: '#991B1B',
              }}
            >
              <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>
                פרטים טכניים
              </summary>
              <pre
                style={{
                  background: '#FFF',
                  padding: '12px',
                  borderRadius: '8px',
                  overflow: 'auto',
                  maxHeight: '200px',
                }}
              >
                {this.state.error.message}
                {'\n\n'}
                {this.state.error.stack}
              </pre>
            </details>
          )}

          <button
            onClick={this.handleReset}
            style={{
              background: '#991B1B',
              color: 'white',
              border: 'none',
              borderRadius: '10px',
              padding: '10px 24px',
              fontSize: '0.95rem',
              fontWeight: 600,
              cursor: 'pointer',
              marginRight: '8px',
            }}
          >
            🔄 נסה שוב
          </button>
          <button
            onClick={() => (window.location.href = '/')}
            style={{
              background: 'white',
              color: '#991B1B',
              border: '1px solid #FECACA',
              borderRadius: '10px',
              padding: '10px 24px',
              fontSize: '0.95rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            🏠 חזרה לדף הבית
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
