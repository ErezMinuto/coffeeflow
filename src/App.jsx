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
import Marketing               from './components/marketing/Marketing';

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
          <Route path="/marketing"  element={<Marketing />} />
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
      <div style={{
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        height: '100vh', flexDirection: 'column', gap: '2rem',
        background: 'linear-gradient(160deg, #3D4A2E 0%, #556B3A 50%, #6A7D45 100%)',
      }}>
        <div style={{
          background: 'white', padding: '2.5rem 2rem', borderRadius: '20px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)', textAlign: 'center',
          direction: 'rtl', maxWidth: '420px', width: '90%',
        }}>
          <img
            src="/New_logo.pdf.png"
            alt="Minuto Café Roastery"
            style={{ height: '120px', width: 'auto', objectFit: 'contain', marginBottom: '0.5rem' }}
          />
          <p style={{ marginBottom: '1.75rem', color: '#8CA870', fontSize: '0.9rem', fontWeight: 500 }}>
            מערכת ניהול פנימית
          </p>
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
