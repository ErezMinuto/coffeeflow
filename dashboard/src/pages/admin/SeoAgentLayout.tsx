import React from 'react'

// Minimal-chrome layout for /admin/seo-agent.
//
// Intentionally does NOT mount the global Sidebar or header — this page
// is a private dashboard surface for Erez. The layout sets an LTR
// direction (English-default admin UI), a dark-on-light palette, and a
// single fixed-height frame that the three-panel page fills.
//
// Layout is decoupled from the rest of the dashboard on purpose: any
// future migration of this page (e.g. to a Next.js subapp) doesn't have
// to drag dashboard layout dependencies with it.
export default function SeoAgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      dir="ltr"
      className="h-screen w-screen overflow-hidden bg-surface-50 text-surface-900 font-sans"
      style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}
    >
      <header className="h-12 border-b border-surface-200 bg-white px-4 flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-surface-900">Minuto SEO Agent</span>
          <span className="text-surface-400">/ admin</span>
        </div>
        <a
          href="/"
          className="text-xs text-surface-500 hover:text-surface-700 transition-colors"
          title="Back to main dashboard"
        >Back to dashboard</a>
      </header>
      <main className="h-[calc(100vh-3rem)] overflow-hidden">
        {children}
      </main>
    </div>
  )
}
