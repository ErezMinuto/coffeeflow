import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import ProductSearchInput from './ProductSearchInput';

// ── Product price / stock editor (עדכון מחיר ומלאי) ──────────────────────────
// Search a product, see its current price + stock in WooCommerce and iCount,
// type new value(s), and overwrite BOTH systems. Prices are VAT-inclusive
// consumer prices (same as the website). Leaving a field unchanged from the
// current value is harmless; clearing a field leaves it untouched.
// Coffee bags are price-only here — their stock master is CoffeeFlow packed_stock
// (packing flow), so the stock field is disabled for them.

const call = (body) => supabase.functions.invoke('stock-update', { body: { action: 'product_set', ...body } });

export default function ProductEditor() {
  const { showToast } = useApp();

  const [text, setText]     = useState('');
  const [sku, setSku]       = useState('');
  const [current, setCurrent] = useState(null); // last preview (current values)
  const [price, setPrice]   = useState('');
  const [stock, setStock]   = useState('');
  const [busy, setBusy]     = useState(false);

  // Load current values when a product is picked.
  const loadProduct = async (pickedSku) => {
    setBusy(true);
    setCurrent(null);
    try {
      const { data, error } = await call({ dry_run: true, sku: pickedSku });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'שגיאה');
      setCurrent(data);
      // pre-fill the editable fields with the current Woo values
      setPrice(data.woo?.price != null ? String(Number(data.woo.price)) : (data.icount?.price != null ? String(data.icount.price) : ''));
      setStock(data.is_coffee ? '' : (data.woo?.stock != null ? String(data.woo.stock) : (data.icount?.stock != null ? String(data.icount.stock) : '')));
    } catch (err) {
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onPick = ({ sku: s, name }) => { setSku(s); setText(name); loadProduct(s); };
  const onText = (t) => { setText(t); setSku(''); setCurrent(null); };

  const save = async () => {
    if (!sku) { showToast('⚠️ בחר מוצר מהרשימה', 'warning'); return; }
    const hasPrice = price.trim() !== '';
    const hasStock = stock.trim() !== '' && !current?.is_coffee;
    if (!hasPrice && !hasStock) { showToast('⚠️ הזן מחיר ו/או מלאי', 'warning'); return; }

    const body = { dry_run: false, sku };
    if (hasPrice) body.price = Number(price);
    if (hasStock) body.stock = Number(stock);

    if (!window.confirm(`לעדכן את "${current?.name || sku}" בשתי המערכות?` +
      (hasPrice ? `\nמחיר → ₪${body.price}` : '') + (hasStock ? `\nמלאי → ${body.stock}` : ''))) return;

    setBusy(true);
    try {
      const { data, error } = await call(body);
      if (error || data?.error) throw new Error(data?.error || error?.message || 'שגיאה');
      const a = data.applied || {};
      const probs = [a.woo?.price_error, a.woo?.stock_error, a.icount?.price_error, a.icount?.stock_error].filter(Boolean);
      showToast(probs.length ? `⚠️ עודכן חלקית: ${probs[0]}` : '✅ עודכן בהצלחה בשתי המערכות', probs.length ? 'warning' : 'success');
      loadProduct(sku); // refresh shown values
    } catch (err) {
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── styles ──
  const card  = { background: 'white', borderRadius: '12px', padding: '1.75rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '560px', margin: '1.5rem auto' };
  const input = { width: '100%', padding: '0.7rem 0.9rem', fontSize: '1rem', boxSizing: 'border-box', border: '1px solid #D5DBC8', borderRadius: '8px', marginTop: '0.35rem' };
  const label = { fontWeight: 600, color: '#374151', fontSize: '0.9rem', display: 'block' };
  const sysBox = (title, p, s) => (
    <div style={{ flex: 1, background: '#F4F7EE', border: '1px solid #D5DBC8', borderRadius: '8px', padding: '0.7rem 0.9rem' }}>
      <div style={{ fontWeight: 700, color: '#3D4A2E', marginBottom: '0.3rem' }}>{title}</div>
      <div style={{ fontSize: '0.9rem', color: '#374151' }}>מחיר: <b>{p == null ? '—' : `₪${Number(p)}`}</b></div>
      <div style={{ fontSize: '0.9rem', color: '#374151' }}>מלאי: <b>{s == null ? '—' : s}</b></div>
    </div>
  );

  return (
    <div style={{ direction: 'rtl', paddingBottom: '3rem' }}>
      <div style={card}>
        <h2 style={{ margin: '0 0 0.4rem', color: '#3D4A2E' }}>💰 עדכון מחיר ומלאי</h2>
        <p style={{ margin: '0 0 1.25rem', color: '#6B7280', fontSize: '0.9rem', lineHeight: 1.5 }}>
          חפש מוצר, עדכן מחיר ו/או מלאי, והשינוי ייכתב גם ל-WooCommerce וגם ל-iCount.
          המחיר כולל מע"מ (כמו באתר). שקיות קפה: מחיר בלבד (המלאי מנוהל באריזה).
        </p>

        <label style={label}>
          מוצר (מק"ט או שם)
          <ProductSearchInput
            value={text}
            selectedSku={sku}
            disabled={busy}
            inputStyle={input}
            onText={onText}
            onPick={onPick}
          />
        </label>

        {current && (
          <>
            <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.25rem' }}>
              {sysBox('🛒 WooCommerce', current.woo?.price, current.woo?.stock)}
              {sysBox('🧾 iCount', current.icount?.price, current.icount?.stock)}
            </div>
            {current.is_coffee && (
              <div style={{ marginTop: '0.6rem', color: '#B45309', fontSize: '0.84rem' }}>
                ☕ מוצר קפה — ניתן לעדכן מחיר בלבד. המלאי מנוהל בדיווח אריזה.
              </div>
            )}

            <label style={{ ...label, marginTop: '1.25rem' }}>
              מחיר חדש (₪, כולל מע"מ)
              <input style={input} type="number" min="0" step="0.01" value={price} disabled={busy}
                placeholder="ללא שינוי" onChange={e => setPrice(e.target.value)} />
            </label>

            <label style={{ ...label, marginTop: '1rem', opacity: current.is_coffee ? 0.5 : 1 }}>
              מלאי חדש {current.is_coffee ? '(לא זמין לקפה)' : ''}
              <input style={input} type="number" min="0" value={stock} disabled={busy || current.is_coffee}
                placeholder="ללא שינוי" onChange={e => setStock(e.target.value)} />
            </label>

            <button onClick={save} disabled={busy}
              style={{ width: '100%', marginTop: '1.5rem', padding: '0.85rem', fontSize: '1rem', fontWeight: 700, color: 'white', background: busy ? '#9CA3AF' : '#16A34A', border: 'none', borderRadius: '8px', cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'מעדכן…' : '✅ עדכן בשתי המערכות'}
            </button>
          </>
        )}

        {!current && busy && <p style={{ color: '#6B7280', marginTop: '1rem' }}>טוען…</p>}
      </div>
    </div>
  );
}
