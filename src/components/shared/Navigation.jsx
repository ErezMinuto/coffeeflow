import React from 'react';
import { NavLink } from 'react-router-dom';
import { UserButton, useUser } from '@clerk/clerk-react';
import { useApp } from '../../lib/context';

const staticItems = [
  { path: '/dashboard',  icon: '📊', label: 'Dashboard'  },
  { path: '/origins',    icon: '🌱', label: 'Origins'    },
  { path: '/roasting',   icon: '🔥', label: 'Roasting'   },
  { path: '/products',   icon: '📦', label: 'Products'   },
  { path: '/purchases',  icon: '🛒', label: 'Purchases'  },
  { path: '/tasks',      icon: '📋', label: 'Tasks'      },
  { path: '/schedule',   icon: '📅', label: 'Schedule'   },
  { path: '/marketing',  icon: '📧', label: 'Marketing'  },
  { path: '/settings',   icon: '⚙️', label: 'Settings'   },
];

export default function Navigation() {
  const { user } = useUser();
  const { data }  = useApp();

  const pendingTasks      = (data.waitingCustomers || []).filter(wc => !wc.notified_at).length;
  const pendingEmployees  = (data.employees || []).filter(e => e.user_id === 'pending').length;

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
        {staticItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.path === '/tasks' && pendingTasks > 0 && (
              <span style={{
                background: '#DC2626', color: 'white',
                borderRadius: '10px', fontSize: '0.7rem', fontWeight: '700',
                padding: '1px 6px', marginRight: '4px', lineHeight: '1.4'
              }}>
                {pendingTasks}
              </span>
            )}
            {item.path === '/schedule' && pendingEmployees > 0 && (
              <span style={{
                background: '#F59E0B', color: 'white',
                borderRadius: '10px', fontSize: '0.7rem', fontWeight: '700',
                padding: '1px 6px', marginRight: '4px', lineHeight: '1.4'
              }}>
                {pendingEmployees}
              </span>
            )}
          </NavLink>
        ))}
      </div>

      {/* User button */}
      <div style={{ paddingLeft: '0.5rem' }}>
        <UserButton afterSignOutUrl="/" />
      </div>
    </nav>
  );
}
