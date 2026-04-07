import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Sidebar } from './components/shared/Sidebar'
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

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          {/* OAuth callbacks — no sidebar */}
          <Route path="/auth/meta/callback" element={<MetaCallback />} />
          <Route path="/auth/google/callback" element={<GoogleCallback />} />

          {/* Main app */}
          <Route path="/" element={<Layout><OverviewPage /></Layout>} />
          <Route path="/meta" element={<Layout><MetaOrganicPage /></Layout>} />
          <Route path="/ads" element={<Layout><MetaAdsPage /></Layout>} />
          <Route path="/google" element={<Layout><GoogleAdsPage /></Layout>} />
          <Route path="/google-organic" element={<Layout><GoogleOrganicPage /></Layout>} />
          <Route path="/advisor" element={<Layout><AdvisorPage /></Layout>} />
          <Route path="/analyst" element={<Layout><AIAnalystPage /></Layout>} />
          <Route path="/marketing" element={<Layout><MarketingPage /></Layout>} />
          <Route path="/settings" element={<Layout><SettingsPage /></Layout>} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  )
}
