import React, { useState, useEffect } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import ProductSearchInput from './ProductSearchInput';

// ── Supplier goods receipt (קליטת סחורה) ─────────────────────────────────────
// One line per delivered item: product + quantity + sale price, all inline.
// Picking a product loads its current sale price (WooCommerce) straight into the
// line so it can be edited in place when a price changed. Confirm adds the
// quantity to WooCommerce and writes the sale price to Woo. Coffee bags are
// managed by the packing flow and are rejected here.

const blankRow = () => ({
  text: '', sku: '', name: '', qty: '',
  sale: '', saleBefore: null,
  loadingPrice: false, isCoffee: false,
});
const RED = '#DC2626', GREEN = '#16A34A';

export default function SupplierIntake() {
  const { showToast } = useApp();

  const [rows, setRows]       = useState([blankRow(), blankRow(), blankRow()]);
  const [supplier, setSupplier] = useState('');
  const [knownSuppliers, setKnownSuppliers] = useState([]); // autocomplete from past receipts
  const [busy, setBusy]       = useState(false);
  const [results, setResults] = useState(null); // last run (preview or applied)

  // Pull recently-used suppliers for the autocomplete datalist.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('inventory_adjustments')
        .select('supplier')
        .not('supplier', 'is', null)
        .order('created_at', { ascending: false })
        .limit(300);
      if (cancelled || !data) return;
      setKnownSuppliers([...new Set(data.map(r => r.supplier).filter(Boolean))]);
    })();
    return () => { cancelled = true; };
  }, []);

  const setRow = (i, patch) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow    = () => setRows(rs => [...rs, blankRow()]);
  const removeRow = (i) => setRows(rs => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  // When a product is picked, fetch its current sale price (a safe dry-run
  // receive for that one SKU) and pre-fill the line's price field.
  const loadRowCurrent = async (i, sku) => {
    setRow(i, { loadingPrice: true });
    try {
      const { data } = await supabase.functions.invoke('stock-update', {
        body: { action: 'receive', dry_run: true, items: [{ sku, qty: 1 }] },
      });
      const r = data?.results?.[0] || {};
      setRow(i, {
        saleBefore: r.current?.sale ?? null,
        sale: r.current?.sale != null ? String(r.current.sale) : '',
        isCoffee: r.status === 'rejected_coffee',
        loadingPrice: false,
      });
    } catch {
      setRow(i, { loadingPrice: false });
    }
  };

  const onPick = (i, { sku, name }) => { setRow(i, { sku, name, text: name }); loadRowCurrent(i, sku); };
  const onText = (i, text) => setRow(i, { text, sku: '', name: '', saleBefore: null, sale: '', isCoffee: false });

  const collectItems = () => {
    const items = [];
    for (const r of rows) {
      const sku = (r.sku || r.text).trim();
      const qty = parseInt(r.qty, 10);
      if (!sku) continue;
      if (!qty || qty <= 0) { showToast(`⚠️ יש להזין כמות למוצר ${r.name || sku}`, 'warning'); return null; }
      const it = { sku, qty, name: r.name || sku };
      if (String(r.sale).trim() !== '') it.price = Number(r.sale);
      items.push(it);
    }
    if (items.length === 0) { showToast('⚠️ נא להזין לפחות שורה אחת', 'warning'); return null; }
    return items;
  };

  const run = async (dryRun) => {
    const items = collectItems();
    if (!items) return;
    setBusy(true);
    setResults(null);
    try {
      const { data, error } = await supabase.functions.invoke('stock-update', {
        body: { action: 'receive', dry_run: dryRun, supplier: supplier.trim(), items },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'שגיאה לא ידועה');

      if (dryRun) {
        setResults(data);
        showToast(`✅ תצוגה מקדימה: ${data.count} שורות`, 'success');
      } else {
        const ok = data.results.filter(r => r.status === 'ok').length;
        const bad = data.results.length - ok;
        const s = supplier.trim();
        if (s && !knownSuppliers.includes(s)) setKnownSuppliers(list => [s, ...list]);
        if (bad === 0) {
          showToast(`✅ המלאי והמחירים עודכנו (${ok} שורות) — מוכן לחשבונית הבאה`, 'success');
          setRows([blankRow(), blankRow(), blankRow()]);
          setResults(null);
        } else {
          setResults(data);
          showToast(`⚠️ נקלטו ${ok} שורות, ${bad} עם בעיה — בדוק את התוצאות`, 'warning');
        }
      }
    } catch (err) {
      console.error(err);
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── styles ──
  const card  = { background: 'white', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '760px', margin: '1.25rem auto' };
  const input = { padding: '0.55rem 0.6rem', fontSize: '0.95rem', boxSizing: 'border-box', border: '1px solid #D5DBC8', borderRadius: '8px', width: '100%' };
  const btn   = (bg, disabled) => ({ padding: '0.75rem 1.1rem', fontSize: '0.95rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer', marginInlineEnd: '0.6rem' });
  const cols  = '1fr 70px 110px 34px';

  const sysCell = (s) => {
    if (!s) return <span style={{ color: '#9CA3AF' }}>—</span>;
    const map = {
      updated:      [GREEN, `${s.before} ← ${s.after}`],
      would_update: ['#2563EB', `${s.before} → ${s.after}`],
      no_woo_match: ['#B45309', 'לא נמצא ב-Woo'],
      untracked:    ['#B45309', 'מלאי לא מנוהל'],
    };
    const [color, text] = map[s.status] || ['#B91C1C', s.status];
    return <span style={{ color, fontWeight: 600 }}>{text}</span>;
  };

  const lineColor = (st) =>
    st === 'ok' ? '#F4F7EE' : st === 'rejected_coffee' ? '#FEF3C7' : '#FEE2E2';

  return (
    <div style={{ direction: 'rtl', paddingBottom: '3rem' }}>
      <div style={card}>
        <h2 style={{ margin: '0 0 0.4rem', color: '#3D4A2E' }}>📥 קליטת סחורה מספק</h2>
        <p style={{ margin: '0 0 1.25rem', color: '#6B7280', fontSize: '0.9rem', lineHeight: 1.5 }}>
          לכל שורה: בחר מוצר וכמות שהתקבלה, וערוך מחיר מכירה ישירות בשורה במידת הצורך.
          הכמות מתווספת ל-WooCommerce.
          שקיות קפה מנוהלות בנפרד (דיווח אריזה) ויידחו כאן.
        </p>

        {/* supplier */}
        <label style={{ fontWeight: 600, color: '#374151', fontSize: '0.85rem', display: 'block', marginBottom: '1rem' }}>
          ספק (אופציונלי)
          <input
            style={{ ...input, marginTop: '0.3rem' }}
            list="supplier-list"
            value={supplier}
            disabled={busy}
            placeholder="בחר או הקלד שם ספק"
            onChange={e => setSupplier(e.target.value)}
          />
          <datalist id="supplier-list">
            {knownSuppliers.map(s => <option key={s} value={s} />)}
          </datalist>
        </label>

        {/* header */}
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '0.5rem', fontWeight: 600, color: '#374151', fontSize: '0.82rem', marginBottom: '0.4rem' }}>
          <span>מוצר (מק"ט או שם)</span><span>כמות</span><span>מחיר מכירה</span><span />
        </div>

        {rows.map((r, i) => {
          const priceDisabled = busy || r.isCoffee || r.loadingPrice;
          return (
            <div key={i} style={{ marginBottom: '0.55rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '0.5rem', alignItems: 'start' }}>
                <ProductSearchInput
                  value={r.text}
                  selectedSku={r.sku}
                  disabled={busy}
                  inputStyle={input}
                  onText={(text) => onText(i, text)}
                  onPick={(picked) => onPick(i, picked)}
                />
                <input style={input} type="number" min="1" value={r.qty} disabled={busy}
                  placeholder="כמות" onChange={e => setRow(i, { qty: e.target.value })} />
                <input
                  style={input}
                  type="number" min="0" step="0.01" value={r.sale} disabled={priceDisabled}
                  placeholder={r.loadingPrice ? '…' : r.isCoffee ? '—' : 'מכירה'}
                  onChange={e => setRow(i, { sale: e.target.value })} />
                <button onClick={() => removeRow(i)} disabled={busy || rows.length === 1}
                  title="הסר שורה"
                  style={{ ...input, cursor: busy || rows.length === 1 ? 'default' : 'pointer', color: '#B91C1C', background: 'white', padding: '0.4rem', fontWeight: 700 }}>✕</button>
              </div>
              {/* per-line hint: current sale price */}
              {r.sku && !r.loadingPrice && (
                <div style={{ fontSize: '0.72rem', color: '#6B7280', marginTop: '2px', paddingInlineEnd: '0.2rem' }}>
                  {r.isCoffee
                    ? <span style={{ color: '#B45309' }}>☕ שקית קפה — מנוהלת באריזה, ללא מחיר כאן</span>
                    : <>מכירה נוכחי: {r.saleBefore != null ? `₪${r.saleBefore}` : '—'}</>}
                </div>
              )}
            </div>
          );
        })}

        <button onClick={addRow} disabled={busy}
          style={{ ...btn('#6B7280', busy), marginTop: '0.3rem' }}>➕ הוסף שורה</button>

        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <button style={btn('#2563EB', busy)} disabled={busy} onClick={() => run(true)}>
            {busy ? 'מעבד…' : '👁️ תצוגה מקדימה'}
          </button>
          <button style={btn(GREEN, busy)} disabled={busy}
            onClick={() => {
              const items = collectItems();
              if (!items) return;
              const summary = items.map(it => `• ${it.name}: +${it.qty} יח׳`).join('\n');
              const total = items.reduce((s, it) => s + it.qty, 0);
              if (window.confirm(`לאשר קליטת ${items.length} מוצרים · סה"כ ${total} יחידות?\n\nהכמות תתווסף למלאי הקיים:\n${summary}`)) run(false);
            }}>
            {busy ? 'מעבד…' : '✅ אשר ועדכן מלאי ומחירים'}
          </button>
        </div>
      </div>

      {/* results (read-only) */}
      {results && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>
            {results.dry_run ? 'תצוגה מקדימה' : 'תוצאות עדכון'}
            {results.supplier && (
              <span style={{ color: '#3D4A2E', fontSize: '0.85rem', fontWeight: 400 }}> · ספק: {results.supplier}</span>
            )}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 1fr', gap: '0.5rem', fontWeight: 600, color: '#374151', fontSize: '0.82rem', padding: '0 0.5rem 0.4rem' }}>
            <span>מק"ט / שם</span><span>כמות</span><span>WooCommerce</span>
          </div>
          {results.results.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 1fr', gap: '0.5rem', alignItems: 'center', background: lineColor(r.status), borderRadius: '8px', padding: '0.5rem', marginBottom: '0.35rem', fontSize: '0.85rem' }}>
              <span>
                <b>{r.sku}</b>
                {r.name && <div style={{ color: '#6B7280', fontSize: '0.78rem' }}>{r.name}</div>}
                {r.status === 'rejected_coffee' && <div style={{ color: '#B45309', fontSize: '0.78rem' }}>☕ שקית קפה — מנוהלת באריזה</div>}
                {r.status === 'error' && <div style={{ color: '#B91C1C', fontSize: '0.78rem' }}>{r.error}</div>}
                {/* applied price feedback */}
                {r.woo?.sale_after != null &&
                  <div style={{ color: GREEN, fontSize: '0.76rem' }}>מכירה → ₪{r.woo.sale_after}</div>}
                {r.woo?.sale_error &&
                  <div style={{ color: RED, fontSize: '0.76rem' }}>⚠️ {r.woo.sale_error}</div>}
              </span>
              <span>{r.qty != null ? `+${r.qty}` : ''}</span>
              <span>{sysCell(r.woo)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
