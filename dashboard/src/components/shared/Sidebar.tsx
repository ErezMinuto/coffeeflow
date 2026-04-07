import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Instagram, Megaphone, Search, Globe, Bot, Mail, Settings, TrendingUp } from 'lucide-react'

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

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 h-screen sticky top-0 flex flex-col bg-white border-l border-surface-200 py-6">
      {/* Logo */}
      <div className="px-5 mb-8">
        <h1 className="font-display text-xl font-semibold text-surface-900">Minuto</h1>
        <p className="text-xs text-surface-400 mt-0.5">Marketing Dashboard</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-1">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
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
  )
}
