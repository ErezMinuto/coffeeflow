import React, { useState, useEffect } from 'react';
import './App.css';
import { 
  SignIn, 
  UserButton, 
  useUser,
  useAuth 
} from '@clerk/clerk-react';
import { supabase, setSupabaseToken } from './lib/supabase';
import { useSupabaseData, useCostSettings } from './lib/hooks';

// Import all components
import Dashboard from './components/Dashboard';
import Origins from './components/Origins';
import Roasting from './components/Roasting';
import Products from './components/Products';
import Settings from './components/Settings';

function App() {
  const { isLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const [currentPage, setCurrentPage] = useState('dashboard');
  
  // Load data from Supabase using custom hooks
  const originsDb = useSupabaseData('origins');
  const productsDb = useSupabaseData('products');
  const roastsDb = useSupabaseData('roasts');
  const operatorsDb = useSupabaseData('operators');
  const { settings: costSettings, updateSettings: updateCostSettings } = useCostSettings();

  // Initialize Supabase session with Clerk token
  useEffect(() => {
    if (isSignedIn && getToken) {
      setSupabaseToken(getToken);
    }
  }, [isSignedIn, getToken]);

  // Show loading screen
  if (!isLoaded) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        direction: 'rtl'
      }}>
        <div>טוען...</div>
      </div>
    );
  }

  // Show sign in if not authenticated
  if (!isSignedIn) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        flexDirection: 'column',
        gap: '2rem',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
      }}>
        <div style={{
          background: 'white',
          padding: '2rem',
          borderRadius: '12px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          textAlign: 'center',
          direction: 'rtl'
        }}>
          <h1 style={{ marginBottom: '1rem', color: '#6F4E37' }}>
            ☕ CoffeeFlow
          </h1>
          <p style={{ marginBottom: '2rem', color: '#666' }}>
            מערכת ניהול ייצור קפה
          </p>
          <SignIn 
            appearance={{
              elements: {
                rootBox: { direction: 'rtl' },
                card: { direction: 'rtl' }
              }
            }}
          />
        </div>
      </div>
    );
  }

  // Main app
  return (
    <MainApp 
      user={user}
      currentPage={currentPage}
      setCurrentPage={setCurrentPage}
      originsDb={originsDb}
      productsDb={productsDb}
      roastsDb={roastsDb}
      operatorsDb={operatorsDb}
      costSettings={costSettings}
      updateCostSettings={updateCostSettings}
    />
  );
}

// Main App Component
function MainApp({ 
  user, 
  currentPage, 
  setCurrentPage, 
  originsDb, 
  productsDb, 
  roastsDb, 
  operatorsDb, 
  costSettings,
  updateCostSettings 
}) {
  
  // Navigation Component
  const Navigation = () => {
    const menuItems = [
      { id: 'dashboard', icon: '📊', label: 'דשבורד' },
      { id: 'origins', icon: '🌱', label: 'זנים' },
      { id: 'roasting', icon: '🔥', label: 'קלייה' },
      { id: 'products', icon: '📦', label: 'מוצרים' },
      { id: 'settings', icon: '⚙️', label: 'הגדרות' }
    ];

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
            <button
              key={item.id}
              className={`nav-item ${currentPage === item.id ? 'active' : ''}`}
              onClick={() => setCurrentPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </div>
        <div style={{ marginRight: 'auto', paddingLeft: '1rem' }}>
          <UserButton afterSignOutUrl="/" />
        </div>
      </nav>
    );
  };

  // Props to pass to all components
  const componentProps = {
    user,
    data: {
      origins: originsDb.data || [],
      products: productsDb.data || [],
      roasts: roastsDb.data || [],
      operators: operatorsDb.data || [],
      costSettings: costSettings || {}
    },
    originsDb,
    productsDb,
    roastsDb,
    operatorsDb,
    costSettings,
    updateCostSettings
  };

  return (
    <div className="App" style={{ direction: 'rtl' }}>
      <Navigation />
      <div className="container">
        {currentPage === 'dashboard' && <Dashboard {...componentProps} />}
        {currentPage === 'origins' && <Origins {...componentProps} />}
        {currentPage === 'roasting' && <Roasting {...componentProps} />}
        {currentPage === 'products' && <Products {...componentProps} />}
        {currentPage === 'settings' && <Settings {...componentProps} />}
      </div>
    </div>
  );
}

export default App;
