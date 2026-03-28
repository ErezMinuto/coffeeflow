import React from 'react';
import './App.css';
import { SignIn, useUser } from '@clerk/clerk-react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { AppProvider, useApp } from './lib/context';
import Navigation              from './components/shared/Navigation';
import Dashboard               from './components/dashboard/Dashboard';
import Origins                 from './components/origins/Origins';
import Roasting                from './components/roasting/Roasting';
import Products                from './components/products/Products';
import Purchases               from './components/purchases/Purchases';
import Settings                from './components/settings/Settings';
import Tasks                   from './components/tasks/Tasks';
import Schedule                from './components/schedule/Schedule';

// ── Inner content (rendered only when signed in) ──────────────────────────────

function AppContent() {
  const { toasts } = useApp();

  return (
    <>
      <Navigation />

      <div className="container" style={{ direction: 'rtl' }}>
        <Routes>
          <Route path="/"           element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard"  element={<Dashboard />} />
          <Route path="/origins"    element={<Origins />} />
          <Route path="/roasting"   element={<Roasting />} />
          <Route path="/products"   element={<Products />} />
          <Route path="/purchases"  element={<Purchases />} />
          <Route path="/tasks"      element={<Tasks />} />
          <Route path="/schedule"   element={<Schedule />} />
          <Route path="/settings"   element={<Settings />} />
          <Route path="*"           element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>

      {/* Toast notifications */}
      <div style={{ position: 'fixed', top: '20px', right: '20px', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {toasts.map(toast => (
          <div
            key={toast.id}
            style={{
              background: toast.type === 'success' ? '#10B981' : toast.type === 'error' ? '#DC2626' : '#F59E0B',
              color: 'white',
              padding: '1rem 1.5rem',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              minWidth: '300px',
              maxWidth: '500px',
              animation: 'slideIn 0.3s ease-out',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              fontSize: '0.95rem',
              fontWeight: '500'
            }}
          >
            <span style={{ fontSize: '1.2rem' }}>
              {toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : '⚠️'}
            </span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function App() {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', direction: 'rtl' }}>
        <div>טוען...</div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', flexDirection: 'column', gap: '2rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
        <div style={{ background: 'white', padding: '2rem', borderRadius: '12px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', textAlign: 'center', direction: 'rtl' }}>
          <h1 style={{ marginBottom: '1rem', color: '#6F4E37' }}>☕ CoffeeFlow</h1>
          <p style={{ marginBottom: '2rem', color: '#666' }}>מערכת ניהול ייצור קפה</p>
          <SignIn appearance={{ elements: { rootBox: { direction: 'rtl' }, card: { direction: 'rtl' } } }} />
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </BrowserRouter>
  );
}
