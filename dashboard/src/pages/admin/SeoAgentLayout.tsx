import React from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { UserButton } from '@clerk/clerk-react'
import './seo-agent.css'

// Minimal-chrome layout for /admin/seo-agent.
//
// Intentionally does NOT mount the global Sidebar: this page is a private
// working surface for Erez with three panels that want the full width. The
// header carries the same logo treatment as the shared shell (white bar,
// hairline, Minuto logo) plus a clear way back to the main app.
//
// Layout is decoupled from the rest of the dashboard on purpose: any
// future migration of this page (e.g. to a Next.js subapp) doesn't have
// to drag dashboard layout dependencies with it.
//
// `h-dvh` instead of `h-screen`: on phones 100vh includes the area behind
// the browser toolbar, which pushed the chat composer off screen.
export default function SeoAgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" className="seo-agent h-dvh w-full flex flex-col overflow-hidden bg-[var(--bg)] text-surface-900 font-sans">
      <header className="h-14 shrink-0 bg-white border-b border-surface-200 ps-3 pe-2 lg:ps-5 lg:pe-4 flex items-center gap-3">
        <img src="/logo.png" alt="Minuto" className="h-10 w-auto -my-1 object-contain shrink-0" />
        <span className="h-6 w-px bg-surface-200 shrink-0" aria-hidden="true" />
        <div className="min-w-0 leading-tight">
          <div className="text-[15px] font-semibold text-surface-900 truncate">סוכן אורגני</div>
          <div className="hidden sm:block text-[12.5px] text-surface-500 truncate">תוכן, אינסטגרם ו-SEO, באישור שלך</div>
        </div>
        <div className="ms-auto flex items-center gap-2 shrink-0">
          <Link
            to="/plan"
            className="act"
            title="חזרה למערכת השיווק"
          >
            <ArrowRight size={16} aria-hidden="true" />
            <span className="hidden sm:inline">חזרה למערכת השיווק</span>
            <span className="sm:hidden">חזרה</span>
          </Link>
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-hidden">
        {children}
      </main>
    </div>
  )
}
