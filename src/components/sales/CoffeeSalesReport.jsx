import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── Coffee Beans Sales Report (admin) ────────────────────────────────────────
// Pulls coffee-only sales from iCount (all channels incl. POS) for a selected
// date range via the icount-admin `coffee_sales` action, and shows a per-coffee
// breakdown (bags + net ex-VAT revenue) plus totals. CSV export included.

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthStartISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

export default function CoffeeSalesReport() {
  const { showToast } = useApp();
  // Month-to-date default: ranges are now served from the daily cache, so a wide
  // default is fast (it was set to a single day back when multi-day was slow).
  const [from, setFrom]       = useState(monthStartISO());
  const [to, setTo]           = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [report, setReport]   = useState(null);

  async function generate() {
    if (!from || !to) { showToast('⚠️ נא לבחור תאריך התחלה וסיום', 'warning'); return; }
    if (from > to)    { showToast('⚠️ תאריך ההתחלה מאוחר מהסיום', 'warning'); return; }
    setLoading(true); setReport(null);
    try {
      const { data, error } = await supabase.functions.invoke('icount-admin', {
        body: { action: 'coffee_sales', from_date: from, to_date: to },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      setReport(data);
      showToast(`✅ ${data.total_bags} שקיות, ₪${data.total_revenue.toLocaleString()} (ללא מע"מ)`, 'success');
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
    finally { setLoading(false); }
  }

  function exportCsv() {
    if (!report?.products?.length) return;
    const rows = [['מק"ט', 'שם', 'שקיות', 'מחזור ללא מעמ']];
    for (const p of report.products) rows.push([p.sku, p.name, p.bags, p.revenue]);
    rows.push([]);
    rows.push(['', 'סה"כ (ללא מע"מ)', report.total_bags, report.total_revenue]);
    if (report.total_revenue_incl_vat != null) rows.push(['', 'סה"כ (כולל מע"מ)', '', report.total_revenue_incl_vat]);
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `coffee-sales_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const card = { background: 'white', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '820px', margin: '1.25rem auto' };
  const btn = (bg, disabled) => ({ padding: '0.7rem 1.1rem', fontSize: '0.95rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer', marginInlineEnd: '0.6rem' });
  const dateInput = { padding: '0.55rem 0.7rem', fontSize: '0.95rem', border: '1px solid #D5DBC8', borderRadius: '8px', marginInlineEnd: '0.6rem' };
  const th = { textAlign: 'right', padding: '0.5rem 0.7rem', borderBottom: '2px solid #E5E7EB', fontSize: '0.85rem', color: '#374151' };
  const td = { padding: '0.45rem 0.7rem', borderBottom: '1px solid #F3F4F6', fontSize: '0.88rem' };

  return (
    <div style={{ direction: 'rtl', paddingBottom: '3rem' }}>
      <h2 style={{ textAlign: 'center', marginTop: '1.25rem' }}>דוח מכירות קפה</h2>

      <div style={card}>
        <p style={{ color: '#555', fontSize: '0.9rem', marginTop: 0 }}>מכירות פולי קפה בלבד מ-iCount (כל הערוצים כולל קופה), לפי טווח תאריכים. מחזור מוצג ללא מע"מ, ללא חשבוניות שבוטלו ושורות שזוכו.</p>
        <label style={{ fontSize: '0.85rem', color: '#374151' }}>מתאריך
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ ...dateInput, marginInlineStart: '0.4rem' }} />
        </label>
        <label style={{ fontSize: '0.85rem', color: '#374151' }}>עד תאריך
          <input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} style={{ ...dateInput, marginInlineStart: '0.4rem' }} />
        </label>
        <button style={btn('#16A34A', loading)} disabled={loading} onClick={generate}>{loading ? 'מפיק…' : 'הפק דוח'}</button>
        {report?.products?.length > 0 && (
          <button style={btn('#6B7280', loading)} disabled={loading} onClick={exportCsv}>ייצוא CSV</button>
        )}
      </div>

      {report && (
        <div style={card}>
          {report.cache_incomplete && (
            <p style={{ background: '#FEF3C7', color: '#92400E', padding: '0.6rem 0.8rem', borderRadius: '8px', fontSize: '0.85rem', marginTop: 0 }}>
              ⚠️ חלק מהימים בטווח עדיין לא חושבו במטמון, כך שהנתונים חלקיים. המספרים יתמלאו אוטומטית תוך זמן קצר — נסו להפיק שוב בעוד רגע.
            </p>
          )}
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div><div style={{ fontSize: '0.8rem', color: '#6B7280' }}>סה"כ שקיות</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#3D4A2E' }}>{report.total_bags}</div></div>
            <div><div style={{ fontSize: '0.8rem', color: '#6B7280' }}>מחזור (ללא מע"מ)</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#3D4A2E' }}>₪{report.total_revenue.toLocaleString()}</div></div>
            {report.total_revenue_incl_vat != null && (
              <div><div style={{ fontSize: '0.8rem', color: '#6B7280' }}>מחזור (כולל מע"מ)</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#3D4A2E' }}>₪{report.total_revenue_incl_vat.toLocaleString()}</div></div>
            )}
            <div><div style={{ fontSize: '0.8rem', color: '#6B7280' }}>חשבוניות מכירה</div><div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#3D4A2E' }}>{report.sales_doc_count}</div></div>
          </div>

          {report.products.length === 0 ? (
            <p style={{ color: '#6B7280' }}>אין מכירות קפה בטווח שנבחר.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>קפה</th><th style={th}>מק"ט</th><th style={{ ...th, textAlign: 'center' }}>שקיות</th><th style={{ ...th, textAlign: 'center' }}>מחזור ₪</th></tr></thead>
              <tbody>
                {report.products.map((p) => (
                  <tr key={p.sku}>
                    <td style={td}>{p.name}</td>
                    <td style={{ ...td, color: '#9CA3AF', fontSize: '0.8rem' }}>{p.sku}</td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{p.bags}</td>
                    <td style={{ ...td, textAlign: 'center' }}>{p.revenue.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
