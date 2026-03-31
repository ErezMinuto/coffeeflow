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

// ── Packaging ─────────────────────────────────────────────────────────────────

export default function Packaging() {
  const {
    data, originsDb, roastProfilesDb, productsDb, showToast
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

  // ── Render ────────────────────────────────────────────────────────────────

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

      {/* Product stock overview */}
      <h3 style={{ marginBottom: '12px' }}>📦 מלאי שקיות ארוזות</h3>

      {data.products.length === 0 ? (
        <div className="empty-state">אין מוצרים מוגדרים עדיין.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
          {data.products.map(product => {
            const stock    = product.packed_stock ?? 0;
            const minStock = product.min_packed_stock ?? 0;
            const isEmpty  = stock === 0;
            const isLow    = !isEmpty && minStock > 0 && stock <= minStock;
            const color    = isEmpty ? '#DC2626' : isLow ? '#D97706' : '#059669';
            const bg       = isEmpty ? '#FEF2F2' : isLow ? '#FFFBEB' : '#F0FFF4';
            const border   = isEmpty ? '#FCA5A5' : isLow ? '#FCD34D' : '#6EE7B7';

            return (
              <div key={product.id} style={{
                background: bg, border: `1.5px solid ${border}`,
                borderRadius: '10px', padding: '16px', textAlign: 'center'
              }}>
                <div style={{ fontWeight: '600', fontSize: '14px', marginBottom: '4px', color: '#374151' }}>
                  {product.name}
                </div>
                <div style={{ fontSize: '12px', color: '#6B7280', marginBottom: '10px' }}>
                  {product.size}g
                </div>
                <div style={{ fontSize: '32px', fontWeight: 'bold', color, lineHeight: 1 }}>
                  {stock}
                </div>
                <div style={{ fontSize: '11px', color: '#6B7280', marginTop: '4px' }}>שקיות</div>
                {minStock > 0 && (
                  <div style={{ fontSize: '11px', color, marginTop: '6px', fontWeight: '500' }}>
                    {isEmpty ? '❌ אזל מהמלאי' : isLow ? `⚠️ מינימום: ${minStock}` : `✓ מינימום: ${minStock}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
