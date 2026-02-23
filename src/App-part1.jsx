import React, { useState, useEffect, useMemo } from 'react';
import './App.css';
import { 
  SignIn, 
  SignUp, 
  UserButton, 
  useUser,
  useAuth 
} from '@clerk/clerk-react';
import { setSupabaseToken } from './lib/supabase';
import { useSupabaseData, useCostSettings } from './lib/hooks';

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

  // Main app data state (for backward compatibility with existing components)
  const data = {
    origins: originsDb.data || [],
    products: productsDb.data || [],
    roasts: roastsDb.data || [],
    operators: operatorsDb.data || [],
    costSettings: costSettings || {}
  };

  // Helper functions
  const calculateRoastedWeight = (greenWeight, weightLossPercent) => {
    return (greenWeight * (1 - weightLossPercent / 100)).toFixed(1);
  };

  const getOriginById = (id) => {
    return data.origins.find(o => o.id === id);
  };

  const calculateProductCost = (product, breakdown = false) => {
    const settings = costSettings || {
      bag_330g: 0.70,
      bag_250g: 0.60,
      bag_1000g: 2.00,
      label: 0.08,
      gas_per_roast: 10.00,
      labor_per_hour: 60,
      roasting_time_minutes: 17,
      packaging_time_minutes: 0.5,
      batch_size_kg: 15
    };

    // 1. עלות פולים קלויים
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

    // 2. עלות גז - מחולק לפי כמות שקיות מקלייה
    const avgWeightLoss = product.recipe.reduce((sum, ing) => {
      const origin = getOriginById(ing.originId);
      return sum + (origin ? origin.weight_loss * (ing.percentage / 100) : 0);
    }, 0);
    const roastedKgPerRoast = settings.batch_size_kg * (1 - avgWeightLoss / 100);
    const bagsPerRoast = (roastedKgPerRoast * 1000) / product.size;
    const gasCost = settings.gas_per_roast / bagsPerRoast;

    // 3. עלות עבודה - קלייה
    const roastingLaborPerRoast = (settings.labor_per_hour / 60) * settings.roasting_time_minutes;
    const roastingLabor = roastingLaborPerRoast / bagsPerRoast;

    // 4. עלות עבודה - אריזה
    const packagingLabor = (settings.labor_per_hour / 60) * settings.packaging_time_minutes;

    // 5. עלות אריזה
    let packagingCost = settings.label;
    if (product.size === 250) packagingCost += settings.bag_250g;
    else if (product.size === 330) packagingCost += settings.bag_330g;
    else if (product.size === 1000) packagingCost += settings.bag_1000g;
    else packagingCost += settings.bag_330g;

    // סה"כ
    const totalCost = beansCost + gasCost + roastingLabor + packagingLabor + packagingCost;

    if (breakdown) {
      return {
        beansCost: beansCost.toFixed(2),
        gasCost: gasCost.toFixed(2),
        roastingLabor: roastingLabor.toFixed(2),
        packagingLabor: packagingLabor.toFixed(2),
        packagingCost: packagingCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
        bagsPerRoast: bagsPerRoast.toFixed(1)
      };
    }

    return totalCost.toFixed(2);
  };

  // Components will go here...
  // (continuing in next part)

  return (
    <div className="App" style={{ direction: 'rtl' }}>
      <Navigation />
      <div className="container">
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'origins' && <Origins />}
        {currentPage === 'roasting' && <Roasting />}
        {currentPage === 'products' && <Products />}
        {currentPage === 'settings' && <Settings />}
      </div>
    </div>
  );
}

export default App;
