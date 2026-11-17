import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { UserButton, useUser } from '@clerk/clerk-react';
import {
  LayoutGrid, Sprout, Flame, Coffee, Package, ListChecks, CalendarDays,
  Clock, Car, Receipt, Settings, ClipboardPen, Menu, X,
} from 'lucide-react';
import { useApp } from '../../lib/context';

// Sidebar structure. Visibility flags are unchanged from the old top navbar:
//   scheduleOnly → admins + schedule_manager   |   adminOnly → admins only   |   else everyone
const allNavGroups = [
  { items: [
    { path: '/dashboard', icon: LayoutGrid, label: 'סקירה' },
  ] },
  { label: 'ייצור', items: [
    { path: '/origins',   icon: Sprout,  label: 'זנים'   },
    { path: '/roasting',  icon: Flame,   label: 'קלייה'  },
    { path: '/products',  icon: Coffee,  label: 'מוצרים' },
    { path: '/packaging', icon: Package, label: 'אריזה'  },
  ] },
  { label: 'תפעול', items: [
    { path: '/tasks',       icon: ListChecks,   label: 'משימות',         adminOnly:    true },
    { path: '/schedule',    icon: CalendarDays, label: 'סידור עבודה',    scheduleOnly: true },
    { path: '/attendance',  icon: Clock,        label: 'נוכחות',         scheduleOnly: true },
    { path: '/vehicle-log', icon: Car,          label: 'יומן רכב',       adminOnly:    true },
    { path: '/invoices',    icon: Receipt,      label: 'חשבוניות ספקים' },
  ] },
  { items: [
    { path: '/settings', icon: Settings, label: 'הגדרות', adminOnly: true },
  ] },
];

const ROLE_LABELS = {
  admin:            'הרשאת ניהול',
  schedule_manager: 'ניהול סידור עבודה',
  employee:         'צוות',
  bookkeeper:       'הנהלת חשבונות',
};

function NavItem({ item, badge }) {
  const Icon = item.icon;
  return (
    <NavLink to={item.path} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
      <Icon size={18} aria-hidden="true" />
      <span>{item.label}</span>
      {badge && <span className={`nav-count ${badge.tone}`}>{badge.count}</span>}
    </NavLink>
  );
}

export default function Navigation() {
  const { data, isAdmin, canSchedule, userRole } = useApp();
  const isBookkeeper = userRole === 'bookkeeper';
  const { user } = useUser();
  const isSagie = user?.primaryEmailAddress?.emailAddress === 'sagieelbaz@gmail.com';
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const closeButtonRef = useRef(null);

  const canSee = item =>
    item.scheduleOnly ? canSchedule
    : item.adminOnly  ? isAdmin
    : true;

  const pendingTasks = (data.waitingCustomers || []).filter(wc => !wc.notified_at).length;
  const pendingEmployees = (data.employees || []).filter(e => e.user_id === 'pending').length;

  const badges = {};
  if (pendingTasks > 0) badges['/tasks'] = { count: pendingTasks, tone: 'danger' };
  if (pendingEmployees > 0) badges['/schedule'] = { count: pendingEmployees, tone: 'warn' };

  // Filter groups by role and drop any group left with nothing visible.
  const groups = isBookkeeper
    ? [{ items: [{ path: '/invoices', icon: Receipt, label: 'חשבוניות ספקים' }] }]
    : [
        ...allNavGroups
          .map(g => ({ ...g, items: g.items.filter(canSee) }))
          .filter(g => g.items.length),
        ...(isSagie ? [{ items: [{ path: '/checklist-editor', icon: ClipboardPen, label: 'עריכת צ׳קליסט' }] }] : []),
      ];

  // The phone drawer closes on navigation and on Escape.
  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { setOpen(false); menuButtonRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const displayName = user?.firstName || user?.fullName || user?.primaryEmailAddress?.emailAddress || '';
  const roleLabel = ROLE_LABELS[userRole] || '';

  return (
    <>
      <header className="mobile-top">
        <img src="/New_logo.pdf.png" alt="Minuto" />
        <div className="mobile-top-end">
          <UserButton afterSignOutUrl="/" />
          <button
            ref={menuButtonRef}
            type="button"
            className="btn-icon"
            onClick={() => setOpen(true)}
            aria-label="פתיחת תפריט"
            aria-expanded={open}
            aria-controls="app-sidebar"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={`side-scrim${open ? ' open' : ''}`} onClick={() => setOpen(false)} aria-hidden="true" />

      <aside id="app-sidebar" className={`side${open ? ' open' : ''}`} aria-label="ניווט ראשי">
        <div className="side-brand">
          <img src="/New_logo.pdf.png" alt="Minuto Café Roastery" />
          <button ref={closeButtonRef} type="button" className="btn-icon side-close" onClick={() => setOpen(false)} aria-label="סגירת תפריט">
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        {groups.map((group, i) => (
          <nav className="nav-group" key={group.label || i} aria-label={group.label}>
            {group.label && <div className="nav-group-label">{group.label}</div>}
            {group.items.map(item => (
              <NavItem key={item.path} item={item} badge={badges[item.path]} />
            ))}
          </nav>
        ))}

        <div className="side-user">
          <UserButton afterSignOutUrl="/" />
          <div>
            <div className="side-user-name">{displayName}</div>
            {roleLabel && <div className="side-user-role">{roleLabel}</div>}
          </div>
        </div>
      </aside>
    </>
  );
}
