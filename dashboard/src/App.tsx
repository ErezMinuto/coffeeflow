import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { Menu } from 'lucide-react'
import { SignIn, useUser } from '@clerk/clerk-react'
import { Sidebar } from './components/shared/Sidebar'
import { ErrorBoundary } from './components/shared/ErrorBoundary'
import OverviewPage from './pages/Overview'
import MetaOrganicPage from './pages/MetaOrganic'
import MetaAdsPage from './pages/MetaAds'
import GoogleAdsPage from './pages/GoogleAds'
import SettingsPage from './pages/Settings'
import { MetaCallback, GoogleCallback } from './pages/OAuthCallback'
import AIAnalystPage from './pages/AIAnalyst'
import MarketingPage from './pages/Marketing'
import AdvisorPage from './pages/Advisor'
import GoogleOrganicPage from './pages/GoogleOrganic'
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
    <div className="flex min-h-screen overflow-x-hidden lg:overflow-x-visible" dir="rtl">
      {/* overflow-x-hidden on mobile clips the off-screen (translate-x-full)
          Sidebar drawer so its transform doesn't inflate document width and
          create phantom horizontal scroll. On `lg:` and up the sidebar is
          in-flow so clipping isn't needed. */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header — burger + wordmark, sticky top on mobile only.
            `lg:hidden` hides it on desktop so the existing sticky sidebar
            handles navigation. */}
        <header className="lg:hidden sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-surface-200 h-14 px-4 flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 -m-2 text-surface-700 hover:text-surface-900"
            aria-label="פתח תפריט"
          >
            <Menu size={22} />
          </button>
          <h1 className="font-display text-base font-semibold text-surface-900">Minuto</h1>
        </header>
        <main className="flex-1 p-4 lg:p-8 lg:max-w-6xl min-w-0">
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

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen" dir="rtl">
        <div className="text-surface-500">טוען...</div>
      </div>
    )
  }

  if (!isSignedIn) {
    return (
      <div
        className="flex flex-col items-center justify-center min-h-screen gap-8 p-6"
        style={{ background: 'linear-gradient(160deg, #3D4A2E 0%, #556B3A 50%, #6A7D45 100%)' }}
        dir="rtl"
      >
        <div className="bg-white rounded-3xl shadow-2xl p-8 w-full max-w-md text-center">
          <h1 className="font-display text-2xl font-semibold text-surface-900 mb-2">Minuto</h1>
          <p className="text-sm text-brand-600 font-medium mb-6">Marketing Dashboard</p>
          <SignIn appearance={{ elements: { rootBox: { direction: 'rtl' }, card: { direction: 'rtl', boxShadow: 'none' } } }} />
        </div>
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

            {/* Main app — each route isolated by its own ErrorBoundary */}
            <Route path="/"                element={<Page name="סקירה כללית"><OverviewPage /></Page>} />
            <Route path="/meta"            element={<Page name="Meta אורגני"><MetaOrganicPage /></Page>} />
            <Route path="/ads"             element={<Page name="Meta Ads"><MetaAdsPage /></Page>} />
            <Route path="/google"          element={<Page name="Google Ads"><GoogleAdsPage /></Page>} />
            <Route path="/google-organic"  element={<Page name="Google אורגני"><GoogleOrganicPage /></Page>} />
            <Route path="/advisor"         element={<Page name="יועץ שיווק"><AdvisorPage /></Page>} />
            <Route path="/analyst"         element={<Page name="אנליסט AI"><AIAnalystPage /></Page>} />
            <Route path="/marketing"       element={<Page name="Marketing"><MarketingPage /></Page>} />
            <Route path="/settings"        element={<Page name="הגדרות"><SettingsPage /></Page>} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </AuthGate>
  )
}
