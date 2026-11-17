import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { Menu } from 'lucide-react'
import { SignIn, useAuth, useUser } from '@clerk/clerk-react'
import { setClerkTokenGetter } from './lib/supabase'
import { Sidebar } from './components/shared/Sidebar'
import { ErrorBoundary } from './components/shared/ErrorBoundary'
import MetaOrganicPage from './pages/MetaOrganic'
import MetaAdsPage from './pages/MetaAds'
import SettingsPage from './pages/Settings'
import { MetaCallback, GoogleCallback } from './pages/OAuthCallback'
import MarketingPage from './pages/Marketing'
import UnifiedPlanPage from './pages/UnifiedPlan'
import GoogleOrganicPage from './pages/GoogleOrganic'
import SeoAgentPage from './pages/admin/SeoAgent'
import ReelsPage from './pages/Reels'
import { AppProvider } from './lib/context'

// Layout wraps every page. Responsive behavior:
//
// - At `lg` (≥1024px) and up, the Sidebar is part of the flex row and
//   always visible, padding on main is generous (p-8).
// - Below `lg`, the Sidebar becomes a fixed slide-in drawer toggled by
//   the burger button in the sticky mobile header, main padding is
//   tight (p-4) so content isn't crushed on a 375px iPhone viewport.
//
// Before this change, the Sidebar was an unconditional `w-56` (224px)
// — on a 375px iPhone that left ~80-160px for the actual page content,
// and the Advisor header + week strip wrapped one word per line. The
// entire app was effectively unusable on mobile.
function Layout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()

  // Auto-close the drawer on every route change — otherwise tapping a
  // nav link inside the drawer navigates the page but leaves the drawer
  // covering it, forcing the user to tap the backdrop to dismiss.
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  return (
    <div className="flex min-h-screen bg-[#F7F6F2] overflow-x-hidden lg:overflow-x-visible" dir="rtl">
      {/* overflow-x-hidden on mobile clips the off-screen (translate-x-full)
          Sidebar drawer so its transform doesn't inflate document width and
          create phantom horizontal scroll. On `lg:` and up the sidebar is
          in-flow so clipping isn't needed. */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header — burger + wordmark, sticky top on mobile only.
            `lg:hidden` hides it on desktop so the existing sticky sidebar
            handles navigation. */}
        <header className="lg:hidden sticky top-0 z-20 bg-white border-b border-surface-200 h-14 pl-3 pr-4 flex items-center justify-between gap-3">
          <img src="/logo.png" alt="Minuto" className="h-10 w-auto -my-1 object-contain" />
          <button
            onClick={() => setSidebarOpen(true)}
            className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-surface-700 transition-transform duration-150 active:scale-95"
            aria-label="פתיחת תפריט"
            aria-expanded={sidebarOpen}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
        </header>
        <main className="flex-1 px-4 pt-5 pb-10 lg:px-10 lg:pt-7 lg:pb-14 lg:max-w-[1240px] min-w-0">
          {children}
        </main>
      </div>
    </div>
  )
}

// Each top-level page is wrapped in its own ErrorBoundary so a render
// crash in one page can't take down the whole app. Neighboring routes
// keep working and the user sees a scoped error message instead of a
// blank page.
function Page({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <Layout>
      <ErrorBoundary sectionName={name}>{children}</ErrorBoundary>
    </Layout>
  )
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useUser()
  const { getToken } = useAuth()

  // Set during render, not in an effect: children's effects run before this
  // component's, so an effect would let the first data fetches go out without
  // the user's token. Assigning a module variable is idempotent and safe here.
  setClerkTokenGetter(
    isLoaded && isSignedIn
      ? async () => (await getToken({ template: 'supabase' })) ?? null
      : null,
  )

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen" dir="rtl">
        <div className="text-surface-500">טוען...</div>
      </div>
    )
  }

  if (!isSignedIn) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-[#F7F6F2]" dir="rtl">
        <img src="/logo.png" alt="Minuto" className="h-[104px] w-auto object-contain" />
        <p className="text-sm text-surface-500 mt-1 mb-6">מערכת שיווק ותוכן</p>
        <SignIn appearance={{ elements: { rootBox: { direction: 'rtl' }, card: { direction: 'rtl', boxShadow: 'none', border: '1px solid #E6E3DB' } } }} />
      </div>
    )
  }

  return <>{children}</>
}

export default function App() {
  return (
    <AuthGate>
      <AppProvider>
        <BrowserRouter>
          <Routes>
            {/* OAuth callbacks — no sidebar, no boundary (trivial pages) */}
            <Route path="/auth/meta/callback" element={<MetaCallback />} />
            <Route path="/auth/google/callback" element={<GoogleCallback />} />

            {/* Admin SEO Agent — isolated layout, no global nav. AuthGate
                above still applies, but the dashboard Layout/Sidebar is
                intentionally skipped so this page can move to a separate
                subapp later without ripping out shared chrome. */}
            <Route path="/admin/seo-agent" element={<SeoAgentPage />} />

            {/* Main app — each route isolated by its own ErrorBoundary.
                /plan is the home page; /advisor still redirects there because
                older advisor emails link to it. */}
            <Route path="/"                element={<Navigate to="/plan" replace />} />
            <Route path="/advisor"         element={<Navigate to="/plan" replace />} />
            <Route path="/meta"            element={<Page name="Meta אורגני"><MetaOrganicPage /></Page>} />
            <Route path="/ads"             element={<Page name="Meta Ads"><MetaAdsPage /></Page>} />
            <Route path="/google-organic"  element={<Page name="Google אורגני"><GoogleOrganicPage /></Page>} />
            <Route path="/plan"            element={<Page name="תוכנית שיווק"><UnifiedPlanPage /></Page>} />
            <Route path="/marketing"       element={<Page name="מחולל מיילים"><MarketingPage /></Page>} />
            <Route path="/reels"           element={<Page name="רילס מוצרים"><ReelsPage /></Page>} />
            <Route path="/settings"        element={<Page name="הגדרות"><SettingsPage /></Page>} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </AuthGate>
  )
}
