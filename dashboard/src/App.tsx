import { BrowserRouter, Routes, Route } from 'react-router-dom'
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

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen" dir="rtl">
      <Sidebar />
      <main className="flex-1 p-8 max-w-6xl">
        {children}
      </main>
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

export default function App() {
  return (
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
  )
}
