import React, { useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';

// Type a SKU or a product name → live suggestions from woo_products. Picking a
// suggestion calls onPick({sku, name}); typing calls onText(text). anon has
// SELECT on woo_products, so this queries it directly. Shared by the supplier
// intake and product editor pages.
export default function ProductSearchInput({ value, selectedSku, disabled, inputStyle, placeholder, onText, onPick }) {
  const [sugs, setSugs]       = useState([]);
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  const search = async (term) => {
    const safe = term.trim().replace(/[,%()*\\]/g, ' ').trim();
    if (safe.length < 2) { setSugs([]); setOpen(false); return; }
    setLoading(true);
    // Match EVERY typed word independently (order-independent) against name or
    // SKU, and return many matches — so a partial / multi-word search surfaces
    // all relevant products, not just names containing the exact typed string.
    const tokens = safe.split(/\s+/).map(t => t.replace(/[%_]/g, ' ').trim()).filter(Boolean).slice(0, 6);
    let q = supabase
      .from('woo_products')
      .select('sku,name,stock_status')
      .not('sku', 'is', null);
    for (const t of tokens) q = q.or(`name.ilike.%${t}%,sku.ilike.%${t}%`);
    const { data } = await q.order('name', { ascending: true }).limit(50);
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
        placeholder={placeholder || 'הקלד מק"ט או שם מוצר'}
        autoComplete="off"
        onChange={onChange}
        onFocus={() => { if (sugs.length) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {selectedSku && value !== selectedSku && (
        <div style={{ fontSize: '0.72rem', color: '#6B7280', marginTop: '2px' }}>מק"ט: {selectedSku}</div>
      )}
      {open && (loading || sugs.length > 0) && (
        <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50, background: 'white', border: '1px solid #D5DBC8', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.14)', maxHeight: '360px', overflowY: 'auto', marginTop: '2px' }}>
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
