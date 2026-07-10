import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── Manual stock update ─────────────────────────────────────────────────────
// Enter a SKU + amount, then add or remove. The stock-update edge function
// auto-routes: coffee bags (in product_sku_map) adjust CoffeeFlow packed_stock,
// everything else adjusts WooCommerce stock.

export default function StockAdmin() {
  const { showToast } = useApp();

  const [sku,     setSku]     = useState('');
  const [amount,  setAmount]  = useState('1');
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);

  const adjust = async (sign) => {
    const skuTrim = sku.trim();
    const qty = parseInt(amount, 10);
    if (!skuTrim)      { showToast('⚠️ נא להזין מקט', 'warning'); return; }
    if (!qty || qty <= 0) { showToast('⚠️ נא להזין כמות חיובית', 'warning'); return; }

    const delta = sign * qty;
    setLoading(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('stock-update', {
        body: { sku: skuTrim, delta },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'שגיאה לא ידועה');

      setResult(data);
      const where = data.target === 'coffeeflow' ? 'CoffeeFlow' : 'WooCommerce';
      showToast(`✅ ${data.name}: ${data.before} ← ${data.after} (${where})`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const card = {
    background: 'white', borderRadius: '12px', padding: '1.75rem',
    boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '520px', margin: '1.5rem auto',
  };
  const input = {
    width: '100%', padding: '0.7rem 0.9rem', fontSize: '1rem', boxSizing: 'border-box',
    border: '1px solid #D5DBC8', borderRadius: '8px', marginTop: '0.35rem',
  };
  const btn = (bg) => ({
    flex: 1, padding: '0.8rem', fontSize: '1rem', fontWeight: 700, color: 'white',
    background: loading ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px',
    cursor: loading ? 'default' : 'pointer',
  });

  return (
    <div style={{ direction: 'rtl' }}>
      <div style={card}>
        <h2 style={{ margin: '0 0 0.4rem', color: '#3D4A2E' }}>📦 עדכון מלאי ידני</h2>
        <p style={{ margin: '0 0 1.5rem', color: '#6B7280', fontSize: '0.9rem', lineHeight: 1.5 }}>
          הזן מקט וכמות. המערכת מזהה אוטומטית אם המקט הוא שקית קפה (מלאי CoffeeFlow)
          או מוצר אחר (WooCommerce) ומעדכנת את המקור הנכון.
        </p>

        <label style={{ fontWeight: 600, color: '#374151', fontSize: '0.9rem' }}>
          מקט (SKU)
          <input
            style={input}
            value={sku}
            onChange={e => setSku(e.target.value)}
            placeholder="לדוגמה 21999746"
            disabled={loading}
          />
        </label>

        <label style={{ fontWeight: 600, color: '#374151', fontSize: '0.9rem', display: 'block', marginTop: '1rem' }}>
          כמות
          <input
            style={input}
            type="number"
            min="1"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={loading}
          />
        </label>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
          <button style={btn('#DC2626')} onClick={() => adjust(-1)} disabled={loading}>
            {loading ? 'מעדכן…' : '➖ הורד מהמלאי'}
          </button>
          <button style={btn('#10B981')} onClick={() => adjust(1)} disabled={loading}>
            {loading ? 'מעדכן…' : '➕ הוסף למלאי'}
          </button>
        </div>

        {result && (
          <div style={{
            marginTop: '1.5rem', padding: '1rem', borderRadius: '8px',
            background: '#F4F7EE', border: '1px solid #D5DBC8',
          }}>
            <div style={{ fontWeight: 700, color: '#3D4A2E', marginBottom: '0.4rem' }}>
              {result.target === 'coffeeflow' ? '☕ CoffeeFlow (מלאי ארוז)' : '🛒 WooCommerce'}
              {result.is_variation ? ' · וריאציה' : ''}
            </div>
            <div style={{ color: '#374151' }}>{result.name}</div>
            <div style={{ marginTop: '0.4rem', fontSize: '1.1rem' }}>
              מלאי: <b>{result.before}</b> ← <b>{result.after}</b>
            </div>
            {result.clamped && (
              <div style={{ marginTop: '0.4rem', color: '#B45309', fontSize: '0.85rem' }}>
                ⚠️ המלאי לא יורד מתחת ל-0, לכן נעצר באפס.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
