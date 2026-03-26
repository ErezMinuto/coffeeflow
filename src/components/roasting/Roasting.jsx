import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import RoastingList from './RoastingList';

export default function Roasting() {
  const { data, originsDb, roastsDb, getOriginById, calculateRoastedWeight, showToast } = useApp();

  const [selectedOrigin,   setSelectedOrigin]   = useState('');
  const [greenWeight,      setGreenWeight]       = useState('15');
  const [selectedOperator, setSelectedOperator] = useState('');
  const [editingRoast,     setEditingRoast]      = useState(null);
  const [view,             setView]              = useState('log'); // 'log' | 'list'

  // Filters
  const [searchTerm,  setSearchTerm]  = useState('');
  const [dateFilter,  setDateFilter]  = useState('all');
  const [startDate,   setStartDate]   = useState('');
  const [endDate,     setEndDate]     = useState('');
  const [displayLimit, setDisplayLimit] = useState(20);
  const [selectedRoasts, setSelectedRoasts] = useState([]);

  // ── RECORD ────────────────────────────────────────────────────────────────────

  const recordRoast = async () => {
    if (!selectedOrigin || !greenWeight || !selectedOperator) {
      showToast('⚠️ נא למלא את כל השדות', 'warning'); return;
    }
    const origin = getOriginById(parseInt(selectedOrigin));
    if (!origin) { showToast('⚠️ זן לא נמצא', 'warning'); return; }

    const weight = parseFloat(greenWeight);
    if (weight <= 0 || weight > 20) { showToast('⚠️ משקל לא תקין (1-20 ק"ג)', 'warning'); return; }
    if (origin.stock < weight) {
      showToast(`⚠️ אין מספיק מלאי! נדרש: ${weight} ק"ג, קיים: ${origin.stock} ק"ג`, 'warning'); return;
    }

    const roastedWeight = parseFloat(calculateRoastedWeight(weight, origin.weight_loss));
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const todayRoasts = data.roasts.filter(r => r.date && r.date.startsWith(new Date().toISOString().split('T')[0]));
    const batchNum = `BATCH-${today}-${String(todayRoasts.length + 1).padStart(3, '0')}`;

    try {
      await roastsDb.insert({
        origin_id: origin.id, green_weight: weight, roasted_weight: roastedWeight,
        operator: selectedOperator, date: new Date().toISOString(), batch_number: batchNum
      });
      await originsDb.update(origin.id, {
        stock: origin.stock - weight,
        roasted_stock: (origin.roasted_stock || 0) + roastedWeight
      });
      await roastsDb.refresh();
      await originsDb.refresh();
      setGreenWeight('15'); setSelectedOrigin(''); setSelectedOperator('');
      showToast(`✅ קלייה נרשמה! Batch: ${batchNum} | ${weight} ק"ג ירוק → ${roastedWeight} ק"ג קלוי`);
    } catch (error) {
      console.error('Error recording roast:', error);
      showToast('❌ שגיאה ברישום קלייה', 'error');
    }
  };

  // ── EDIT ──────────────────────────────────────────────────────────────────────

  const startEditRoast = (roast) => {
    setEditingRoast({ id: roast.id, originId: roast.origin_id, greenWeight: roast.green_weight, operator: roast.operator, oldGreenWeight: roast.green_weight, oldOriginId: roast.origin_id });
  };

  const saveEditRoast = async () => {
    if (!editingRoast.originId || !editingRoast.greenWeight || !editingRoast.operator) {
      showToast('⚠️ נא למלא את כל השדות', 'warning'); return;
    }
    const newOrigin = getOriginById(editingRoast.originId);
    const oldOrigin = getOriginById(editingRoast.oldOriginId);
    if (!newOrigin || !oldOrigin) { showToast('⚠️ זן לא נמצא', 'warning'); return; }

    const newWeight       = parseFloat(editingRoast.greenWeight);
    const newRoastedWeight = parseFloat(calculateRoastedWeight(newWeight, newOrigin.weight_loss));
    const oldWeight       = parseFloat(editingRoast.oldGreenWeight);
    const oldRoastedWeight = parseFloat(calculateRoastedWeight(oldWeight, oldOrigin.weight_loss));

    try {
      await roastsDb.update(editingRoast.id, {
        origin_id: newOrigin.id, green_weight: newWeight, roasted_weight: newRoastedWeight,
        operator: editingRoast.operator, updated_at: new Date().toISOString()
      });
      if (oldOrigin.id === newOrigin.id) {
        const stockDiff  = newWeight - oldWeight;
        const roastedDiff = newRoastedWeight - oldRoastedWeight;
        await originsDb.update(oldOrigin.id, {
          stock: oldOrigin.stock - stockDiff,
          roasted_stock: (oldOrigin.roasted_stock || 0) + roastedDiff
        });
      } else {
        await originsDb.update(oldOrigin.id, { stock: oldOrigin.stock + oldWeight, roasted_stock: (oldOrigin.roasted_stock || 0) - oldRoastedWeight });
        await originsDb.update(newOrigin.id, { stock: newOrigin.stock - newWeight, roasted_stock: (newOrigin.roasted_stock || 0) + newRoastedWeight });
      }
      await roastsDb.refresh();
      await originsDb.refresh();
      setEditingRoast(null);
      showToast('✅ קלייה עודכנה!');
    } catch (error) {
      console.error('Error updating roast:', error);
      showToast('❌ שגיאה בעדכון קלייה', 'error');
    }
  };

  // ── DELETE ────────────────────────────────────────────────────────────────────

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
      showToast('✅ קלייה נמחקה והמלאי הוחזר!');
    } catch (error) {
      console.error('Error deleting roast:', error);
      showToast('❌ שגיאה במחיקת קלייה', 'error');
    }
  };

  // ── BULK DELETE ───────────────────────────────────────────────────────────────

  const toggleRoastSelection  = (id) => setSelectedRoasts(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll       = () => setSelectedRoasts(selectedRoasts.length === displayedRoasts.length ? [] : displayedRoasts.map(r => r.id));

  const deleteSelectedRoasts = async () => {
    if (selectedRoasts.length === 0) { showToast('⚠️ לא נבחרו קליות למחיקה', 'warning'); return; }
    if (!window.confirm(`⚠️ האם למחוק ${selectedRoasts.length} קליות?\n\nהמלאי יוחזר אוטומטית.`)) return;
    try {
      for (const roastId of selectedRoasts) {
        const roast = data.roasts.find(r => r.id === roastId);
        if (roast) {
          await roastsDb.remove(roast.id);
          const origin = getOriginById(roast.origin_id);
          if (origin) {
            await originsDb.update(origin.id, { stock: origin.stock + roast.green_weight, roasted_stock: (origin.roasted_stock || 0) - roast.roasted_weight });
          }
        }
      }
      await roastsDb.refresh();
      await originsDb.refresh();
      const count = selectedRoasts.length;
      setSelectedRoasts([]);
      showToast(`✅ ${count} קליות נמחקו והמלאי הוחזר!`);
    } catch (error) {
      console.error('Error deleting roasts:', error);
      showToast('❌ שגיאה במחיקת קליות', 'error');
    }
  };

  // ── FILTERING ─────────────────────────────────────────────────────────────────

  const getFilteredRoasts = () => {
    let filtered = [...data.roasts];
    const now      = new Date();
    const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo  = new Date(today.getTime() - 7  * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (dateFilter === 'today')  filtered = filtered.filter(r => new Date(r.date) >= today);
    if (dateFilter === 'week')   filtered = filtered.filter(r => new Date(r.date) >= weekAgo);
    if (dateFilter === 'month')  filtered = filtered.filter(r => new Date(r.date) >= monthAgo);
    if (dateFilter === 'custom') {
      if (startDate) { const s = new Date(startDate); s.setHours(0,0,0,0); filtered = filtered.filter(r => new Date(r.date) >= s); }
      if (endDate)   { const e = new Date(endDate);   e.setHours(23,59,59,999); filtered = filtered.filter(r => new Date(r.date) <= e); }
    }
    if (searchTerm) {
      filtered = filtered.filter(r => {
        const origin = getOriginById(r.origin_id);
        return origin?.name?.toLowerCase().includes(searchTerm.toLowerCase())
          || r.operator?.toLowerCase().includes(searchTerm.toLowerCase());
      });
    }
    return filtered.slice().reverse();
  };

  const filteredRoasts  = getFilteredRoasts();
  const displayedRoasts = filteredRoasts.slice(0, displayLimit);
  const hasMore         = filteredRoasts.length > displayLimit;

  // ── RENDER ────────────────────────────────────────────────────────────────────

  if (view === 'list') {
    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>📋 רשימת קלייה</h1>
          <button onClick={() => setView('log')} className="btn-small">← חזור לרישום</button>
        </div>
        <RoastingList data={data} originsDb={originsDb} roastsDb={roastsDb} showToast={showToast} />
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>🔥 רישום קלייה</h1>
        <button onClick={() => setView('list')} className="btn-small" style={{ background: '#6F4E37', color: 'white' }}>
          📋 רשימת קלייה
        </button>
      </div>

      {/* Edit form */}
      {editingRoast && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
          <h3>✏️ עריכת קלייה</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>זן</label>
              <select value={editingRoast.originId} onChange={e => setEditingRoast({...editingRoast, originId: parseInt(e.target.value)})}>
                <option value="">בחר זן...</option>
                {data.origins.map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {o.stock} ק"ג)</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>משקל ירוק (ק"ג)</label>
              <input type="number" step="0.1" value={editingRoast.greenWeight} onChange={e => setEditingRoast({...editingRoast, greenWeight: e.target.value})} />
            </div>
            <div className="form-group">
              <label>מפעיל</label>
              <select value={editingRoast.operator} onChange={e => setEditingRoast({...editingRoast, operator: e.target.value})}>
                <option value="">בחר מפעיל...</option>
                {data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}
              </select>
            </div>
          </div>
          {editingRoast.originId && editingRoast.greenWeight && (
            <div className="calculation-display">
              משקל קלוי משוער: <strong>{calculateRoastedWeight(editingRoast.greenWeight, getOriginById(editingRoast.originId)?.weight_loss || 20)} ק"ג</strong>
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={saveEditRoast} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
            <button onClick={() => setEditingRoast(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* New roast form */}
      <div className="form-card">
        <div className="form-grid">
          <div className="form-group">
            <label>בחר זן לקלייה</label>
            <select value={selectedOrigin} onChange={e => setSelectedOrigin(e.target.value)}>
              <option value="">בחר זן...</option>
              {data.origins.filter(o => o.stock > 0).map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {o.stock} ק"ג)</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>משקל ירוק (ק"ג)</label>
            <input type="number" step="0.1" placeholder="15" value={greenWeight} onChange={e => setGreenWeight(e.target.value)} />
          </div>
          <div className="form-group">
            <label>מפעיל</label>
            <select value={selectedOperator} onChange={e => setSelectedOperator(e.target.value)}>
              <option value="">בחר מפעיל...</option>
              {data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}
            </select>
          </div>
        </div>
        {selectedOrigin && greenWeight && (
          <div className="calculation-display">
            <div>איבוד משקל: <strong>{getOriginById(parseInt(selectedOrigin))?.weight_loss}%</strong></div>
            <div>משקל קלוי צפוי: <strong>{calculateRoastedWeight(greenWeight, getOriginById(parseInt(selectedOrigin))?.weight_loss || 20)} ק"ג</strong></div>
          </div>
        )}
        <button onClick={recordRoast} className="btn-primary">🔥 רשום קלייה</button>
      </div>

      {/* History + filters */}
      <div className="section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2>📋 היסטוריית קליות ({filteredRoasts.length})</h2>
          {selectedRoasts.length > 0 && (
            <button onClick={deleteSelectedRoasts} className="btn-small" style={{ background: '#DC2626', color: 'white' }}>
              🗑️ מחק נבחרים ({selectedRoasts.length})
            </button>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <input type="text" placeholder="🔍 חיפוש..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="search-input" style={{ maxWidth: '200px' }} />
          <select value={dateFilter} onChange={e => setDateFilter(e.target.value)} className="sort-select">
            <option value="all">כל הזמן</option>
            <option value="today">היום</option>
            <option value="week">שבוע אחרון</option>
            <option value="month">חודש אחרון</option>
            <option value="custom">תאריכים מותאמים</option>
          </select>
          {dateFilter === 'custom' && (
            <>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="sort-select" />
              <input type="date" value={endDate}   onChange={e => setEndDate(e.target.value)}   className="sort-select" />
            </>
          )}
        </div>

        {filteredRoasts.length === 0 ? (
          <div className="empty-state">אין קליות עדיין. רשום קלייה ראשונה!</div>
        ) : (
          <>
            <div style={{ marginBottom: '0.5rem' }}>
              <label style={{ cursor: 'pointer', fontSize: '0.9rem', color: '#666' }}>
                <input type="checkbox" checked={selectedRoasts.length === displayedRoasts.length && displayedRoasts.length > 0} onChange={toggleSelectAll} style={{ marginLeft: '0.5rem' }} />
                בחר הכל
              </label>
            </div>
            <div className="roasts-list">
              {displayedRoasts.map(roast => {
                const origin = getOriginById(roast.origin_id);
                const isSelected = selectedRoasts.includes(roast.id);
                return (
                  <div key={roast.id} className="roast-card" style={{ border: isSelected ? '2px solid #3B82F6' : undefined }}>
                    <div className="roast-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleRoastSelection(roast.id)} onClick={e => e.stopPropagation()} />
                        <h3>{origin?.name || 'זן לא ידוע'}</h3>
                        {roast.batch_number && <span style={{ fontSize: '0.75rem', color: '#999', background: '#F3F4F6', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{roast.batch_number}</span>}
                      </div>
                      <div className="roast-actions">
                        <button onClick={() => startEditRoast(roast)} className="btn-icon">✏️</button>
                        <button onClick={() => deleteRoast(roast)} className="btn-icon">🗑️</button>
                      </div>
                    </div>
                    <div className="roast-details">
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
                <button onClick={() => setDisplayLimit(displayLimit + 20)} className="btn-small" style={{ background: '#6F4E37', color: 'white', padding: '0.75rem 2rem' }}>
                  ⬇️ טען עוד 20 קליות
                </button>
                <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#999' }}>מציג {displayedRoasts.length} מתוך {filteredRoasts.length}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
