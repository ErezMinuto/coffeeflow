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
  { path: '/settings',   icon: '⚙️', label: 'Settings'   },
];

export default function Navigation() {
  const { user } = useUser();
  const { data }  = useApp();

  const pendingTasks = (data.waitingCustomers || []).filter(wc => !wc.notified_at).length;

  return (
    <nav className="navbar">
      <div className="nav-brand">
        <h2>☕ CoffeeFlow</h2>
        {user && (
          <div style={{ fontSize: '0.875rem', color: '#999' }}>
            {user.primaryEmailAddress?.emailAddress}
          </div>
        )}
      </div>

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
          </NavLink>
        ))}
      </div>

      <div style={{ marginRight: 'auto', paddingLeft: '1rem' }}>
        <UserButton afterSignOutUrl="/" />
      </div>
    </nav>
  );
}
