import React, { useState, useEffect } from 'react';
import './App.css';
import { SignIn, UserButton, useUser, useAuth } from '@clerk/clerk-react';
import { supabase, setSupabaseToken } from './lib/supabase';
import { useSupabaseData, useCostSettings } from './lib/hooks';

function App() {
  const { isLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const [currentPage, setCurrentPage] = useState('dashboard');
  
  const originsDb = useSupabaseData('origins');
  const productsDb = useSupabaseData('products');
  const roastsDb = useSupabaseData('roasts');
  const operatorsDb = useSupabaseData('operators');
  const { settings: costSettings, updateSettings: updateCostSettings } = useCostSettings();

  useEffect(() => {
    if (isSignedIn && getToken) {
      setSupabaseToken(getToken);
    }
  }, [isSignedIn, getToken]);

  if (!isLoaded) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', direction: 'rtl' }}><div>טוען...</div></div>;
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

  const data = {
    origins: originsDb.data || [],
    products: productsDb.data || [],
    roasts: roastsDb.data || [],
    operators: operatorsDb.data || [],
    costSettings: costSettings || {}
  };

  const calculateRoastedWeight = (greenWeight, weightLossPercent) => {
    return (greenWeight * (1 - weightLossPercent / 100)).toFixed(1);
  };

  const getOriginById = (id) => {
    return data.origins.find(o => o.id === id);
  };

  const calculateProductCost = (product, breakdown = false) => {
    const settings = costSettings || { bag_330g: 0.70, bag_250g: 0.60, bag_1000g: 2.00, label: 0.08, gas_per_roast: 10.00, labor_per_hour: 60, roasting_time_minutes: 17, packaging_time_minutes: 0.5, batch_size_kg: 15 };
    let beansCost = 0;
    product.recipe.forEach(ingredient => {
      const origin = getOriginById(ingredient.originId);
      if (origin) {
        const weight = (product.size / 1000) * (ingredient.percentage / 100);
        const yieldPercent = 1 - (origin.weight_loss / 100);
        const costPerKgRoasted = origin.cost_per_kg / yieldPercent;
        beansCost += weight * costPerKgRoasted;
      }
    });
    const avgWeightLoss = product.recipe.reduce((sum, ing) => {
      const origin = getOriginById(ing.originId);
      return sum + (origin ? origin.weight_loss * (ing.percentage / 100) : 0);
    }, 0);
    const roastedKgPerRoast = settings.batch_size_kg * (1 - avgWeightLoss / 100);
    const bagsPerRoast = (roastedKgPerRoast * 1000) / product.size;
    const gasCost = settings.gas_per_roast / bagsPerRoast;
    const roastingLaborPerRoast = (settings.labor_per_hour / 60) * settings.roasting_time_minutes;
    const roastingLabor = roastingLaborPerRoast / bagsPerRoast;
    const packagingLabor = (settings.labor_per_hour / 60) * settings.packaging_time_minutes;
    let packagingCost = settings.label;
    if (product.size === 250) packagingCost += settings.bag_250g;
    else if (product.size === 330) packagingCost += settings.bag_330g;
    else if (product.size === 1000) packagingCost += settings.bag_1000g;
    else packagingCost += settings.bag_330g;
    const totalCost = beansCost + gasCost + roastingLabor + packagingLabor + packagingCost;
    if (breakdown) {
      return { beansCost: beansCost.toFixed(2), gasCost: gasCost.toFixed(2), roastingLabor: roastingLabor.toFixed(2), packagingLabor: packagingLabor.toFixed(2), packagingCost: packagingCost.toFixed(2), totalCost: totalCost.toFixed(2), bagsPerRoast: bagsPerRoast.toFixed(1) };
    }
    return totalCost.toFixed(2);
  };

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
          {user && <div style={{ fontSize: '0.875rem', color: '#999' }}>{user.primaryEmailAddress?.emailAddress}</div>}
        </div>
        <div className="nav-menu">
          {menuItems.map(item => (
            <button key={item.id} className={`nav-item ${currentPage === item.id ? 'active' : ''}`} onClick={() => setCurrentPage(item.id)}>
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

  const Dashboard = () => {
    const resetData = async () => {
