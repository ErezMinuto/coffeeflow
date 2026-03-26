import React from 'react';
import { NavLink } from 'react-router-dom';
import { UserButton, useUser } from '@clerk/clerk-react';

const menuItems = [
  { path: '/dashboard',  icon: '📊', label: 'Dashboard'  },
  { path: '/origins',    icon: '🌱', label: 'Origins'    },
  { path: '/roasting',   icon: '🔥', label: 'Roasting'   },
  { path: '/products',   icon: '📦', label: 'Products'   },
  { path: '/purchases',  icon: '🛒', label: 'Purchases'  },
  { path: '/settings',   icon: '⚙️', label: 'Settings'   },
];

export default function Navigation() {
  const { user } = useUser();

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
        {menuItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </NavLink>
        ))}
      </div>

      <div style={{ marginRight: 'auto', paddingLeft: '1rem' }}>
        <UserButton afterSignOutUrl="/" />
      </div>
    </nav>
  );
}
