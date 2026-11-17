import React, { useEffect, useRef } from 'react';
import { Toaster } from 'sonner';
import './App.css';
import { SignIn, useUser } from '@clerk/clerk-react';
import MfaGate                from './components/shared/MfaGate';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';

import { AppProvider, useApp } from './lib/context';
import Navigation              from './components/shared/Navigation';
import Dashboard               from './components/dashboard/Dashboard';
import Origins                 from './components/origins/Origins';
import Roasting                from './components/roasting/Roasting';
import Products                from './components/products/Products';
import Packaging               from './components/packaging/Packaging';
import Settings                from './components/settings/Settings';
import Tasks                   from './components/tasks/Tasks';
import Schedule                from './components/schedule/Schedule';
import Attendance              from './components/attendance/Attendance';
import ChecklistEditor         from './components/checklist/ChecklistEditor';
import RoastChecklist          from './components/checklist/RoastChecklist';
import VehicleLog              from './components/vehicle/VehicleLog';
import SupplierInvoices        from './components/invoices/SupplierInvoices';

// ── Inner content (rendered only when signed in) ──────────────────────────────

function AdminRoute({ children }) {
  const { isAdmin, roleLoading } = useApp();
  if (roleLoading) return null;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return children;
}

function ScheduleRoute({ children }) {
  const { canSchedule, roleLoading } = useApp();
  if (roleLoading) return null;
  if (!canSchedule) return <Navigate to="/dashboard" replace />;
  return children;
}

function SagieOnlyRoute({ children }) {
  const { user, roleLoading } = useApp();
  if (roleLoading) return null;
  const email = user?.primaryEmailAddress?.emailAddress;
  if (email !== 'sagieelbaz@gmail.com') return <Navigate to="/dashboard" replace />;
  return children;
}

function AppContent() {
  const { refreshAll, userRole, roleLoading } = useApp();
  // The outside bookkeeper sees the supplier-invoices page and nothing else.
  // RLS is what actually keeps them out of the rest; this keeps the UI honest.
  const isBookkeeper = userRole === 'bookkeeper';
  const location = useLocation();
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip the very first mount — data already loaded by context
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    refreshAll();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app-shell">
      <Navigation />

      <main className="app-main">
      <Routes>
        {roleLoading ? null : isBookkeeper ? (
          <Route path="*" element={
            <div className="container">
              <Routes>
                <Route path="/invoices" element={<SupplierInvoices />} />
                <Route path="*"         element={<Navigate to="/invoices" replace />} />
              </Routes>
            </div>
          } />
        ) : (<>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        {/* All other pages use the standard container */}
        <Route path="*" element={
          <div className="container">
            <Routes>
              <Route path="/dashboard"  element={<Dashboard />} />
              <Route path="/origins"    element={<Origins />} />
              <Route path="/roasting"   element={<Roasting />} />
              <Route path="/products"   element={<Products />} />
              <Route path="/packaging"  element={<Packaging />} />
              <Route path="/tasks"      element={<AdminRoute><Tasks /></AdminRoute>} />
              <Route path="/schedule"   element={<ScheduleRoute><Schedule /></ScheduleRoute>} />
              <Route path="/attendance" element={<ScheduleRoute><Attendance /></ScheduleRoute>} />
              <Route path="/vehicle-log"  element={<AdminRoute><VehicleLog /></AdminRoute>} />
              <Route path="/invoices"   element={<SupplierInvoices />} />

              <Route path="/settings"          element={<AdminRoute><Settings /></AdminRoute>} />
              <Route path="/checklist"        element={<RoastChecklist />} />
              <Route path="/checklist-editor" element={<SagieOnlyRoute><ChecklistEditor /></SagieOnlyRoute>} />
              <Route path="*"                 element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </div>
        } />
        </>)}
      </Routes>
      </main>

      <Toaster dir="rtl" position="top-right" richColors closeButton duration={4000} />
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function App() {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return (
      <div className="auth-screen">
        <div className="text-muted">טוען...</div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <img src="/New_logo.pdf.png" alt="Minuto Café Roastery" className="auth-logo" />
          <p className="auth-sub">מערכת ניהול פנימית</p>
          <SignIn appearance={{ elements: { rootBox: { direction: 'rtl' }, card: { direction: 'rtl', boxShadow: 'none', border: '1px solid #E6E3DB' } } }} />
        </div>
      </div>
    );
  }

  return (
    <MfaGate>
      <BrowserRouter>
        <AppProvider>
          <AppContent />
        </AppProvider>
      </BrowserRouter>
    </MfaGate>
  );
}
