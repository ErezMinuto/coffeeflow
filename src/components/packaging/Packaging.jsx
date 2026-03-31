import React, { useState } from 'react';
import { useApp } from '../../lib/context';

// ── Helpers ───────────────────────────────────────────────────────────────────

const calcDeductions = (product, bags, origins, roastProfiles) => {
  const sizeKg = product.size / 1000;
  return (product.recipe || []).map(ing => {
    const kgNeeded = bags * sizeKg * (ing.percentage / 100);
    if (ing.sourceType === 'profile' && ing.sourceId) {
      const profile = roastProfiles.find(p => p.id === ing.sourceId);
      return profile ? { type: 'profile', item: profile, kgNeeded, minStock: profile.min_stock ?? null } : null;
    } else {
      const originId = ing.sourceId || ing.originId;
      const origin = origins.find(o => o.id === originId);
      return origin ? { type: 'origin', item: origin, kgNeeded, minStock: origin.critical_stock ?? null } : null;
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

  const selectedProduct = data.products.find(p => p.id === parseInt(packProductId));
  const bags            = parseInt(packBags) || 0;
  const deductions      = selectedProduct && bags > 0
    ? calcDeductions(selectedProduct, bags, data.origins, data.roastProfiles)
    : [];
  const shortages = deductions.filter(d => (d.item.roasted_stock || 0) < d.kgNeeded);

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
        if (d.type === 'origin') {
          await originsDb.update(d.item.id, { roasted_stock: newStock });
        } else {
          await roastProfilesDb.update(d.item.id, { roasted_stock: newStock });
        }
      }

      await productsDb.update(selectedProduct.id, {
        packed_stock: (selectedProduct.packed_stock || 0) + bags
      });

      await packingLogsDb.insert({
        product_id:       selectedProduct.id,
        product_name:     `${selectedProduct.name} ${selectedProduct.size}g`,
        bags_count:       bags,
        roasted_deducted: deductions.map(d => ({
          name: d.item.name,
          kg:   parseFloat(d.kgNeeded.toFixed(3))
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
                  <span style={{ color: '#6B7280', marginRight: '6px' }}>
                    (במלאי: {current.toFixed(1)} ק"ג)
                  </span>
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
                <th style={{ padding: '8px 12px' }}>מבוצע ע"י</th>
              </tr>
            </thead>
            <tbody>
              {sortedLogs.map((log, i) => {
                const deducted = Array.isArray(log.roasted_deducted) ? log.roasted_deducted : [];
                return (
                  <tr key={log.id} style={{ borderBottom: '1px solid #F4E8D8', background: i % 2 === 0 ? 'white' : '#FFFBF5' }}>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: '#6B7280', fontSize: '12px' }}>
                      {formatDate(log.packed_at)}
                    </td>
                    <td style={{ padding: '8px 12px', fontWeight: '500' }}>{log.product_name}</td>
                    <td style={{ padding: '8px 12px', fontWeight: 'bold', color: '#059669' }}>{log.bags_count}</td>
                    <td style={{ padding: '8px 12px', fontSize: '12px', color: '#6B7280' }}>
                      {deducted.map((d, j) => (
                        <span key={j} style={{ display: 'inline-block', marginLeft: '8px' }}>
                          {d.name}: {d.kg} ק"ג
                        </span>
                      ))}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: '12px', color: '#6B7280' }}>
                      {log.reported_by || '—'}
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
