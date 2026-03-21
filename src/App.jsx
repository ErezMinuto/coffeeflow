import React, { useState } from 'react';
import './App.css';
import { SignIn, UserButton, useUser } from '@clerk/clerk-react';
import { useSupabaseData, useCostSettings } from './lib/hooks';
import RoastingList from './components/RoastingList';
import MFlowSync from './MFlowSync'; 

function App() {
  const { isLoaded, isSignedIn, user } = useUser();
  const [currentPage, setCurrentPage] = useState('dashboard');
  
  // Toast notifications
  const [toasts, setToasts] = useState([]);
  const showToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  
  const [originsActiveForm, setOriginsActiveForm] = useState(null);
  
  const originsDb = useSupabaseData('origins');
  const productsDb = useSupabaseData('products');
  const roastsDb = useSupabaseData('roasts');
  const operatorsDb = useSupabaseData('operators');
  const { settings: costSettings, updateSettings: updateCostSettings } = useCostSettings();

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

  // Data object
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

  // Navigation Component
  const Navigation = () => {
    const menuItems = [
      { id: 'dashboard', icon: '📊', label: 'דשבורד' },
      { id: 'origins', icon: '🌱', label: 'זנים' },
      { id: 'roasting', icon: '🔥', label: 'קלייה' },
      { id: 'products', icon: '📦', label: 'מוצרים' },
      { id: 'mflow', icon: '🔄', label: 'MFlow' },
      { id: 'roasting-list', icon: '📋', label: 'רשימת קלייה' },
      { id: 'settings', icon: '⚙️', label: 'הגדרות' }
    ];
    return (
      <>
        {/* Desktop Navigation */}
        <nav className="navbar navbar-desktop">
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

        {/* Mobile Navigation - Bottom */}
        <nav className="navbar navbar-mobile">
          {menuItems.map(item => (
            <button key={item.id} className={`nav-item-mobile ${currentPage === item.id ? 'active' : ''}`} onClick={() => setCurrentPage(item.id)}>
              <span className="nav-icon-mobile">{item.icon}</span>
              <span className="nav-label-mobile">{item.label}</span>
            </button>
          ))}
        </nav>
      </>
    );
  };

  // Dashboard Component
  const Dashboard = () => {
    const lowStockOrigins = data.origins.filter(o => (o.stock || 0) < (o.min_stock || 10) && (o.stock || 0) > 0);
    const outOfStockOrigins = data.origins.filter(o => (o.stock || 0) === 0);

    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>📊 דשבורד ראשי</h1>
          <div style={{ display: 'flex', gap: '10px' }}>
            <UserButton />
          </div>
        </div>

        {/* Low Stock Alerts */}
        {(lowStockOrigins.length > 0 || outOfStockOrigins.length > 0) && (
          <div style={{ marginBottom: '1.5rem' }}>
            {outOfStockOrigins.length > 0 && (
              <div style={{ background: '#FEE2E2', border: '2px solid #DC2626', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
                <h3 style={{ color: '#DC2626', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  ❌ אזהרה: זנים ללא מלאי ({outOfStockOrigins.length})
                </h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {outOfStockOrigins.map(o => (
                    <span key={o.id} style={{ background: 'white', padding: '0.25rem 0.75rem', borderRadius: '4px', fontSize: '0.9rem', color: '#DC2626', fontWeight: 'bold' }}>
                      {o.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {lowStockOrigins.length > 0 && (
              <div style={{ background: '#FEF3C7', border: '2px solid #F59E0B', borderRadius: '8px', padding: '1rem' }}>
                <h3 style={{ color: '#D97706', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  ⚠️ מלאי נמוך - {lowStockOrigins.length} זנים
                </h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {lowStockOrigins.map(o => (
                    <span key={o.id} style={{ background: 'white', padding: '0.25rem 0.75rem', borderRadius: '4px', fontSize: '0.9rem', color: '#D97706' }}>
                      {o.name}: {o.stock} ק"ג
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="stats-grid">
          <div className="stat-card" onClick={() => setCurrentPage('origins')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon">🌱</div>
            <div className="stat-info">
              <div className="stat-label">זנים במלאי</div>
              <div className="stat-value">{data.origins.length}</div>
            </div>
          </div>
          <div className="stat-card" onClick={() => setCurrentPage('products')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon">📦</div>
            <div className="stat-info">
              <div className="stat-label">מוצרים</div>
              <div className="stat-value">{data.products.length}</div>
            </div>
          </div>
          <div className="stat-card" onClick={() => setCurrentPage('roasting')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon">🔥</div>
            <div className="stat-info">
              <div className="stat-label">קליות החודש</div>
              <div className="stat-value">{data.roasts.length}</div>
            </div>
          </div>
          <div className="stat-card" onClick={() => setCurrentPage('settings')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon">👥</div>
            <div className="stat-info">
              <div className="stat-label">מפעילים</div>
              <div className="stat-value">{data.operators.length}</div>
            </div>
          </div>
        </div>
        <div className="section">
          <h2>📈 סטטיסטיקות</h2>
          <div className="stats-details">
            <div className="stat-row"><span>סה"כ מלאי ירוק:</span><strong>{data.origins.reduce((sum, o) => sum + (o.stock || 0), 0).toFixed(1)} ק"ג</strong></div>
            <div className="stat-row"><span>ערך מלאי:</span><strong>₪{data.origins.reduce((sum, o) => sum + ((o.stock || 0) * (o.cost_per_kg || 0)), 0).toFixed(2)}</strong></div>
            <div className="stat-row"><span>איבוד משקל ממוצע:</span><strong>{data.origins.length > 0 ? (data.origins.reduce((sum, o) => sum + (o.weight_loss || 0), 0) / data.origins.length).toFixed(1) : 0}%</strong></div>
          </div>
        </div>
        {data.origins.length === 0 && (
          <div className="empty-state" style={{ marginTop: '2rem' }}>
            <h3>👋 ברוך הבא ל-CoffeeFlow!</h3>
            <p>לחץ על "➕ נתוני דוגמה" כדי להתחיל, או צור זנים ומוצרים משלך!</p>
          </div>
        )}
      </div>
    );
  };

  // Origins Component
  const Origins = ({ showToast, activeForm, setActiveForm }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [sortBy, setSortBy] = useState('name');
    const [editingOrigin, setEditingOrigin] = useState(null);
    const [newOrigin, setNewOrigin] = useState({ name: '', weightLoss: 20, costPerKg: '', stock: 0, minStock: 10, notes: '' });
    const [stockEntry, setStockEntry] = useState({ originId: '', quantity: '', notes: '' });
    const [stockOut, setStockOut] = useState({ originId: '', quantity: '', notes: '' });

    const addOrigin = async () => {
      if (!newOrigin.name || !newOrigin.costPerKg) { alert('⚠️ נא למלא שם ועלות'); return; }
      try {
        await originsDb.insert({ 
          name: newOrigin.name, 
          weight_loss: parseFloat(newOrigin.weightLoss), 
          cost_per_kg: parseFloat(newOrigin.costPerKg), 
          stock: parseFloat(newOrigin.stock) || 0, 
          roasted_stock: 0, 
          min_stock: parseFloat(editingOrigin.minStock) || 10,
          daily_average: parseFloat(editingOrigin.dailyAverage) || 0,
          notes: editingOrigin.notes, 
        });
        await originsDb.refresh();
        setNewOrigin({ name: '', weightLoss: 20, costPerKg: '', stock: 0, minStock: 10, notes: '' });
        alert('✅ זן נוסף בהצלחה!');
      } catch (error) {
        console.error('Error adding origin:', error);
        alert('❌ שגיאה בהוספת זן');
      }
    };

    const startEdit = (origin) => {
      setEditingOrigin({ 
        id: origin.id, 
        name: origin.name, 
        weightLoss: origin.weight_loss, 
        costPerKg: origin.cost_per_kg, 
        stock: origin.stock,
        roastedStock: origin.roasted_stock || 0,
        minStock: origin.min_stock || 10,
        notes: origin.notes || '',
        dailyAverage: origin.daily_average || 0
      });
    };
    
    const saveEdit = async () => {
      if (!editingOrigin.name || !editingOrigin.costPerKg) { alert('⚠️ נא למלא שם ועלות'); return; }
      try {
        await originsDb.update(editingOrigin.id, { 
          name: editingOrigin.name, 
          weight_loss: parseFloat(editingOrigin.weightLoss), 
          cost_per_kg: parseFloat(editingOrigin.costPerKg), 
          stock: parseFloat(editingOrigin.stock),
          roasted_stock: parseFloat(editingOrigin.roastedStock) || 0,
          min_stock: parseFloat(editingOrigin.minStock) || 10,
          notes: editingOrigin.notes, 
          updated_at: new Date().toISOString() 
        });
        await originsDb.refresh();
        setEditingOrigin(null);
        alert('✅ זן עודכן בהצלחה!');
      } catch (error) {
        console.error('Error updating origin:', error);
        alert('❌ שגיאה בעדכון זן');
      }
    };

    const deleteOrigin = async (origin) => {
      const roastsCount = data.roasts.filter(r => r.origin_id === origin.id).length;
      if (roastsCount > 0) {
        if (!window.confirm(`⚠️ לזן זה יש ${roastsCount} קליות. האם למחוק בכל זאת?`)) return;
      } else {
        if (!window.confirm(`האם למחוק את "${origin.name}"?`)) return;
      }
      try {
        await originsDb.remove(origin.id);
        alert('✅ זן נמחק!');
      } catch (error) {
        console.error('Error deleting origin:', error);
        alert('❌ שגיאה במחיקת זן');
      }
    };

    const duplicateOrigin = async (origin) => {
      try {
        await originsDb.insert({ name: origin.name + ' (עותק)', weight_loss: origin.weight_loss, cost_per_kg: origin.cost_per_kg, stock: 0, roasted_stock: 0, notes: origin.notes });
        alert('✅ זן שוכפל בהצלחה!');
      } catch (error) {
        console.error('Error duplicating origin:', error);
        alert('❌ שגיאה בשכפול זן');
      }
    };

    const addStockEntry = async () => {
      if (!stockEntry.originId || !stockEntry.quantity) {
        alert('⚠️ נא לבחור זן ולהזין כמות');
        return;
      }
      
      const quantity = parseFloat(stockEntry.quantity);
      if (quantity <= 0) {
        alert('⚠️ כמות חייבת להיות גדולה מ-0');
        return;
      }

      const origin = getOriginById(parseInt(stockEntry.originId));
      if (!origin) {
        alert('⚠️ זן לא נמצא');
        return;
      }

      try {
        const newStock = (origin.stock || 0) + quantity;
        await originsDb.update(origin.id, { stock: newStock });
        await originsDb.refresh(); // Refresh data to update table
        
        setStockEntry({ originId: '', quantity: '', notes: '' });
        // activeForm stays open!
        
        showToast(`הוספת ${quantity} ק"ג ל${origin.name} • מלאי חדש: ${newStock} ק"ג`);
      } catch (error) {
        console.error('Error adding stock:', error);
        showToast('שגיאה בהוספת מלאי', 'error');
      }
    };

    const removeStockForPackaging = async () => {
      if (!stockOut.originId || !stockOut.quantity) {
        showToast('נא לבחור זן ולהזין כמות', 'warning');
        return;
      }
      
      const quantity = parseFloat(stockOut.quantity);
      if (quantity <= 0) {
        showToast('כמות חייבת להיות גדולה מ-0', 'warning');
        return;
      }

      const origin = getOriginById(parseInt(stockOut.originId));
      if (!origin) {
        showToast('זן לא נמצא', 'error');
        return;
      }

      const currentRoastedStock = origin.roasted_stock || 0;
      if (quantity > currentRoastedStock) {
        showToast(`אין מספיק מלאי קלוי! קיים: ${currentRoastedStock} ק"ג, מבוקש: ${quantity} ק"ג`, 'error');
        return;
      }

      try {
        const newRoastedStock = currentRoastedStock - quantity;
        await originsDb.update(origin.id, { roasted_stock: newRoastedStock });
        await originsDb.refresh(); // Refresh data to update table
        
        setStockOut({ originId: '', quantity: '', notes: '' });
        // activeForm stays open!
        
        showToast(`הוצאו ${quantity} ק"ג מ${origin.name} לאריזה • נותר: ${newRoastedStock} ק"ג`);
      } catch (error) {
        console.error('Error removing stock:', error);
        alert('❌ שגיאה בהוצאת מלאי');
      }
    };

    const exportToCSV = () => {
      const headers = ['שם,איבוד משקל %,עלות ק"ג,מלאי ק"ג,מלאי קלוי ק"ג,הערות'];
      const rows = filteredOrigins.map(o => `"${o.name}",${o.weight_loss},${o.cost_per_kg},${o.stock || 0},${o.roasted_stock || 0},"${o.notes || ''}"`);
      const csv = [...headers, ...rows].join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `coffeeflow-origins-${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
    };

    const filteredOrigins = data.origins.filter(o => o.name.toLowerCase().includes(searchTerm.toLowerCase())).sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'stock') return (b.stock || 0) - (a.stock || 0);
      if (sortBy === 'cost') return (b.cost_per_kg || 0) - (a.cost_per_kg || 0);
      return 0;
    });

    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>🌱 ניהול זנים ({data.origins.length})</h1>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button 
              onClick={() => setActiveForm('stock-in')} 
              className="btn-primary" 
              style={{ background: '#10B981' }}
            >
              📦 קליטת מלאי
            </button>
            <button 
              onClick={() => setActiveForm('stock-out')} 
              className="btn-primary" 
              style={{ background: '#F59E0B' }}
            >
              📤 הוצאה לאריזה
            </button>
          </div>
        </div>
        <div className="toolbar">
          <input type="text" placeholder="🔍 חיפוש זן..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="search-input" />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="sort-select">
            <option value="name">מיון לפי שם</option>
            <option value="stock">מיון לפי מלאי</option>
            <option value="cost">מיון לפי מחיר</option>
          </select>
          <button onClick={exportToCSV} className="btn-small">📥 ייצא CSV</button>
        </div>

        {activeForm === 'stock-in' && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#F0FDF4', border: '2px solid #10B981' }}>
            <h3>📦 קליטת מלאי חדש</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>בחר זן *</label>
                <select 
                  value={stockEntry.originId} 
                  onChange={(e) => setStockEntry({...stockEntry, originId: e.target.value})}
                >
                  <option value="">בחר זן...</option>
                  {data.origins.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.name} (מלאי נוכחי: {o.stock || 0} ק"ג)
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>כמות להוספה (ק"ג) *</label>
                <input 
                  type="number" 
                  step="0.1" 
                  placeholder="למשל: 25"
                  value={stockEntry.quantity} 
                  onChange={(e) => setStockEntry({...stockEntry, quantity: e.target.value})}
                />
              </div>
            </div>
            <div className="form-group">
              <label>הערות (אופציונלי)</label>
              <textarea 
                placeholder="למשל: ספק חדש, מספר הזמנה..."
                value={stockEntry.notes} 
                onChange={(e) => setStockEntry({...stockEntry, notes: e.target.value})} 
                rows="2"
              />
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={addStockEntry} className="btn-primary" style={{ flex: 1, background: '#10B981' }}>
                ✅ הוסף למלאי
              </button>
              <button 
                onClick={() => {
                  setActiveForm(null);
                  setStockEntry({ originId: '', quantity: '', notes: '' });
                }} 
                className="btn-small" 
                style={{ flex: 1 }}
              >
                ❌ ביטול
              </button>
            </div>
          </div>
        )}

        {activeForm === 'stock-out' && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#FFFBEB', border: '2px solid #F59E0B' }}>
            <h3>📤 הוצאה לאריזה</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>בחר זן *</label>
                <select 
                  value={stockOut.originId} 
                  onChange={(e) => {
                    const originId = e.target.value;
                    const origin = getOriginById(parseInt(originId));
                    const yieldPercent = origin ? (1 - (origin.weight_loss / 100)) : 1;
                    const defaultWeight = (15 * yieldPercent).toFixed(1);
                    setStockOut({
                      ...stockOut, 
                      originId, 
                      quantity: originId ? defaultWeight : ''
                    });
                  }}
                >
                  <option value="">בחר זן...</option>
                  {data.origins.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.name} (מלאי קלוי: {o.roasted_stock || 0} ק"ג)
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>משקל להוצאה (ק"ג) *</label>
                <input 
                  type="number" 
                  step="0.1" 
                  placeholder="משקל דלי"
                  value={stockOut.quantity} 
                  onChange={(e) => setStockOut({...stockOut, quantity: e.target.value})}
                />
                {stockOut.originId && (
                  <small style={{ color: '#666', marginTop: '0.25rem', display: 'block' }}>
                    ברירת מחדל: משקל אחרי קלייה (15 ק"ג ירוק)
                  </small>
                )}
              </div>
            </div>
            <div className="form-group">
              <label>הערות (אופציונלי)</label>
              <textarea 
                placeholder="למשל: דלי #1234, מיועד לאריזה..."
                value={stockOut.notes} 
                onChange={(e) => setStockOut({...stockOut, notes: e.target.value})} 
                rows="2"
              />
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={removeStockForPackaging} className="btn-primary" style={{ flex: 1, background: '#F59E0B' }}>
                ✅ הוצא מהמלאי
              </button>
              <button 
                onClick={() => {
                  setActiveForm(null);
                  setStockOut({ originId: '', quantity: '', notes: '' });
                }} 
                className="btn-small" 
                style={{ flex: 1 }}
              >
                ❌ ביטול
              </button>
            </div>
          </div>
        )}

        {editingOrigin && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
            <h3>✏️ עריכת זן</h3>
            <div className="form-grid">
              <div className="form-group"><label>שם הזן</label><input type="text" value={editingOrigin.name} onChange={(e) => setEditingOrigin({...editingOrigin, name: e.target.value})} /></div>
              <div className="form-group"><label>איבוד משקל בקלייה (%)</label><input type="number" value={editingOrigin.weightLoss} onChange={(e) => setEditingOrigin({...editingOrigin, weightLoss: e.target.value})} /></div>
              <div className="form-group"><label>עלות לק"ג (₪)</label><input type="number" step="0.01" value={editingOrigin.costPerKg} onChange={(e) => setEditingOrigin({...editingOrigin, costPerKg: e.target.value})} /></div>
              <div className="form-group"><label>מלאי ירוק (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.stock} onChange={(e) => setEditingOrigin({...editingOrigin, stock: e.target.value})} /></div>
              <div className="form-group"><label>מלאי קלוי (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.roastedStock} onChange={(e) => setEditingOrigin({...editingOrigin, roastedStock: e.target.value})} /></div>
              <div className="form-group"><label>מלאי מינימום (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.minStock} onChange={(e) => setEditingOrigin({...editingOrigin, minStock: e.target.value})} placeholder="10" /></div>
<div className="form-group"><label>ממוצע מכירות יומי (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.dailyAverage || 0} onChange={(e) => setEditingOrigin({...editingOrigin, dailyAverage: e.target.value})} placeholder="0" /></div>
            </div>
            <div className="form-group"><label>הערות</label><textarea value={editingOrigin.notes} onChange={(e) => setEditingOrigin({...editingOrigin, notes: e.target.value})} rows="2" /></div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveEdit} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
              <button onClick={() => setEditingOrigin(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        {!editingOrigin && !activeForm && (
          <div className="form-card">
            <h3>➕ הוסף זן חדש</h3>
          <div className="form-grid">
            <div className="form-group"><label>שם הזן</label><input type="text" placeholder="למשל: ברזיל סנטוס" value={newOrigin.name} onChange={(e) => setNewOrigin({...newOrigin, name: e.target.value})} /></div>
            <div className="form-group"><label>איבוד משקל בקלייה (%)</label><input type="number" value={newOrigin.weightLoss} onChange={(e) => setNewOrigin({...newOrigin, weightLoss: e.target.value})} /></div>
            <div className="form-group"><label>עלות לק"ג (₪)</label><input type="number" step="0.01" placeholder="45.00" value={newOrigin.costPerKg} onChange={(e) => setNewOrigin({...newOrigin, costPerKg: e.target.value})} /></div>
            <div className="form-group"><label>מלאי התחלתי (ק"ג)</label><input type="number" step="0.1" value={newOrigin.stock} onChange={(e) => setNewOrigin({...newOrigin, stock: e.target.value})} /></div>
            <div className="form-group"><label>מלאי מינימום (ק"ג)</label><input type="number" step="0.1" value={newOrigin.minStock} onChange={(e) => setNewOrigin({...newOrigin, minStock: e.target.value})} placeholder="10" /></div>
          </div>
          <div className="form-group"><label>הערות</label><textarea placeholder="פרטים נוספים..." value={newOrigin.notes} onChange={(e) => setNewOrigin({...newOrigin, notes: e.target.value})} rows="2" /></div>
          <button onClick={addOrigin} className="btn-primary">➕ הוסף זן</button>
        </div>
        )}

        <div className="table-container">
          <table className="data-table">
            <thead><tr><th>שם</th><th>איבוד משקל</th><th>עלות/ק"ג ירוק</th><th>עלות/ק"ג קלוי</th><th>מלאי ירוק</th><th>מלאי קלוי</th><th>פעולות</th></tr></thead>
            <tbody>
              {filteredOrigins.map(origin => {
                const yieldPercent = 1 - (origin.weight_loss / 100);
                const costPerKgRoasted = (origin.cost_per_kg / yieldPercent).toFixed(2);
                const minStock = origin.min_stock || 10;
                const isLowStock = (origin.stock || 0) < minStock && (origin.stock || 0) > 0;
                const isOutOfStock = (origin.stock || 0) === 0;
                const stockStyle = isOutOfStock ? { background: '#FEE2E2', color: '#DC2626', fontWeight: 'bold' } : 
                                    isLowStock ? { background: '#FEF3C7', color: '#D97706', fontWeight: 'bold' } : {};
                return (
                  <tr key={origin.id} style={isOutOfStock ? { background: '#FEE2E2' } : isLowStock ? { background: '#FFFBEB' } : {}}>
                    <td><strong>{origin.name}</strong> {isOutOfStock && <span style={{ color: '#DC2626', marginRight: '0.5rem' }}>❌</span>} {isLowStock && <span style={{ color: '#F59E0B', marginRight: '0.5rem' }}>⚠️</span>}</td>
                    <td>{origin.weight_loss}%</td>
                    <td>₪{origin.cost_per_kg}</td>
                    <td>₪{costPerKgRoasted}</td>
                    <td style={stockStyle}>{origin.stock || 0} ק"ג {isLowStock && <span style={{ fontSize: '0.8em', color: '#D97706' }}>(מינימום: {minStock})</span>}</td>
                    <td>{origin.roasted_stock || 0} ק"ג</td>
                    <td>
                      <div className="action-buttons">
                        <button onClick={() => startEdit(origin)} className="btn-icon">✏️</button>
                        <button onClick={() => duplicateOrigin(origin)} className="btn-icon">📋</button>
                        <button onClick={() => deleteOrigin(origin)} className="btn-icon">🗑️</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredOrigins.length === 0 && <div className="empty-state">{searchTerm ? 'לא נמצאו תוצאות' : 'אין זנים עדיין. הוסף זן ראשון!'}</div>}
      </div>
    );
  };

  // Roasting Component  
  const Roasting = () => {
    const [selectedOrigin, setSelectedOrigin] = useState('');
    const [greenWeight, setGreenWeight] = useState('15');
    const [selectedOperator, setSelectedOperator] = useState('');
    const [editingRoast, setEditingRoast] = useState(null);
    
    // Filters
    const [searchTerm, setSearchTerm] = useState('');
    const [dateFilter, setDateFilter] = useState('all'); // today, week, month, custom, all
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [displayLimit, setDisplayLimit] = useState(20);
    const [selectedRoasts, setSelectedRoasts] = useState([]);

    const recordRoast = async () => {
      if (!selectedOrigin || !greenWeight || !selectedOperator) { alert('⚠️ נא למלא את כל השדות'); return; }
      const origin = getOriginById(parseInt(selectedOrigin));
      if (!origin) { alert('⚠️ זן לא נמצא'); return; }
      const weight = parseFloat(greenWeight);
      if (weight <= 0 || weight > 20) { alert('⚠️ משקל לא תקין (1-20 ק"ג)'); return; }
      if (origin.stock < weight) { alert(`⚠️ אין מספיק מלאי!\nנדרש: ${weight} ק"ג\nקיים: ${origin.stock} ק"ג`); return; }
      const roastedWeight = parseFloat(calculateRoastedWeight(weight, origin.weight_loss));
      
      // Generate batch number
      const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const todayRoasts = data.roasts.filter(r => r.date && r.date.startsWith(new Date().toISOString().split('T')[0]));
      const batchNum = `BATCH-${today}-${String(todayRoasts.length + 1).padStart(3, '0')}`;
      
      try {
        await roastsDb.insert({ 
          origin_id: origin.id, 
          green_weight: weight, 
          roasted_weight: roastedWeight, 
          operator: selectedOperator, 
          date: new Date().toISOString(),
          batch_number: batchNum
        });
        await originsDb.update(origin.id, { stock: origin.stock - weight, roasted_stock: (origin.roasted_stock || 0) + roastedWeight });
        await roastsDb.refresh();
        await originsDb.refresh();
        setGreenWeight('15'); setSelectedOrigin(''); setSelectedOperator('');
        alert(`✅ קלייה נרשמה!\nBatch: ${batchNum}\n${weight} ק"ג ירוק → ${roastedWeight} ק"ג קלוי`);
      } catch (error) {
        console.error('Error recording roast:', error);
        alert('❌ שגיאה ברישום קלייה');
      }
    };

    const startEditRoast = (roast) => {
      setEditingRoast({ id: roast.id, originId: roast.origin_id, greenWeight: roast.green_weight, operator: roast.operator, oldGreenWeight: roast.green_weight, oldOriginId: roast.origin_id });
    };

    const saveEditRoast = async () => {
      if (!editingRoast.originId || !editingRoast.greenWeight || !editingRoast.operator) { alert('⚠️ נא למלא את כל השדות'); return; }
      const newOrigin = getOriginById(editingRoast.originId);
      const oldOrigin = getOriginById(editingRoast.oldOriginId);
      if (!newOrigin || !oldOrigin) { alert('⚠️ זן לא נמצא'); return; }
      const newWeight = parseFloat(editingRoast.greenWeight);
      const newRoastedWeight = parseFloat(calculateRoastedWeight(newWeight, newOrigin.weight_loss));
      const oldWeight = parseFloat(editingRoast.oldGreenWeight);
      const oldRoastedWeight = parseFloat(calculateRoastedWeight(oldWeight, oldOrigin.weight_loss));
      try {
        await roastsDb.update(editingRoast.id, { origin_id: newOrigin.id, green_weight: newWeight, roasted_weight: newRoastedWeight, operator: editingRoast.operator, updated_at: new Date().toISOString() });
        if (oldOrigin.id === newOrigin.id) {
          const stockDiff = newWeight - oldWeight;
          const roastedDiff = newRoastedWeight - oldRoastedWeight;
          await originsDb.update(oldOrigin.id, { stock: oldOrigin.stock - stockDiff, roasted_stock: (oldOrigin.roasted_stock || 0) + roastedDiff });
        } else {
          await originsDb.update(oldOrigin.id, { stock: oldOrigin.stock + oldWeight, roasted_stock: (oldOrigin.roasted_stock || 0) - oldRoastedWeight });
          await originsDb.update(newOrigin.id, { stock: newOrigin.stock - newWeight, roasted_stock: (newOrigin.roasted_stock || 0) + newRoastedWeight });
        }
        await roastsDb.refresh();
        await originsDb.refresh();
        setEditingRoast(null);
        alert('✅ קלייה עודכנה!');
      } catch (error) {
        console.error('Error updating roast:', error);
        alert('❌ שגיאה בעדכון קלייה');
      }
    };

    const deleteRoast = async (roast) => {
      const origin = getOriginById(roast.origin_id);
      if (!window.confirm(`⚠️ האם למחוק קלייה זו?\n${roast.green_weight} ק"ג ${origin?.name || 'לא ידוע'}\nהמלאי יוחזר לזן`)) return;
      try {
        await roastsDb.remove(roast.id);
        if (origin) {
          await originsDb.update(origin.id, { stock: origin.stock + roast.green_weight, roasted_stock: (origin.roasted_stock || 0) - roast.roasted_weight });
        }
        await roastsDb.refresh();
        await originsDb.refresh();
        alert('✅ קלייה נמחקה והמלאי הוחזר!');
      } catch (error) {
        console.error('Error deleting roast:', error);
        alert('❌ שגיאה במחיקת קלייה');
      }
    };

    const toggleRoastSelection = (roastId) => {
      setSelectedRoasts(prev => 
        prev.includes(roastId) 
          ? prev.filter(id => id !== roastId)
          : [...prev, roastId]
      );
    };

    const toggleSelectAll = () => {
      if (selectedRoasts.length === displayedRoasts.length) {
        setSelectedRoasts([]);
      } else {
        setSelectedRoasts(displayedRoasts.map(r => r.id));
      }
    };

    const deleteSelectedRoasts = async () => {
      if (selectedRoasts.length === 0) {
        alert('⚠️ לא נבחרו קליות למחיקה');
        return;
      }
      
      if (!window.confirm(`⚠️ האם למחוק ${selectedRoasts.length} קליות?\n\nהמלאי יוחזר אוטומטית.`)) return;
      
      try {
        for (const roastId of selectedRoasts) {
          const roast = data.roasts.find(r => r.id === roastId);
          if (roast) {
            await roastsDb.remove(roast.id);
            const origin = getOriginById(roast.origin_id);
            if (origin) {
              await originsDb.update(origin.id, { 
                stock: origin.stock + roast.green_weight, 
                roasted_stock: (origin.roasted_stock || 0) - roast.roasted_weight 
              });
            }
          }
        }
        await roastsDb.refresh();
        await originsDb.refresh();
        setSelectedRoasts([]);
        alert(`✅ ${selectedRoasts.length} קליות נמחקו והמלאי הוחזר!`);
      } catch (error) {
        console.error('Error deleting roasts:', error);
        alert('❌ שגיאה במחיקת קליות');
      }
    };

    // Filter roasts
    const getFilteredRoasts = () => {
      let filtered = [...data.roasts];
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

      if (dateFilter === 'today') {
        filtered = filtered.filter(r => new Date(r.date) >= today);
      } else if (dateFilter === 'week') {
        filtered = filtered.filter(r => new Date(r.date) >= weekAgo);
      } else if (dateFilter === 'month') {
        filtered = filtered.filter(r => new Date(r.date) >= monthAgo);
      } else if (dateFilter === 'custom') {
        if (startDate) {
          const start = new Date(startDate);
          start.setHours(0, 0, 0, 0);
          filtered = filtered.filter(r => new Date(r.date) >= start);
        }
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          filtered = filtered.filter(r => new Date(r.date) <= end);
        }
      }

      if (searchTerm) {
        filtered = filtered.filter(r => {
          const origin = getOriginById(r.origin_id);
          const matchOrigin = origin?.name?.toLowerCase().includes(searchTerm.toLowerCase());
          const matchOperator = r.operator?.toLowerCase().includes(searchTerm.toLowerCase());
          const matchBatch = r.batch_number?.toLowerCase().includes(searchTerm.toLowerCase());
          return matchOrigin || matchOperator || matchBatch;
        });
      }

      return filtered.reverse();
    };

    const filteredRoasts = getFilteredRoasts();
    const displayedRoasts = filteredRoasts.slice(0, displayLimit);
    const hasMore = filteredRoasts.length > displayLimit;

    return (
      <div className="page">
        <h1>🔥 רישום קלייה</h1>
        {editingRoast && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
            <h3>✏️ עריכת קלייה</h3>
            <div className="form-grid">
              <div className="form-group"><label>זן</label><select value={editingRoast.originId} onChange={(e) => setEditingRoast({...editingRoast, originId: parseInt(e.target.value)})}><option value="">בחר זן...</option>{data.origins.map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {o.stock} ק"ג)</option>)}</select></div>
              <div className="form-group"><label>משקל ירוק (ק"ג)</label><input type="number" step="0.1" value={editingRoast.greenWeight} onChange={(e) => setEditingRoast({...editingRoast, greenWeight: e.target.value})} /></div>
              <div className="form-group"><label>מפעיל</label><select value={editingRoast.operator} onChange={(e) => setEditingRoast({...editingRoast, operator: e.target.value})}><option value="">בחר מפעיל...</option>{data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}</select></div>
            </div>
            {editingRoast.originId && editingRoast.greenWeight && (
              <div className="calculation-display">משקל קלוי משוער: <strong>{calculateRoastedWeight(editingRoast.greenWeight, getOriginById(editingRoast.originId)?.weight_loss || 20)} ק"ג</strong></div>
            )}
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveEditRoast} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
              <button onClick={() => setEditingRoast(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        <div className="form-card">
          <div className="form-grid">
            <div className="form-group"><label>בחר זן לקלייה</label><select value={selectedOrigin} onChange={(e) => setSelectedOrigin(e.target.value)}><option value="">בחר זן...</option>{data.origins.filter(o => o.stock > 0).map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {o.stock} ק"ג)</option>)}</select></div>
            <div className="form-group"><label>משקל ירוק (ק"ג)</label><input type="number" step="0.1" placeholder="15" value={greenWeight} onChange={(e) => setGreenWeight(e.target.value)} /></div>
            <div className="form-group"><label>מפעיל</label><select value={selectedOperator} onChange={(e) => setSelectedOperator(e.target.value)}><option value="">בחר מפעיל...</option>{data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}</select></div>
          </div>
          {selectedOrigin && greenWeight && (
            <div className="calculation-display">
              <div>איבוד משקל: <strong>{getOriginById(parseInt(selectedOrigin))?.weight_loss}%</strong></div>
              <div>משקל קלוי צפוי: <strong>{calculateRoastedWeight(greenWeight, getOriginById(parseInt(selectedOrigin))?.weight_loss || 20)} ק"ג</strong></div>
            </div>
          )}
          <button onClick={recordRoast} className="btn-primary">🔥 רשום קלייה</button>
        </div>

        <div className="section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem', flexWrap: 'wrap' }}>
            <h2>📋 היסטוריית קליות ({filteredRoasts.length})</h2>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {displayedRoasts.length > 0 && (
                <>
                  <button 
                    onClick={toggleSelectAll} 
                    className="btn-small"
                    style={{ background: '#E0E7FF', color: '#4338CA' }}
                  >
                    {selectedRoasts.length === displayedRoasts.length ? '☑️ בטל הכל' : '☐ בחר הכל'}
                  </button>
                  {selectedRoasts.length > 0 && (
                    <button 
                      onClick={deleteSelectedRoasts} 
                      className="btn-small"
                      style={{ background: '#FEE2E2', color: '#DC2626', fontWeight: 'bold' }}
                    >
                      🗑️ מחק נבחרים ({selectedRoasts.length})
                    </button>
                  )}
                </>
              )}
              <input 
                type="text" 
                placeholder="🔍 חיפוש זן/מפעיל/Batch..." 
                value={searchTerm} 
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{ padding: '0.5rem', borderRadius: '6px', border: '1px solid #ddd', minWidth: '200px' }}
              />
              <select 
                value={dateFilter} 
                onChange={(e) => { setDateFilter(e.target.value); setDisplayLimit(20); }}
                style={{ padding: '0.5rem', borderRadius: '6px', border: '1px solid #ddd' }}
              >
                <option value="all">📅 כל הזמנים</option>
                <option value="today">📅 היום</option>
                <option value="week">📅 השבוע</option>
                <option value="month">📅 החודש</option>
                <option value="custom">📅 טווח תאריכים</option>
              </select>
              {dateFilter === 'custom' && (
                <>
                  <input 
                    type="date" 
                    value={startDate} 
                    onChange={(e) => setStartDate(e.target.value)}
                    style={{ padding: '0.5rem', borderRadius: '6px', border: '1px solid #ddd' }}
                    placeholder="מתאריך"
                  />
                  <span style={{ color: '#999' }}>עד</span>
                  <input 
                    type="date" 
                    value={endDate} 
                    onChange={(e) => setEndDate(e.target.value)}
                    style={{ padding: '0.5rem', borderRadius: '6px', border: '1px solid #ddd' }}
                    placeholder="עד תאריך"
                  />
                </>
              )}
            </div>
          </div>
          {filteredRoasts.length === 0 ? (
            <div className="empty-state">{searchTerm || dateFilter !== 'all' ? 'לא נמצאו קליות מתאימות' : 'אין קליות עדיין. רשום קלייה ראשונה!'}</div>
          ) : (
            <>
              <div className="roasts-list">
                {displayedRoasts.map(roast => {
                const origin = getOriginById(roast.origin_id);
                return (
                  <div 
                    key={roast.id} 
                    className="roast-card"
                    style={{ 
                      border: selectedRoasts.includes(roast.id) ? '2px solid #4338CA' : undefined,
                      background: selectedRoasts.includes(roast.id) ? '#F0F4FF' : undefined
                    }}
                  >
                    <div className="roast-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <input 
                          type="checkbox" 
                          checked={selectedRoasts.includes(roast.id)}
                          onChange={() => toggleRoastSelection(roast.id)}
                          style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                        />
                        <h3>{origin?.name || 'זן לא ידוע'}</h3>
                      </div>
                      <div className="roast-actions">
                        <button onClick={() => startEditRoast(roast)} className="btn-icon">✏️</button>
                        <button onClick={() => deleteRoast(roast)} className="btn-icon">🗑️</button>
                      </div>
                    </div>
                    <div className="roast-details">
                      {roast.batch_number && <div style={{ fontSize: '1.1em', fontWeight: 'bold', color: '#6F4E37', marginBottom: '0.5rem' }}>🏷️ {roast.batch_number}</div>}
                      <div>🌱 ירוק: <strong>{roast.green_weight} ק"ג</strong></div>
                      <div>🔥 קלוי: <strong>{roast.roasted_weight} ק"ג</strong></div>
                      <div>👨‍🍳 מפעיל: <strong>{roast.operator}</strong></div>
                      <div>📅 תאריך: <strong>{new Date(roast.date).toLocaleDateString('he-IL')}</strong></div>
                      {roast.updated_at && <div style={{ fontSize: '0.85em', color: '#FF6B35' }}>✏️ עודכן: {new Date(roast.updated_at).toLocaleString('he-IL')}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            {hasMore && (
              <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
                <button 
                  onClick={() => setDisplayLimit(displayLimit + 20)} 
                  className="btn-small"
                  style={{ background: '#6F4E37', color: 'white', padding: '0.75rem 2rem' }}
                >
                  ⬇️ טען עוד 20 קליות
                </button>
                <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#999' }}>
                  מציג {displayedRoasts.length} מתוך {filteredRoasts.length}
                </div>
              </div>
            )}
            </>
          )}
        </div>
      </div>
    );
  };

  // Products Component
  const Products = () => {
    const [editingProduct, setEditingProduct] = useState(null);
    const [addingProduct, setAddingProduct] = useState(false);
    const [showBreakdownId, setShowBreakdownId] = useState(null);
    const [newProduct, setNewProduct] = useState({ name: '', size: 330, type: 'single', description: '', recipe: [{ originId: '', percentage: 100 }] });

    const startAddProduct = () => {
      setAddingProduct(true);
      setNewProduct({ name: '', size: 330, type: 'single', description: '', recipe: [{ originId: '', percentage: 100 }] });
    };

    const addRecipeIngredient = (isEditing = false) => {
      if (isEditing) {
        setEditingProduct({ ...editingProduct, recipe: [...editingProduct.recipe, { originId: '', percentage: 0 }] });
      } else {
        setNewProduct({ ...newProduct, recipe: [...newProduct.recipe, { originId: '', percentage: 0 }] });
      }
    };

    const removeRecipeIngredient = (index, isEditing = false) => {
      if (isEditing) {
        setEditingProduct({ ...editingProduct, recipe: editingProduct.recipe.filter((_, i) => i !== index) });
      } else {
        setNewProduct({ ...newProduct, recipe: newProduct.recipe.filter((_, i) => i !== index) });
      }
    };

    const updateRecipeIngredient = (index, field, value, isEditing = false) => {
      if (isEditing) {
        const newRecipe = [...editingProduct.recipe];
        newRecipe[index][field] = field === 'originId' ? parseInt(value) : parseFloat(value);
        setEditingProduct({ ...editingProduct, recipe: newRecipe });
      } else {
        const newRecipe = [...newProduct.recipe];
        newRecipe[index][field] = field === 'originId' ? parseInt(value) : parseFloat(value);
        setNewProduct({ ...newProduct, recipe: newRecipe });
      }
    };

    const validateProduct = (product) => {
      if (!product.name.trim()) { alert('⚠️ נא למלא שם מוצר'); return false; }
      if (!product.size || product.size <= 0) { alert('⚠️ נא למלא גודל מוצר'); return false; }
      if (!product.recipe || product.recipe.length === 0) { alert('⚠️ נא להוסיף לפחות רכיב אחד למתכון'); return false; }
      for (let ing of product.recipe) {
        if (!ing.originId) { alert('⚠️ נא לבחור זן לכל רכיב במתכון'); return false; }
      }
      const totalPercentage = product.recipe.reduce((sum, ing) => sum + (ing.percentage || 0), 0);
      if (Math.abs(totalPercentage - 100) > 0.1) { alert(`⚠️ סכום האחוזים במתכון חייב להיות 100%\n\nכרגע: ${totalPercentage}%`); return false; }
      return true;
    };

    const saveNewProduct = async () => {
      if (!validateProduct(newProduct)) return;
      try {
        await productsDb.insert({ name: newProduct.name, size: parseInt(newProduct.size), type: newProduct.type, description: newProduct.description, recipe: newProduct.recipe });
        await productsDb.refresh();
        setAddingProduct(false);
        alert('✅ מוצר נוסף בהצלחה!');
      } catch (error) {
        console.error('Error adding product:', error);
        alert('❌ שגיאה בהוספת מוצר');
      }
    };

    const startEditProduct = (product) => { 
      setEditingProduct({
        ...product,
        recipe: product.recipe.map(r => ({...r}))
      }); 
    };

    const saveEditProduct = async () => {
      if (!validateProduct(editingProduct)) return;
      try {
        await productsDb.update(editingProduct.id, { name: editingProduct.name, size: parseInt(editingProduct.size), type: editingProduct.type, description: editingProduct.description, recipe: editingProduct.recipe, updated_at: new Date().toISOString() });
        await productsDb.refresh();
        setEditingProduct(null);
        alert('✅ מוצר עודכן בהצלחה!');
      } catch (error) {
        console.error('Error updating product:', error);
        alert('❌ שגיאה בעדכון מוצר');
      }
    };

    const deleteProduct = async (product) => {
      if (!window.confirm(`⚠️ האם למחוק את המוצר "${product.name} ${product.size}g"?`)) return;
      try {
        await productsDb.remove(product.id);
        await productsDb.refresh();
        alert('✅ מוצר נמחק!');
      } catch (error) {
        console.error('Error deleting product:', error);
        alert('❌ שגיאה במחיקת מוצר');
      }
    };

    const duplicateProduct = async (product) => {
      try {
        await productsDb.insert({ name: product.name + ' (עותק)', size: product.size, type: product.type, description: product.description, recipe: product.recipe });
        alert('✅ מוצר שוכפל בהצלחה!');
      } catch (error) {
        console.error('Error duplicating product:', error);
        alert('❌ שגיאה בשכפול מוצר');
      }
    };

    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>📦 מוצרים ({data.products.length})</h1>
          {!addingProduct && !editingProduct && <button onClick={startAddProduct} className="btn-primary">➕ הוסף מוצר</button>}
        </div>

        {addingProduct && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#F0F9FF', border: '2px solid #3B82F6' }}>
            <h3>➕ הוסף מוצר חדש</h3>
            <div className="form-group"><label>שם המוצר *</label><input type="text" placeholder="למשל: Aristo Blend" value={newProduct.name} onChange={e => setNewProduct({...newProduct, name: e.target.value})} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group"><label>גודל (גרם) *</label><input type="number" placeholder="330" value={newProduct.size} onChange={e => setNewProduct({...newProduct, size: parseInt(e.target.value)})} /></div>
              <div className="form-group"><label>סוג</label><select value={newProduct.type} onChange={e => setNewProduct({...newProduct, type: e.target.value})}><option value="single">חד-זני</option><option value="blend">תערובת</option></select></div>
            </div>
            <div className="form-group"><label>תיאור (אופציונלי)</label><input type="text" placeholder="למשל: שוקולדי ומאוזן" value={newProduct.description} onChange={e => setNewProduct({...newProduct, description: e.target.value})} /></div>
            <div className="form-group">
              <label>מתכון (סה"כ חייב להיות 100%) *</label>
              {newProduct.recipe.map((ing, index) => (
                <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '10px', marginBottom: '10px' }}>
                  <select value={ing.originId} onChange={e => updateRecipeIngredient(index, 'originId', e.target.value, false)}><option value="">בחר זן...</option>{data.origins.map(origin => <option key={origin.id} value={origin.id}>{origin.name}</option>)}</select>
                  <input type="number" placeholder="%" value={ing.percentage} onChange={e => updateRecipeIngredient(index, 'percentage', e.target.value, false)} />
                  {newProduct.recipe.length > 1 && <button onClick={() => removeRecipeIngredient(index, false)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }}>🗑️</button>}
                </div>
              ))}
              <button onClick={() => addRecipeIngredient(false)} className="btn-small" style={{ marginTop: '5px' }}>➕ הוסף רכיב</button>
              <div style={{ marginTop: '10px', fontSize: '14px', color: newProduct.recipe.reduce((s, i) => s + (i.percentage || 0), 0) === 100 ? '#059669' : '#DC2626' }}>
                סה"כ: {newProduct.recipe.reduce((sum, ing) => sum + (ing.percentage || 0), 0)}%
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveNewProduct} className="btn-primary" style={{ flex: 1 }}>💾 שמור מוצר</button>
              <button onClick={() => setAddingProduct(false)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        {editingProduct && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
            <h3>✏️ עריכת מוצר</h3>
            <div className="form-group"><label>שם המוצר *</label><input type="text" value={editingProduct.name} onChange={e => setEditingProduct({...editingProduct, name: e.target.value})} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group"><label>גודל (גרם) *</label><input type="number" value={editingProduct.size} onChange={e => setEditingProduct({...editingProduct, size: parseInt(e.target.value)})} /></div>
              <div className="form-group"><label>סוג</label><select value={editingProduct.type} onChange={e => setEditingProduct({...editingProduct, type: e.target.value})}><option value="single">חד-זני</option><option value="blend">תערובת</option></select></div>
            </div>
            <div className="form-group"><label>תיאור (אופציונלי)</label><input type="text" value={editingProduct.description} onChange={e => setEditingProduct({...editingProduct, description: e.target.value})} /></div>
            <div className="form-group">
              <label>מתכון (סה"כ חייב להיות 100%) *</label>
              {editingProduct.recipe.map((ing, index) => (
                <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '10px', marginBottom: '10px' }}>
                  <select value={ing.originId} onChange={e => updateRecipeIngredient(index, 'originId', e.target.value, true)}><option value="">בחר זן...</option>{data.origins.map(origin => <option key={origin.id} value={origin.id}>{origin.name}</option>)}</select>
                  <input type="number" placeholder="%" value={ing.percentage} onChange={e => updateRecipeIngredient(index, 'percentage', e.target.value, true)} />
                  {editingProduct.recipe.length > 1 && <button onClick={() => removeRecipeIngredient(index, true)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }}>🗑️</button>}
                </div>
              ))}
              <button onClick={() => addRecipeIngredient(true)} className="btn-small" style={{ marginTop: '5px' }}>➕ הוסף רכיב</button>
              <div style={{ marginTop: '10px', fontSize: '14px', color: editingProduct.recipe.reduce((s, i) => s + (i.percentage || 0), 0) === 100 ? '#059669' : '#DC2626' }}>
                סה"כ: {editingProduct.recipe.reduce((sum, ing) => sum + (ing.percentage || 0), 0)}%
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveEditProduct} className="btn-primary" style={{ flex: 1 }}>💾 שמור שינויים</button>
              <button onClick={() => setEditingProduct(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        {!addingProduct && !editingProduct && (
          <div className="products-grid">
            {data.products.map(product => {
              const cost = calculateProductCost(product);
              const breakdown = calculateProductCost(product, true);
              const isBreakdownOpen = showBreakdownId === product.id;
              return (
                <div key={product.id} className="product-card">
                  <div className="product-header"><h3>{product.name}</h3><span className="badge">{product.size}g</span></div>
                  {product.description && <div style={{ padding: '0.5rem 0', fontSize: '0.875rem', color: '#6F4E37', fontStyle: 'italic', borderBottom: '1px solid #F4E8D8', marginBottom: '0.5rem' }}>{product.description}</div>}
                  <div className="product-recipe">
                    <strong>מתכון:</strong>
                    {product.recipe.map((ing, i) => {
                      const origin = getOriginById(ing.originId);
                      return <div key={i} className="recipe-item">• {ing.percentage}% {origin?.name}</div>;
                    })}
                  </div>
                  <div className="product-cost">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span>עלות ייצור:</span><strong>₪{cost}</strong></div>
                    <button onClick={() => setShowBreakdownId(isBreakdownOpen ? null : product.id)} style={{ fontSize: '11px', padding: '2px 8px', marginTop: '5px', background: 'transparent', border: '1px solid #D4A574', borderRadius: '4px', cursor: 'pointer', color: '#6F4E37' }}>
                      {isBreakdownOpen ? '🔼 הסתר פירוט' : '🔽 פירוט מלא'}
                    </button>
                    {isBreakdownOpen && (
                      <div style={{ marginTop: '10px', padding: '10px', background: '#FFFBF5', borderRadius: '6px', fontSize: '12px', border: '1px solid #F4E8D8' }}>
                        <div style={{ marginBottom: '5px' }}>☕ פולים קלויים: ₪{breakdown.beansCost}</div>
                        <div style={{ marginBottom: '5px' }}>🔥 גז: ₪{breakdown.gasCost}</div>
                        <div style={{ marginBottom: '5px' }}>👨‍🍳 עבודה (קלייה): ₪{breakdown.roastingLabor}</div>
                        <div style={{ marginBottom: '5px' }}>📦 אריזה: ₪{breakdown.packagingCost}</div>
                        <div style={{ marginBottom: '5px' }}>👷 עבודה (אריזה): ₪{breakdown.packagingLabor}</div>
                        <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #D4A574', fontWeight: 'bold', color: '#6F4E37' }}>💰 סה"כ: ₪{breakdown.totalCost}</div>
                      </div>
                    )}
                  </div>
                  <div className="product-actions">
                    <button onClick={() => startEditProduct(product)} className="btn-small">✏️</button>
                    <button onClick={() => duplicateProduct(product)} className="btn-small" style={{ background: '#D1FAE5', color: '#065F46' }}>📋</button>
                    <button onClick={() => deleteProduct(product)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }}>🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {data.products.length === 0 && <div className="empty-state">אין מוצרים עדיין. הוסף מוצר ראשון!</div>}
      </div>
    );
  };

  // Settings Component
  const Settings = () => {
    const [newOperator, setNewOperator] = useState('');
    const [editingOperator, setEditingOperator] = useState(null);

    const addOperator = async () => {
      if (newOperator.trim()) {
        try {
          await operatorsDb.insert({ name: newOperator.trim() });
          setNewOperator('');
          alert('✅ מפעיל נוסף!');
        } catch (error) {
          console.error('Error adding operator:', error);
          alert('❌ שגיאה בהוספת מפעיל');
        }
      }
    };

    const startEditOperator = (operator) => { setEditingOperator({ ...operator }); };

    const saveEditOperator = async () => {
      if (!editingOperator.name.trim()) { alert('⚠️ נא למלא שם מפעיל'); return; }
      try {
        await operatorsDb.update(editingOperator.id, { name: editingOperator.name.trim() });
        const oldOperator = data.operators.find(op => op.id === editingOperator.id);
        if (oldOperator && oldOperator.name !== editingOperator.name.trim()) {
          const roastsToUpdate = data.roasts.filter(r => r.operator === oldOperator.name);
          for (const roast of roastsToUpdate) {
            await roastsDb.update(roast.id, { operator: editingOperator.name.trim() });
          }
        }
        setEditingOperator(null);
        alert('✅ מפעיל עודכן!');
      } catch (error) {
        console.error('Error updating operator:', error);
        alert('❌ שגיאה בעדכון מפעיל');
      }
    };

    const deleteOperator = async (operator) => {
      const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
      if (roastCount > 0) {
        if (!window.confirm(`⚠️ למפעיל "${operator.name}" יש ${roastCount} קליות.\n\nהקליות יישארו עם השם שלו.\n\nהאם למחוק את המפעיל מהרשימה?`)) return;
      } else {
        if (!window.confirm(`האם למחוק את המפעיל "${operator.name}"?`)) return;
      }
      try {
        await operatorsDb.remove(operator.id);
        alert('✅ מפעיל נמחק!');
      } catch (error) {
        console.error('Error deleting operator:', error);
        alert('❌ שגיאה במחיקת מפעיל');
      }
    };

    return (
      <div className="page">
        <h1>⚙️ הגדרות</h1>
        <div className="section">
          <h2>👥 ניהול מפעילים ({data.operators.length})</h2>
          <div className="form-card">
            <div style={{ display: 'flex', gap: '10px' }}>
              <input type="text" placeholder="שם מפעיל חדש..." value={newOperator} onChange={(e) => setNewOperator(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && addOperator()} style={{ flex: 1 }} />
              <button onClick={addOperator} className="btn-primary">➕ הוסף מפעיל</button>
            </div>
          </div>

          {editingOperator && (
            <div className="form-card" style={{ background: '#FFF9F0', border: '2px solid #FF6B35', marginTop: '15px' }}>
              <h3>✏️ עריכת מפעיל</h3>
              <input type="text" value={editingOperator.name} onChange={(e) => setEditingOperator({...editingOperator, name: e.target.value})} />
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                <button onClick={saveEditOperator} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
                <button onClick={() => setEditingOperator(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
              </div>
            </div>
          )}

          <div className="table-container" style={{ marginTop: '15px' }}>
            <table className="data-table">
              <thead><tr><th>שם</th><th>מספר קליות</th><th>פעולות</th></tr></thead>
              <tbody>
                {data.operators.map(operator => {
                  const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
                  return (
                    <tr key={operator.id}>
                      <td><strong>{operator.name}</strong></td>
                      <td>{roastCount}</td>
                      <td>
                        <div className="action-buttons">
                          <button onClick={() => startEditOperator(operator)} className="btn-icon">✏️</button>
                          <button onClick={() => deleteOperator(operator)} className="btn-icon">🗑️</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.operators.length === 0 && <div className="empty-state">אין מפעילים. הוסף מפעיל ראשון!</div>}
        </div>

        <div className="section" style={{ marginTop: '2rem' }}>
          <h2>💰 הגדרות עלויות</h2>
          <p style={{ color: '#666', marginBottom: '1rem' }}>ניתן לערוך את העלויות הקבועות כאן. השינויים ישפיעו על חישוב עלויות המוצרים.</p>
          {costSettings ? (
            <div className="form-card">
              <div className="form-grid">
                <div className="form-group"><label>שקית 330g (₪)</label><input type="number" step="0.01" value={costSettings.bag_330g} onChange={async (e) => { await updateCostSettings({ bag_330g: parseFloat(e.target.value) }); }} /></div>
                <div className="form-group"><label>מדבקה (₪)</label><input type="number" step="0.01" value={costSettings.label} onChange={async (e) => { await updateCostSettings({ label: parseFloat(e.target.value) }); }} /></div>
                <div className="form-group"><label>גז לקלייה (₪)</label><input type="number" step="0.01" value={costSettings.gas_per_roast} onChange={async (e) => { await updateCostSettings({ gas_per_roast: parseFloat(e.target.value) }); }} /></div>
                <div className="form-group"><label>שכר/שעה (₪)</label><input type="number" step="1" value={costSettings.labor_per_hour} onChange={async (e) => { await updateCostSettings({ labor_per_hour: parseFloat(e.target.value) }); }} /></div>
                <div className="form-group"><label>זמן קלייה (דק׳)</label><input type="number" step="1" value={costSettings.roasting_time_minutes} onChange={async (e) => { await updateCostSettings({ roasting_time_minutes: parseFloat(e.target.value) }); }} /></div>
                <div className="form-group"><label>זמן אריזה (דק׳)</label><input type="number" step="0.1" value={costSettings.packaging_time_minutes} onChange={async (e) => { await updateCostSettings({ packaging_time_minutes: parseFloat(e.target.value) }); }} /></div>
              </div>
              <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#666' }}>💾 השינויים נשמרים אוטומטית</p>
            </div>
          ) : (
            <div className="empty-state">טוען הגדרות...</div>
          )}
        </div>
      </div>
    );
  };

  // Main return
  return (
    <div className="App" style={{ direction: 'rtl' }}>
      {/* Toast Notifications */}
      <div style={{
        position: 'fixed',
        top: '20px',
        right: '20px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px'
      }}>
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

      <Navigation />
      <div className="container">
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'origins' && <Origins showToast={showToast} activeForm={originsActiveForm} setActiveForm={setOriginsActiveForm} />}
        {currentPage === 'roasting' && <Roasting showToast={showToast} />}
        {currentPage === 'products' && <Products showToast={showToast} />}
        {currentPage === 'settings' && <Settings showToast={showToast} />}
        {currentPage === 'mflow' && <MFlowSync data={data} showToast={showToast} />}
        {currentPage === 'roasting-list' && <RoastingList data={data} originsDb={originsDb} showToast={showToast} />}
      </div>
    </div>
  );
}

export default App;
