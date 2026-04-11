import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Instagram, Megaphone, Search, Globe, Bot, Mail, Settings, TrendingUp, X } from 'lucide-react'

const NAV = [
  { to: '/',               icon: LayoutDashboard, label: 'סקירה כללית' },
  { to: '/meta',           icon: Instagram,       label: 'Instagram' },
  { to: '/ads',            icon: Megaphone,       label: 'Meta Ads' },
  { to: '/google',         icon: Search,          label: 'Google Ads' },
  { to: '/google-organic', icon: Globe,           label: 'Google Organic' },
  { to: '/advisor',        icon: TrendingUp,      label: 'יועץ שיווק AI' },
  { to: '/analyst',        icon: Bot,             label: 'AI Analyst' },
  { to: '/marketing',      icon: Mail,            label: 'Email Generator' },
  { to: '/settings',       icon: Settings,        label: 'הגדרות' },
]

interface SidebarProps {
  // Controls whether the mobile drawer is open. On `lg` and up the sidebar
  // is always visible regardless of this prop.
  isOpen?: boolean
  onClose?: () => void
}

// Sidebar has two visual modes keyed on the `lg` breakpoint:
//
// - `lg` and up: a sticky in-flow column on the right side of the layout
//   (because the outer div is `dir="rtl"`), always visible, the page's
//   main content flows beside it.
// - Below `lg`: a fixed slide-in drawer on the right edge, hidden
//   off-screen by `translate-x-full` and revealed when `isOpen`. A close
//   button in the top-left of the drawer and a tap-anywhere backdrop
//   both dismiss.
//
// The `lg:` prefixes override the mobile-first defaults at ≥1024px so
// we don't have to split this into two components.
export function Sidebar({ isOpen = false, onClose }: SidebarProps) {
  return (
    <>
      {/* Backdrop — only rendered when the mobile drawer is open.
          `lg:hidden` means it never shows up on desktop even if isOpen
          somehow got set to true there. */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-black/40 z-30 lg:hidden"
          aria-hidden="true"
        />
      )}

      <aside
        className={`
          w-64 shrink-0 bg-white border-l border-surface-200 py-6 flex flex-col
          fixed top-0 bottom-0 right-0 z-40 transition-transform duration-200 ease-out
          ${isOpen ? 'translate-x-0' : 'translate-x-full'}
          lg:w-56 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:transition-none lg:z-0
        `.trim().replace(/\s+/g, ' ')}
      >
        {/* Close button — mobile drawer only. In RTL the drawer opens
            from the right edge so the close button sits on the LEFT
            side of the drawer (closest to the content it's covering). */}
        <button
          onClick={onClose}
          className="lg:hidden absolute top-3 left-3 p-2 -m-2 text-surface-500 hover:text-surface-800"
          aria-label="סגור תפריט"
        >
          <X size={20} />
        </button>

        {/* Logo */}
        <div className="px-5 mb-8">
          <h1 className="font-display text-xl font-semibold text-surface-900">Minuto</h1>
          <p className="text-xs text-surface-400 mt-0.5">Marketing Dashboard</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all ${
                  isActive
                    ? 'bg-brand-50 text-brand-700 font-medium'
                    : 'text-surface-500 hover:bg-surface-50 hover:text-surface-800'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Bottom */}
        <div className="px-5 pt-4 border-t border-surface-100">
          <p className="text-xs text-surface-300 font-mono">v0.1.0</p>
        </div>
      </aside>
    </>
  )
}
