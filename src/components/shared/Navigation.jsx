import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { UserButton, useUser } from '@clerk/clerk-react';
import { useApp } from '../../lib/context';

const allNavItems = [
  { path: '/dashboard', icon: '📊', label: 'Dashboard' },
  {
    label: 'Production', icon: '☕', children: [
      { path: '/origins',  icon: '🌱', label: 'Origins'  },
      { path: '/roasting', icon: '🔥', label: 'Roasting' },
      { path: '/products', icon: '📦', label: 'Products' },
    ],
  },
  {
    label: 'Operations', icon: '🏪', adminOnly: true, children: [
      { path: '/tasks',     icon: '📋', label: 'Tasks'     },
      { path: '/schedule',  icon: '📅', label: 'Schedule'  },
      { path: '/purchases', icon: '🛒', label: 'Purchases' },
    ],
  },
  { path: '/marketing', icon: '📧', label: 'Marketing', adminOnly: true },
  { path: '/settings',  icon: '⚙️', label: 'Settings',  adminOnly: true },
];

function NavDropdown({ item, badges }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();

  const isChildActive = item.children.some(c => location.pathname === c.path);

  // Close on route change
  useEffect(() => { setOpen(false); }, [location.pathname]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="nav-dropdown" style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        className={`nav-item${isChildActive ? ' active' : ''}`}
        style={{ border: 'none', cursor: 'pointer' }}
      >
        <span className="nav-icon">{item.icon}</span>
        <span className="nav-label">{item.label}</span>
        <span style={{ fontSize: '0.6rem', marginRight: '2px', opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: '50%',
          transform: 'translateX(50%)',
          marginTop: '6px',
          background: 'white',
          borderRadius: '10px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
          padding: '6px',
          minWidth: '160px',
          zIndex: 200,
        }}>
          {item.children.map(child => (
            <NavLink
              key={child.path}
              to={child.path}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                textDecoration: 'none',
                fontSize: '0.88rem',
                fontWeight: 600,
                color: isActive ? '#3D4A2E' : '#555',
                background: isActive ? '#EBEFE2' : 'transparent',
                transition: 'background 0.15s',
              })}
              onMouseEnter={e => {
                if (!e.currentTarget.classList.contains('active')) {
                  e.currentTarget.style.background = '#F4F7EE';
                }
              }}
              onMouseLeave={e => {
                if (!e.currentTarget.classList.contains('active')) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
            >
              <span style={{ fontSize: '1.05rem' }}>{child.icon}</span>
              <span>{child.label}</span>
              {badges[child.path] && (
                <span style={{
                  background: badges[child.path].color,
                  color: 'white',
                  borderRadius: '10px',
                  fontSize: '0.7rem',
                  fontWeight: '700',
                  padding: '1px 6px',
                  marginRight: 'auto',
                  lineHeight: '1.4',
                }}>
                  {badges[child.path].count}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Navigation() {
  const { data, isAdmin } = useApp();

  const pendingTasks = (data.waitingCustomers || []).filter(wc => !wc.notified_at).length;
  const pendingEmployees = (data.employees || []).filter(e => e.user_id === 'pending').length;

  const badges = {};
  if (pendingTasks > 0) badges['/tasks'] = { count: pendingTasks, color: '#DC2626' };
  if (pendingEmployees > 0) badges['/schedule'] = { count: pendingEmployees, color: '#F59E0B' };

  // Filter nav items based on role
  const navItems = allNavItems.filter(item => !item.adminOnly || isAdmin);

  return (
    <nav className="navbar">
      {/* Brand / Logo */}
      <div className="nav-brand">
        <div style={{
          background: 'white',
          borderRadius: '10px',
          padding: '3px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
        }}>
          <img
            src="/New_logo.pdf.png"
            alt="Minuto Café Roastery"
            className="nav-brand-logo"
            style={{ height: '36px', width: 'auto', objectFit: 'contain' }}
          />
        </div>
      </div>

      {/* Nav items */}
      <div className="nav-menu">
        {navItems.map(item =>
          item.children ? (
            <NavDropdown key={item.label} item={item} badges={badges} />
          ) : (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {badges[item.path] && (
                <span style={{
                  background: badges[item.path].color,
                  color: 'white',
                  borderRadius: '10px',
                  fontSize: '0.7rem',
                  fontWeight: '700',
                  padding: '1px 6px',
                  marginRight: '4px',
                  lineHeight: '1.4',
                }}>
                  {badges[item.path].count}
                </span>
              )}
            </NavLink>
          )
        )}
      </div>

      {/* User button */}
      <div style={{ paddingLeft: '0.5rem' }}>
        <UserButton afterSignOutUrl="/" />
      </div>
    </nav>
  );
}
