import React, { useState } from 'react';
import { useApp } from '../../lib/context';

export default function Origins() {
  const { data, originsDb, getOriginById, showToast } = useApp();

  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy]         = useState('name');
  const [editingOrigin, setEditingOrigin] = useState(null);
  const [activeForm, setActiveForm]       = useState(null); // 'stock-in' | 'stock-out' | null
  const [newOrigin, setNewOrigin] = useState({
    name: '', weightLoss: 20, costPerKg: '', stock: 0, minStock: 10, dailyAverage: 0, notes: ''
  });
  const [stockEntry, setStockEntry] = useState({ originId: '', quantity: '', notes: '' });
  const [stockOut,   setStockOut]   = useState({ originId: '', quantity: '', notes: '' });

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  const addOrigin = async () => {
    if (!newOrigin.name || !newOrigin.costPerKg) {
      showToast('⚠️ נא למלא שם ועלות', 'warning');
      return;
    }
    try {
      await originsDb.insert({
        name:          newOrigin.name,
        weight_loss:   parseFloat(newOrigin.weightLoss),
        cost_per_kg:   parseFloat(newOrigin.costPerKg),
        stock:         parseFloat(newOrigin.stock) || 0,
        roasted_stock: 0,
        min_stock:     parseFloat(newOrigin.minStock) || 10,
        daily_average: parseFloat(newOrigin.dailyAverage) || 0,
        notes:         newOrigin.notes
      });
      await originsDb.refresh();
      setNewOrigin({ name: '', weightLoss: 20, costPerKg: '', stock: 0, minStock: 10, dailyAverage: 0, notes: '' });
      showToast('✅ זן נוסף בהצלחה!');
    } catch (error) {
      console.error('Error adding origin:', error);
      showToast('❌ שגיאה בהוספת זן', 'error');
    }
  };

  const startEdit = (origin) => {
    setEditingOrigin({
      id:           origin.id,
      name:         origin.name,
      weightLoss:   origin.weight_loss,
      costPerKg:    origin.cost_per_kg,
      stock:        origin.stock,
      roastedStock: origin.roasted_stock || 0,
      minStock:     origin.min_stock || 10,
      dailyAverage: origin.daily_average || 0,
      notes:        origin.notes || ''
    });
  };

  const saveEdit = async () => {
    if (!editingOrigin.name || !editingOrigin.costPerKg) {
      showToast('⚠️ נא למלא שם ועלות', 'warning');
      return;
    }
    try {
      await originsDb.update(editingOrigin.id, {
        name:          editingOrigin.name,
        weight_loss:   parseFloat(editingOrigin.weightLoss),
        cost_per_kg:   parseFloat(editingOrigin.costPerKg),
        stock:         parseFloat(editingOrigin.stock),
        roasted_stock: parseFloat(editingOrigin.roastedStock) || 0,
        min_stock:     parseFloat(editingOrigin.minStock) || 10,
        daily_average: parseFloat(editingOrigin.dailyAverage) || 0,
        notes:         editingOrigin.notes,
        updated_at:    new Date().toISOString()
      });
      await originsDb.refresh();
      setEditingOrigin(null);
      showToast('✅ זן עודכן בהצלחה!');
    } catch (error) {
      console.error('Error updating origin:', error);
      showToast('❌ שגיאה בעדכון זן', 'error');
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
      showToast('✅ זן נמחק!');
    } catch (error) {
      console.error('Error deleting origin:', error);
      showToast('❌ שגיאה במחיקת זן', 'error');
    }
  };

  const duplicateOrigin = async (origin) => {
    try {
      await originsDb.insert({
        name: origin.name + ' (עותק)',
        weight_loss: origin.weight_loss,
        cost_per_kg: origin.cost_per_kg,
        stock: 0, roasted_stock: 0,
        notes: origin.notes
      });
      showToast('✅ זן שוכפל בהצלחה!');
    } catch (error) {
      console.error('Error duplicating origin:', error);
      showToast('❌ שגיאה בשכפול זן', 'error');
    }
  };

  // ── STOCK IN / OUT ────────────────────────────────────────────────────────────

  const addStockEntry = async () => {
    if (!stockEntry.originId || !stockEntry.quantity) {
      showToast('⚠️ נא לבחור זן ולהזין כמות', 'warning');
      return;
    }
    const quantity = parseFloat(stockEntry.quantity);
    if (quantity <= 0) { showToast('⚠️ כמות חייבת להיות גדולה מ-0', 'warning'); return; }

    const origin = getOriginById(parseInt(stockEntry.originId));
    if (!origin) { showToast('⚠️ זן לא נמצא', 'warning'); return; }

    try {
      const newStock = (origin.stock || 0) + quantity;
      await originsDb.update(origin.id, { stock: newStock });
      await originsDb.refresh();
      setStockEntry({ originId: '', quantity: '', notes: '' });
      showToast(`✅ הוספת ${quantity} ק"ג ל${origin.name} • מלאי חדש: ${newStock} ק"ג`);
    } catch (error) {
      console.error('Error adding stock:', error);
      showToast('❌ שגיאה בהוספת מלאי', 'error');
    }
  };

  const removeStockForPackaging = async () => {
    if (!stockOut.originId || !stockOut.quantity) {
      showToast('⚠️ נא לבחור זן ולהזין כמות', 'warning');
      return;
    }
    const quantity = parseFloat(stockOut.quantity);
    if (quantity <= 0) { showToast('⚠️ כמות חייבת להיות גדולה מ-0', 'warning'); return; }

    const origin = getOriginById(parseInt(stockOut.originId));
    if (!origin) { showToast('⚠️ זן לא נמצא', 'warning'); return; }

    const currentRoastedStock = origin.roasted_stock || 0;
    if (quantity > currentRoastedStock) {
      showToast(`⚠️ אין מספיק מלאי קלוי! קיים: ${currentRoastedStock} ק"ג`, 'warning');
      return;
    }

    try {
      const newRoastedStock = currentRoastedStock - quantity;
      await originsDb.update(origin.id, { roasted_stock: newRoastedStock });
      await originsDb.refresh();
      setStockOut({ originId: '', quantity: '', notes: '' });
      showToast(`✅ הוצאו ${quantity} ק"ג מ${origin.name} לאריזה • נותר: ${newRoastedStock} ק"ג`);
    } catch (error) {
      console.error('Error removing stock:', error);
      showToast('❌ שגיאה בהוצאת מלאי', 'error');
    }
  };

  // ── CSV EXPORT ────────────────────────────────────────────────────────────────

  const exportToCSV = () => {
    const headers = ['שם,איבוד משקל %,עלות ק"ג,מלאי ק"ג,מלאי קלוי ק"ג,הערות'];
    const rows = filteredOrigins.map(o =>
      `"${o.name}",${o.weight_loss},${o.cost_per_kg},${o.stock || 0},${o.roasted_stock || 0},"${o.notes || ''}"`
    );
    const csv = [...headers, ...rows].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `coffeeflow-origins-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  // ── DERIVED DATA ──────────────────────────────────────────────────────────────

  const filteredOrigins = data.origins
    .filter(o => o.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'name')  return a.name.localeCompare(b.name);
      if (sortBy === 'stock') return (b.stock || 0) - (a.stock || 0);
      if (sortBy === 'cost')  return (b.cost_per_kg || 0) - (a.cost_per_kg || 0);
      return 0;
    });

  // ── RENDER ────────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>🌱 ניהול זנים ({data.origins.length})</h1>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={() => setActiveForm('stock-in')}  className="btn-primary" style={{ background: '#10B981' }}>📦 קליטת מלאי</button>
          <button onClick={() => setActiveForm('stock-out')} className="btn-primary" style={{ background: '#F59E0B' }}>📤 הוצאה לאריזה</button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="🔍 חיפוש זן..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="search-input" />
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="sort-select">
          <option value="name">מיון לפי שם</option>
          <option value="stock">מיון לפי מלאי</option>
          <option value="cost">מיון לפי מחיר</option>
        </select>
        <button onClick={exportToCSV} className="btn-small">📥 ייצא CSV</button>
      </div>

      {/* Stock-in form */}
      {activeForm === 'stock-in' && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#F0FDF4', border: '2px solid #10B981' }}>
          <h3>📦 קליטת מלאי חדש</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>בחר זן *</label>
              <select value={stockEntry.originId} onChange={e => setStockEntry({...stockEntry, originId: e.target.value})}>
                <option value="">בחר זן...</option>
                {data.origins.map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {o.stock || 0} ק"ג)</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>כמות להוספה (ק"ג) *</label>
              <input type="number" step="0.1" placeholder="למשל: 25" value={stockEntry.quantity} onChange={e => setStockEntry({...stockEntry, quantity: e.target.value})} />
            </div>
          </div>
          <div className="form-group">
            <label>הערות (אופציונלי)</label>
            <textarea placeholder="למשל: ספק חדש, מספר הזמנה..." value={stockEntry.notes} onChange={e => setStockEntry({...stockEntry, notes: e.target.value})} rows="2" />
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={addStockEntry} className="btn-primary" style={{ flex: 1, background: '#10B981' }}>✅ הוסף למלאי</button>
            <button onClick={() => { setActiveForm(null); setStockEntry({ originId: '', quantity: '', notes: '' }); }} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* Stock-out form */}
      {activeForm === 'stock-out' && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#FFFBEB', border: '2px solid #F59E0B' }}>
          <h3>📤 הוצאה לאריזה</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>בחר זן *</label>
              <select
                value={stockOut.originId}
                onChange={e => {
                  const originId = e.target.value;
                  const origin = getOriginById(parseInt(originId));
                  const yieldPercent = origin ? (1 - (origin.weight_loss / 100)) : 1;
                  const defaultWeight = (15 * yieldPercent).toFixed(1);
                  setStockOut({ ...stockOut, originId, quantity: originId ? defaultWeight : '' });
                }}
              >
                <option value="">בחר זן...</option>
                {data.origins.map(o => <option key={o.id} value={o.id}>{o.name} (מלאי קלוי: {o.roasted_stock || 0} ק"ג)</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>משקל להוצאה (ק"ג) *</label>
              <input type="number" step="0.1" placeholder="משקל דלי" value={stockOut.quantity} onChange={e => setStockOut({...stockOut, quantity: e.target.value})} />
              {stockOut.originId && <small style={{ color: '#666', marginTop: '0.25rem', display: 'block' }}>ברירת מחדל: משקל אחרי קלייה (15 ק"ג ירוק)</small>}
            </div>
          </div>
          <div className="form-group">
            <label>הערות (אופציונלי)</label>
            <textarea placeholder="למשל: דלי #1234, מיועד לאריזה..." value={stockOut.notes} onChange={e => setStockOut({...stockOut, notes: e.target.value})} rows="2" />
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={removeStockForPackaging} className="btn-primary" style={{ flex: 1, background: '#F59E0B' }}>✅ הוצא מהמלאי</button>
            <button onClick={() => { setActiveForm(null); setStockOut({ originId: '', quantity: '', notes: '' }); }} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* Add new origin form */}
      {!editingOrigin && !activeForm && (
        <div className="form-card">
          <h3>➕ הוסף זן חדש</h3>
          <div className="form-grid">
            <div className="form-group"><label>שם הזן</label><input type="text" placeholder="למשל: ברזיל סנטוס" value={newOrigin.name} onChange={e => setNewOrigin({...newOrigin, name: e.target.value})} /></div>
            <div className="form-group"><label>איבוד משקל בקלייה (%)</label><input type="number" value={newOrigin.weightLoss} onChange={e => setNewOrigin({...newOrigin, weightLoss: e.target.value})} /></div>
            <div className="form-group"><label>עלות לק"ג (₪)</label><input type="number" step="0.01" placeholder="45.00" value={newOrigin.costPerKg} onChange={e => setNewOrigin({...newOrigin, costPerKg: e.target.value})} /></div>
            <div className="form-group"><label>מלאי התחלתי (ק"ג)</label><input type="number" step="0.1" value={newOrigin.stock} onChange={e => setNewOrigin({...newOrigin, stock: e.target.value})} /></div>
            <div className="form-group"><label>מלאי מינימום (ק"ג)</label><input type="number" step="0.1" value={newOrigin.minStock} onChange={e => setNewOrigin({...newOrigin, minStock: e.target.value})} placeholder="10" /></div>
          </div>
          <div className="form-group"><label>הערות</label><textarea placeholder="פרטים נוספים..." value={newOrigin.notes} onChange={e => setNewOrigin({...newOrigin, notes: e.target.value})} rows="2" /></div>
          <button onClick={addOrigin} className="btn-primary">➕ הוסף זן</button>
        </div>
      )}

      {/* Origins table */}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>שם</th>
              <th>איבוד משקל</th>
              <th>עלות/ק"ג ירוק</th>
              <th>עלות/ק"ג קלוי</th>
              <th>מלאי ירוק</th>
              <th>מלאי קלוי</th>
              <th>ממוצע יומי</th>
              <th>מלאי מינימום</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrigins.map(origin => {
              const isEditing = editingOrigin?.id === origin.id;
              const yieldPercent      = 1 - (origin.weight_loss / 100);
              const costPerKgRoasted  = (origin.cost_per_kg / yieldPercent).toFixed(2);
              const minStock          = origin.min_stock || 10;
              const isLowStock        = (origin.stock || 0) < minStock && (origin.stock || 0) > 0;
              const isOutOfStock      = (origin.stock || 0) === 0;
              const stockStyle        = isOutOfStock
                ? { background: '#FEE2E2', color: '#DC2626', fontWeight: 'bold' }
                : isLowStock
                  ? { background: '#FEF3C7', color: '#D97706', fontWeight: 'bold' }
                  : {};

              if (isEditing) {
                return (
                  <tr key={origin.id} style={{ background: '#FFF9F0', borderTop: '2px solid #FF6B35', borderBottom: '2px solid #FF6B35' }}>
                    <td><input type="text" value={editingOrigin.name} onChange={e => setEditingOrigin({...editingOrigin, name: e.target.value})} style={{ width: '100%', minWidth: '120px' }} /></td>
                    <td><input type="number" value={parseFloat(editingOrigin.weightLoss || 0).toFixed(2)} onChange={e => setEditingOrigin({...editingOrigin, weightLoss: e.target.value})} style={{ width: '70px' }} />%</td>
                    <td><input type="number" step="0.01" value={parseFloat(editingOrigin.costPerKg || 0).toFixed(2)} onChange={e => setEditingOrigin({...editingOrigin, costPerKg: e.target.value})} style={{ width: '80px' }} /></td>
                    <td>₪{(parseFloat(editingOrigin.costPerKg) / (1 - parseFloat(editingOrigin.weightLoss) / 100)).toFixed(2)}</td>
                    <td><input type="number" step="0.1" value={parseFloat(editingOrigin.stock || 0).toFixed(2)} onChange={e => setEditingOrigin({...editingOrigin, stock: e.target.value})} style={{ width: '70px' }} /></td>
                    <td><input type="number" step="0.1" value={parseFloat(editingOrigin.roastedStock || 0).toFixed(2)} onChange={e => setEditingOrigin({...editingOrigin, roastedStock: e.target.value})} style={{ width: '70px' }} /></td>
                    <td><input type="number" step="0.1" value={parseFloat(editingOrigin.dailyAverage || 0).toFixed(2)} onChange={e => setEditingOrigin({...editingOrigin, dailyAverage: e.target.value})} style={{ width: '70px' }} /></td>
                    <td><input type="number" step="0.1" value={parseFloat(editingOrigin.minStock || 0).toFixed(2)} onChange={e => setEditingOrigin({...editingOrigin, minStock: e.target.value})} style={{ width: '70px' }} /></td>
                    <td>
                      <div className="action-buttons">
                        <button onClick={saveEdit} className="btn-icon" title="שמור">💾</button>
                        <button onClick={() => setEditingOrigin(null)} className="btn-icon" title="ביטול">❌</button>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={origin.id} style={isOutOfStock ? { background: '#FEE2E2' } : isLowStock ? { background: '#FFFBEB' } : {}}>
                  <td>
                    <strong>{origin.name}</strong>
                    {isOutOfStock && <span style={{ color: '#DC2626', marginRight: '0.5rem' }}> ❌</span>}
                    {isLowStock   && <span style={{ color: '#F59E0B', marginRight: '0.5rem' }}> ⚠️</span>}
                  </td>
                  <td>{origin.weight_loss}%</td>
                  <td>₪{parseFloat(origin.cost_per_kg || 0).toFixed(2)}</td>
                  <td>₪{costPerKgRoasted}</td>
                  <td style={stockStyle}>
                    {parseFloat(origin.stock || 0).toFixed(2)} ק"ג
                    {isLowStock && <span style={{ fontSize: '0.8em', color: '#D97706' }}> (מינימום: {minStock})</span>}
                  </td>
                  <td>{parseFloat(origin.roasted_stock || 0).toFixed(2)} ק"ג</td>
                  <td>{parseFloat(origin.daily_average || 0).toFixed(2)} ק"ג</td>
                  <td>{parseFloat(origin.min_stock || 0).toFixed(2)} ק"ג</td>
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

      {filteredOrigins.length === 0 && (
        <div className="empty-state">
          {searchTerm ? 'לא נמצאו תוצאות' : 'אין זנים עדיין. הוסף זן ראשון!'}
        </div>
      )}
    </div>
  );
}
