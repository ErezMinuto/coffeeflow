import React, { useState } from 'react';
import { useApp } from '../../lib/context';

// ── Helpers ───────────────────────────────────────────────────────────────────

const calcDeductions = (product, bags, origins, roastProfiles) => {
  const sizeKg = product.size / 1000;
  return (product.recipe || []).map(ing => {
    const kgPerBag = sizeKg * (ing.percentage / 100);
    const kgNeeded = bags * kgPerBag;
    if (ing.sourceType === 'profile' && ing.sourceId) {
      const profile = roastProfiles.find(p => p.id === ing.sourceId);
      return profile ? {
        type: 'profile', item: profile, kgNeeded, kgPerBag,
        minStock: profile.min_stock ?? null
      } : null;
    } else {
      const originId = ing.sourceId || ing.originId;
      const origin = origins.find(o => o.id === originId);
      return origin ? {
        type: 'origin', item: origin, kgNeeded, kgPerBag,
        minStock: origin.critical_stock ?? null
      } : null;
    }
  }).filter(Boolean);
};

const formatDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};

// ── Packaging ─────────────────────────────────────────────────────────────────

export default function Packaging() {
  const {
    data, originsDb, roastProfilesDb, productsDb, packingLogsDb, showToast
  } = useApp();

  const [packProductId, setPackProductId] = useState('');
  const [packBags,      setPackBags]      = useState('');
  const [submitting,    setSubmitting]    = useState(false);
  const [editingLogId,  setEditingLogId]  = useState(null);
  const [editBags,      setEditBags]      = useState('');

  const selectedProduct = data.products.find(p => p.id === parseInt(packProductId));
  const bags            = parseInt(packBags) || 0;
  const deductions      = selectedProduct && bags > 0
    ? calcDeductions(selectedProduct, bags, data.origins, data.roastProfiles)
    : [];
  const shortages = deductions.filter(d => (d.item.roasted_stock || 0) < d.kgNeeded);

  // ── Record new packing ────────────────────────────────────────────────────

  const recordPacking = async () => {
    if (!selectedProduct) { showToast('⚠️ נא לבחור מוצר', 'warning'); return; }
    if (bags <= 0)         { showToast('⚠️ נא להזין כמות שקיות', 'warning'); return; }
    if (shortages.length > 0) {
      const msg = shortages.map(s =>
        `${s.item.name}: יש ${(s.item.roasted_stock || 0).toFixed(1)} ק"ג, צריך ${s.kgNeeded.toFixed(2)} ק"ג`
      ).join(' | ');
      showToast(`⛔ אין מספיק מלאי קלוי: ${msg}`, 'error');
      return;
    }

    setSubmitting(true);
    try {
      for (const d of deductions) {
        const newStock = parseFloat(((d.item.roasted_stock || 0) - d.kgNeeded).toFixed(3));
        if (d.type === 'origin') await originsDb.update(d.item.id, { roasted_stock: newStock });
        else                     await roastProfilesDb.update(d.item.id, { roasted_stock: newStock });
      }

      await productsDb.update(selectedProduct.id, {
        packed_stock: (selectedProduct.packed_stock || 0) + bags
      });

      await packingLogsDb.insert({
        product_id:       selectedProduct.id,
        product_name:     `${selectedProduct.name} ${selectedProduct.size}g`,
        bags_count:       bags,
        // Store source_id, type and kg_per_bag so edits/cancels can reverse exactly
        roasted_deducted: deductions.map(d => ({
          name:       d.item.name,
          kg:         parseFloat(d.kgNeeded.toFixed(3)),
          kg_per_bag: parseFloat(d.kgPerBag.toFixed(6)),
          type:       d.type,
          source_id:  d.item.id,
        })),
        reported_by: 'מערכת',
      });

      showToast(`✅ נרשמה אריזה: ${bags} שקיות ${selectedProduct.name} ${selectedProduct.size}g`);
      setPackProductId('');
      setPackBags('');

      for (const d of deductions) {
        const remaining = (d.item.roasted_stock || 0) - d.kgNeeded;
        if (d.minStock !== null && remaining < d.minStock) {
          showToast(`⚠️ מלאי נמוך: ${d.item.name} נותרו ${remaining.toFixed(1)} ק"ג`, 'warning');
        }
      }
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה ברישום האריזה', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Cancel (delete + return stock) ────────────────────────────────────────

  const cancelPacking = async (log) => {
    if (!window.confirm(`ביטול אריזה של ${log.bags_count} שקיות ${log.product_name}?\n\nהמלאי הקלוי יוחזר אוטומטית.`)) return;

    try {
      const deducted = Array.isArray(log.roasted_deducted) ? log.roasted_deducted : [];

      // Return roasted stock
      for (const d of deducted) {
        if (!d.source_id || !d.type) continue;
        if (d.type === 'origin') {
          const origin = data.origins.find(o => o.id === d.source_id);
          if (origin) await originsDb.update(origin.id, { roasted_stock: parseFloat(((origin.roasted_stock || 0) + d.kg).toFixed(3)) });
        } else {
          const profile = data.roastProfiles.find(p => p.id === d.source_id);
          if (profile) await roastProfilesDb.update(profile.id, { roasted_stock: parseFloat(((profile.roasted_stock || 0) + d.kg).toFixed(3)) });
        }
      }

      // Return packed_stock
      const product = data.products.find(p => p.id === log.product_id);
      if (product) {
        await productsDb.update(product.id, {
          packed_stock: Math.max(0, (product.packed_stock || 0) - log.bags_count)
        });
      }

      await packingLogsDb.remove(log.id);
      showToast('✅ האריזה בוטלה והמלאי הוחזר');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בביטול האריזה', 'error');
    }
  };

  // ── Edit (change bag count, adjust stocks by delta) ───────────────────────

  const startEdit = (log) => {
    setEditingLogId(log.id);
    setEditBags(String(log.bags_count));
  };

  const saveEdit = async (log) => {
    const newBags = parseInt(editBags);
    if (isNaN(newBags) || newBags <= 0) { showToast('⚠️ כמות לא תקינה', 'warning'); return; }
    if (newBags === log.bags_count) { setEditingLogId(null); return; }

    const delta    = newBags - log.bags_count; // positive = more bags, negative = fewer
    const deducted = Array.isArray(log.roasted_deducted) ? log.roasted_deducted : [];

    // Check we have enough stock if adding more bags
    if (delta > 0) {
      for (const d of deducted) {
        if (!d.source_id || !d.kg_per_bag) continue;
        const extraKg = delta * d.kg_per_bag;
        const source  = d.type === 'origin'
          ? data.origins.find(o => o.id === d.source_id)
          : data.roastProfiles.find(p => p.id === d.source_id);
        if (source && (source.roasted_stock || 0) < extraKg) {
          showToast(`⛔ אין מספיק מלאי קלוי: ${d.name} נותרו ${(source.roasted_stock || 0).toFixed(1)} ק"ג`, 'error');
          return;
        }
      }
    }

    try {
      // Adjust roasted stock by delta
      const newDeducted = deducted.map(d => ({ ...d }));
      for (const d of newDeducted) {
        if (!d.source_id || !d.kg_per_bag) continue;
        const deltaKg  = delta * d.kg_per_bag;
        d.kg           = parseFloat((d.kg + deltaKg).toFixed(3));

        if (d.type === 'origin') {
          const origin = data.origins.find(o => o.id === d.source_id);
          if (origin) await originsDb.update(origin.id, { roasted_stock: parseFloat(((origin.roasted_stock || 0) - deltaKg).toFixed(3)) });
        } else {
          const profile = data.roastProfiles.find(p => p.id === d.source_id);
          if (profile) await roastProfilesDb.update(profile.id, { roasted_stock: parseFloat(((profile.roasted_stock || 0) - deltaKg).toFixed(3)) });
        }
      }

      // Adjust packed_stock
      const product = data.products.find(p => p.id === log.product_id);
      if (product) {
        await productsDb.update(product.id, {
          packed_stock: Math.max(0, (product.packed_stock || 0) + delta)
        });
      }

      // Update the log record
      await packingLogsDb.update(log.id, {
        bags_count:       newBags,
        roasted_deducted: newDeducted,
      });

      setEditingLogId(null);
      showToast('✅ אריזה עודכנה');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בעדכון האריזה', 'error');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const sortedLogs = [...data.packingLogs].sort((a, b) => new Date(b.packed_at) - new Date(a.packed_at));

  return (
    <div className="page">
      <div style={{ marginBottom: '20px' }}>
        <h1>🎁 אריזה</h1>
      </div>

      {/* Packing form */}
      <div className="form-card" style={{ marginBottom: '24px', background: '#F0FFF4', border: '2px solid #059669' }}>
        <h3>רישום אריזה</h3>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>מוצר *</label>
            <select value={packProductId} onChange={e => setPackProductId(e.target.value)}>
              <option value="">בחר מוצר...</option>
              {data.products.map(p => (
                <option key={p.id} value={p.id}>{p.name} {p.size}g</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>כמות שקיות *</label>
            <input
              type="number" min="1" placeholder="0"
              value={packBags}
              onChange={e => setPackBags(e.target.value)}
            />
          </div>
        </div>

        {/* Live deduction preview */}
        {deductions.length > 0 && (
          <div style={{
            background: shortages.length > 0 ? '#FEF2F2' : '#F0FFF4',
            border: `1px solid ${shortages.length > 0 ? '#FCA5A5' : '#6EE7B7'}`,
            borderRadius: '6px', padding: '10px', marginBottom: '1rem', fontSize: '13px'
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: '6px', color: shortages.length > 0 ? '#DC2626' : '#065F46' }}>
              {shortages.length > 0 ? '⛔ חסר מלאי קלוי:' : '♻️ ינוכה מהמלאי הקלוי:'}
            </div>
            {deductions.map((d, i) => {
              const current  = d.item.roasted_stock || 0;
              const shortage = current < d.kgNeeded;
              return (
                <div key={i} style={{ color: shortage ? '#DC2626' : '#374151', marginBottom: '2px' }}>
                  {shortage ? '❌' : '✓'} {d.item.name}: {d.kgNeeded.toFixed(2)} ק"ג
                  <span style={{ color: '#6B7280', marginRight: '6px' }}>(במלאי: {current.toFixed(1)} ק"ג)</span>
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={recordPacking}
          className="btn-primary"
          disabled={submitting || !packProductId || !packBags || shortages.length > 0}
          style={{ width: '100%' }}
        >
          {submitting ? '⏳ שומר...' : '✅ שמור אריזה'}
        </button>
      </div>

      {/* Packing history */}
      <h3 style={{ marginBottom: '12px' }}>📋 היסטוריית אריזות ({sortedLogs.length})</h3>

      {sortedLogs.length === 0 ? (
        <div className="empty-state">אין רישומי אריזה עדיין.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ background: '#F4E8D8', textAlign: 'right' }}>
                <th style={{ padding: '8px 12px' }}>תאריך</th>
                <th style={{ padding: '8px 12px' }}>מוצר</th>
                <th style={{ padding: '8px 12px' }}>שקיות</th>
                <th style={{ padding: '8px 12px' }}>ניכוי מלאי קלוי</th>
                <th style={{ padding: '8px 12px' }}>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {sortedLogs.map((log, i) => {
                const deducted  = Array.isArray(log.roasted_deducted) ? log.roasted_deducted : [];
                const isEditing = editingLogId === log.id;

                return (
                  <tr key={log.id} style={{ borderBottom: '1px solid #F4E8D8', background: i % 2 === 0 ? 'white' : '#FFFBF5' }}>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: '#6B7280', fontSize: '12px' }}>
                      {formatDate(log.packed_at)}
                    </td>
                    <td style={{ padding: '8px 12px', fontWeight: '500' }}>{log.product_name}</td>
                    <td style={{ padding: '8px 12px' }}>
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <input
                            type="number" min="1"
                            value={editBags}
                            onChange={e => setEditBags(e.target.value)}
                            style={{ width: '64px', padding: '2px 6px', border: '1px solid #D4A574', borderRadius: '4px', fontSize: '13px' }}
                            autoFocus
                          />
                          <button onClick={() => saveEdit(log)} className="btn-small" style={{ background: '#D1FAE5', color: '#065F46', padding: '2px 8px' }}>✓</button>
                          <button onClick={() => setEditingLogId(null)} className="btn-small" style={{ padding: '2px 8px' }}>✕</button>
                        </div>
                      ) : (
                        <span style={{ fontWeight: 'bold', color: '#059669' }}>{log.bags_count}</span>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: '12px', color: '#6B7280' }}>
                      {deducted.map((d, j) => (
                        <span key={j} style={{ display: 'inline-block', marginLeft: '8px' }}>
                          {d.name}: {d.kg} ק"ג
                        </span>
                      ))}
                    </td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      {!isEditing && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            onClick={() => startEdit(log)}
                            className="btn-small"
                            style={{ fontSize: '12px', padding: '2px 8px' }}
                          >✏️ עריכה</button>
                          <button
                            onClick={() => cancelPacking(log)}
                            className="btn-small"
                            style={{ fontSize: '12px', padding: '2px 8px', background: '#FEE2E2', color: '#991B1B' }}
                          >🗑️ ביטול</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
