import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { Mail, Settings, Sparkles, Target, Film, X } from 'lucide-react'
import { UserButton } from '@clerk/clerk-react'

// Meta Ads / Instagram / Google Organic are tabs inside the
// /plan cockpit (their standalone routes still work for deep links, they're
// just no longer top-level nav items).
const NAV = [
  { to: '/plan',            icon: Target,   label: 'שיווק' },
  { to: '/admin/seo-agent', icon: Sparkles, label: 'סוכן אורגני' },
  { to: '/reels',           icon: Film,     label: 'רילס מוצרים' },
  { to: '/marketing',       icon: Mail,     label: 'מחולל מיילים' },
  { to: '/settings',        icon: Settings, label: 'הגדרות' },
]

interface SidebarProps {
  // Controls whether the mobile drawer is open. On `lg` and up the sidebar
  // is always visible regardless of this prop.
  isOpen?: boolean
  onClose?: () => void
}

// Same shell as CoffeeFlow: a white column on the right (RTL) with a hairline
// border, olive-soft active item. Below `lg` it is a drawer that slides in
// from the right edge; closes on navigation (Layout), Escape, the X, or the
// scrim. Drawer timing follows the shared system: 300ms in, 260ms out.
export function Sidebar({ isOpen = false, onClose }: SidebarProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  // Layout passes a fresh arrow each render; keep the latest in a ref so the
  // effect below only runs when the drawer opens or closes.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!isOpen) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen])

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`fixed inset-0 bg-[rgba(28,33,26,0.32)] z-30 lg:hidden transition-opacity duration-200 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      <aside
        aria-label="ניווט ראשי"
        className={`
          w-[min(300px,86vw)] shrink-0 bg-white border-l border-surface-200 px-3.5 pt-5 pb-3.5 flex flex-col gap-5
          fixed top-0 bottom-0 right-0 z-40 shadow-[0_12px_32px_rgba(28,33,26,0.12)]
          transition-[transform,visibility] ease-[cubic-bezier(0.32,0.72,0,1)]
          ${isOpen ? 'translate-x-0 visible duration-300' : 'translate-x-full invisible duration-[260ms]'}
          lg:w-60 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:visible lg:transition-none lg:z-0 lg:shadow-none
        `.trim().replace(/\s+/g, ' ')}
      >
        <div className="flex items-center justify-between px-2">
          <img src="/logo.png" alt="Minuto" className="h-[52px] w-auto -my-1.5 object-contain" />
          <button
            ref={closeRef}
            onClick={onClose}
            className="lg:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg text-surface-700 transition-transform duration-150 active:scale-95"
            aria-label="סגירת תפריט"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 overflow-y-auto">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onClose}
              className={({ isActive }) =>
                `group flex items-center gap-2.5 min-h-10 px-2.5 py-2 rounded-lg text-sm font-medium
                 transition-[background-color,color,transform] duration-150 active:scale-[0.98] ${
                  isActive
                    ? 'bg-brand-100 text-brand-600'
                    : 'text-surface-700 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-100 [@media(hover:hover)_and_(pointer:fine)]:hover:text-surface-900'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={18} aria-hidden="true" className={isActive ? 'text-brand-600' : 'text-surface-500'} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="pt-3 px-2 border-t border-surface-200 flex items-center gap-2.5">
          <UserButton afterSignOutUrl="/" />
        </div>
      </aside>
    </>
  )
}
