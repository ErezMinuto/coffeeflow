import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── Supplier goods receipt (קליטת סחורה) ─────────────────────────────────────
// Enter the lines of a supplier delivery (SKU or product name + quantity), Preview
// to see current → new for both WooCommerce and iCount, then Confirm to write.
// Non-coffee only: coffee bags stay on the packing / packed_stock flow and are
// rejected here. The stock-update edge function (action:'receive') adds the
// received quantity to WooCommerce (master) and mirrors it onto iCount.

const blankRow = () => ({ text: '', sku: '', name: '', qty: '1' });

// Type a SKU or a product name → live suggestions from woo_products. Picking a
// suggestion locks in its SKU (what we submit); a raw SKU typed without picking
// is used as-is. anon has SELECT on woo_products, so we query it directly.
function ProductSearchInput({ value, selectedSku, disabled, inputStyle, onText, onPick }) {
  const [sugs, setSugs]       = useState([]);
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  const search = async (term) => {
    const safe = term.trim().replace(/[,%()*\\]/g, ' ').trim();
    if (safe.length < 2) { setSugs([]); setOpen(false); return; }
    setLoading(true);
    const { data } = await supabase
      .from('woo_products')
      .select('sku,name,stock_status')
      .or(`name.ilike.%${safe}%,sku.ilike.%${safe}%`)
      .not('sku', 'is', null)
      .limit(8);
    setSugs(data || []);
    setOpen(true);
    setLoading(false);
  };

  const onChange = (e) => {
    const text = e.target.value;
    onText(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => search(text), 220);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={inputStyle}
        value={value}
        disabled={disabled}
        placeholder='הקלד מק"ט או שם מוצר'
        autoComplete="off"
        onChange={onChange}
        onFocus={() => { if (sugs.length) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {selectedSku && value !== selectedSku && (
        <div style={{ fontSize: '0.72rem', color: '#6B7280', marginTop: '2px' }}>מק"ט: {selectedSku}</div>
      )}
      {open && (loading || sugs.length > 0) && (
        <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50, background: 'white', border: '1px solid #D5DBC8', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.14)', maxHeight: '240px', overflowY: 'auto', marginTop: '2px' }}>
          {loading && <div style={{ padding: '0.5rem 0.7rem', color: '#9CA3AF', fontSize: '0.82rem' }}>מחפש…</div>}
          {!loading && sugs.map((s, idx) => (
            <div key={`${s.sku}-${idx}`}
              onMouseDown={(e) => { e.preventDefault(); onPick({ sku: s.sku, name: s.name }); setOpen(false); }}
              style={{ padding: '0.5rem 0.7rem', cursor: 'pointer', borderBottom: '1px solid #F0F0EA' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#F4F7EE'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'white'}>
              <div style={{ fontWeight: 600, color: '#3D4A2E', fontSize: '0.85rem' }}>{s.name}</div>
              <div style={{ color: '#6B7280', fontSize: '0.76rem' }}>
                מק"ט {s.sku}{s.stock_status && s.stock_status !== 'instock' ? ' · אזל מהמלאי' : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SupplierIntake() {
  const { showToast } = useApp();

  const [rows, setRows]       = useState([blankRow(), blankRow(), blankRow()]);
  const [supplier, setSupplier] = useState('');
  const [knownSuppliers, setKnownSuppliers] = useState([]); // autocomplete from past receipts
  const [busy, setBusy]       = useState(false);
  const [preview, setPreview] = useState(null); // last dry-run results

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

  const collectItems = () => {
    const items = [];
    for (const r of rows) {
      const sku = (r.sku || r.text).trim();
      const qty = parseInt(r.qty, 10);
      if (!sku) continue;
      if (!qty || qty <= 0) { showToast(`⚠️ כמות לא תקינה למק"ט ${sku}`, 'warning'); return null; }
      items.push({ sku, qty });
    }
    if (items.length === 0) { showToast('⚠️ נא להזין לפחות שורה אחת', 'warning'); return null; }
    return items;
  };

  const run = async (dryRun) => {
    const items = collectItems();
    if (!items) return;
    setBusy(true);
    if (dryRun) setPreview(null);
    try {
      const { data, error } = await supabase.functions.invoke('stock-update', {
        body: { action: 'receive', dry_run: dryRun, supplier: supplier.trim(), items },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'שגיאה לא ידועה');

      setPreview(data);
      if (dryRun) {
        showToast(`✅ תצוגה מקדימה: ${data.count} שורות`, 'success');
      } else {
        const ok = data.results.filter(r => r.status === 'ok').length;
        const bad = data.results.length - ok;
        showToast(`✅ נקלטו ${ok} שורות${bad ? `, ${bad} עם בעיה` : ''}`, bad ? 'warning' : 'success');
        const s = supplier.trim();
        if (s && !knownSuppliers.includes(s)) setKnownSuppliers(list => [s, ...list]);
      }
    } catch (err) {
      console.error(err);
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── styles ──
  const card  = { background: 'white', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '720px', margin: '1.25rem auto' };
  const input = { padding: '0.6rem 0.7rem', fontSize: '1rem', boxSizing: 'border-box', border: '1px solid #D5DBC8', borderRadius: '8px' };
  const btn   = (bg, disabled) => ({ padding: '0.75rem 1.1rem', fontSize: '0.95rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer', marginInlineEnd: '0.6rem' });

  const sysCell = (s) => {
    if (!s) return <span style={{ color: '#9CA3AF' }}>—</span>;
    const map = {
      updated:      ['#16A34A', `${s.before} ← ${s.after}`],
      would_update: ['#2563EB', `${s.before} → ${s.after}`],
      no_woo_match:    ['#B45309', 'לא נמצא ב-Woo'],
      no_icount_match: ['#B45309', 'לא נמצא ב-iCount'],
      untracked:    ['#B45309', 'מלאי לא מנוהל'],
      not_configured: ['#9CA3AF', 'לא מוגדר'],
    };
    const [color, text] = map[s.status] || ['#B91C1C', s.status];
    return <span style={{ color, fontWeight: 600 }}>{text}</span>;
  };

  const lineColor = (st) =>
    st === 'ok' ? '#F4F7EE' : st === 'rejected_coffee' ? '#FEF3C7' : st === 'partial' ? '#FEF9C3' : '#FEE2E2';

  return (
    <div style={{ direction: 'rtl', paddingBottom: '3rem' }}>
      <div style={card}>
        <h2 style={{ margin: '0 0 0.4rem', color: '#3D4A2E' }}>📥 קליטת סחורה מספק</h2>
        <p style={{ margin: '0 0 1.25rem', color: '#6B7280', fontSize: '0.9rem', lineHeight: 1.5 }}>
          הזן את שורות המשלוח (חפש לפי מק"ט או שם מוצר + כמות שהתקבלה). הכמות תתווסף למלאי ב-WooCommerce
          וב-iCount. שקיות קפה מנוהלות בנפרד (דיווח אריזה) ויידחו כאן.
        </p>

        {/* supplier */}
        <label style={{ fontWeight: 600, color: '#374151', fontSize: '0.85rem', display: 'block', marginBottom: '1rem' }}>
          ספק (אופציונלי)
          <input
            style={{ ...input, width: '100%', marginTop: '0.3rem' }}
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 36px', gap: '0.6rem', fontWeight: 600, color: '#374151', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
          <span>מוצר (מק"ט או שם)</span><span>כמות</span><span />
        </div>

        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 36px', gap: '0.6rem', marginBottom: '0.5rem', alignItems: 'start' }}>
            <ProductSearchInput
              value={r.text}
              selectedSku={r.sku}
              disabled={busy}
              inputStyle={input}
              onText={(text) => setRow(i, { text, sku: '', name: '' })}
              onPick={({ sku, name }) => setRow(i, { sku, name, text: name })}
            />
            <input style={input} type="number" min="1" value={r.qty} disabled={busy}
              onChange={e => setRow(i, { qty: e.target.value })} />
            <button onClick={() => removeRow(i)} disabled={busy || rows.length === 1}
              title="הסר שורה"
              style={{ ...input, cursor: busy || rows.length === 1 ? 'default' : 'pointer', color: '#B91C1C', background: 'white', padding: '0.4rem', fontWeight: 700 }}>✕</button>
          </div>
        ))}

        <button onClick={addRow} disabled={busy}
          style={{ ...btn('#6B7280', busy), marginTop: '0.3rem' }}>➕ הוסף שורה</button>

        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <button style={btn('#2563EB', busy)} disabled={busy} onClick={() => run(true)}>
            {busy ? 'מעבד…' : '👁️ תצוגה מקדימה'}
          </button>
          <button style={btn('#16A34A', busy)} disabled={busy}
            onClick={() => { if (window.confirm('לעדכן את המלאי ב-WooCommerce וב-iCount?')) run(false); }}>
            {busy ? 'מעבד…' : '✅ אשר ועדכן מלאי'}
          </button>
        </div>
      </div>

      {/* results */}
      {preview && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>
            {preview.dry_run ? 'תצוגה מקדימה' : 'תוצאות עדכון'}
            {preview.supplier && (
              <span style={{ color: '#3D4A2E', fontSize: '0.85rem', fontWeight: 400 }}> · ספק: {preview.supplier}</span>
            )}
            {!preview.icount_configured && (
              <span style={{ color: '#B45309', fontSize: '0.8rem', fontWeight: 400 }}> · iCount לא מוגדר</span>
            )}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr 1fr', gap: '0.5rem', fontWeight: 600, color: '#374151', fontSize: '0.82rem', padding: '0 0.5rem 0.4rem' }}>
            <span>מק"ט / שם</span><span>כמות</span><span>WooCommerce</span><span>iCount</span>
          </div>
          {preview.results.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr 1fr', gap: '0.5rem', alignItems: 'center', background: lineColor(r.status), borderRadius: '8px', padding: '0.5rem', marginBottom: '0.35rem', fontSize: '0.85rem' }}>
              <span>
                <b>{r.sku}</b>
                {r.name && <div style={{ color: '#6B7280', fontSize: '0.78rem' }}>{r.name}</div>}
                {r.status === 'rejected_coffee' && <div style={{ color: '#B45309', fontSize: '0.78rem' }}>☕ שקית קפה — מנוהלת באריזה</div>}
                {r.status === 'error' && <div style={{ color: '#B91C1C', fontSize: '0.78rem' }}>{r.error}</div>}
              </span>
              <span>{r.qty != null ? `+${r.qty}` : ''}</span>
              <span>{sysCell(r.woo)}</span>
              <span>{sysCell(r.icount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
