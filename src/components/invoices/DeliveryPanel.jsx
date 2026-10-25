import React, { useEffect, useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import { buildInvoiceZip, saveBlob } from '../../lib/invoiceZip';

// ── Delivery packages to the bookkeeper (admin + bookkeeper) ────────────────
// Each month the bookkeeper gets EVERY confirmed invoice not sent yet, whatever
// its date (a late invoice from an earlier month included). "Download new
// package" builds the ZIP first, and only once it is built marks its invoices
// as sent (create_invoice_delivery, migration 20261025). Every package stays
// downloadable again.

const money = (v) => Number(v || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateIL = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
const ym = (d) => (d ? `${d.slice(5, 7)}/${d.slice(0, 4)}` : 'ללא תאריך');

const card = { background: 'white', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '1000px', margin: '1.25rem auto', border: '2px solid #D5DBC8' };
const btn = (bg, disabled) => ({ padding: '0.7rem 1.1rem', fontSize: '0.98rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer' });
const chip = (bg, color) => ({ background: bg, color, borderRadius: '999px', padding: '3px 11px', fontSize: '0.82rem', fontWeight: 700, whiteSpace: 'nowrap' });
const th = { textAlign: 'right', padding: '0.4rem 0.55rem', borderBottom: '2px solid #E5E7EB', fontSize: '0.8rem', color: '#374151', whiteSpace: 'nowrap' };
const td = { padding: '0.4rem 0.55rem', borderBottom: '1px solid #F3F4F6', fontSize: '0.86rem' };

export default function DeliveryPanel({ onDelivered }) {
  const { showToast, user } = useApp();
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(null);   // "3/40" while building

  async function load() {
    try {
      const [{ data: undelivered, error: e1 }, { count: pending, error: e2 }, { data: deliveries, error: e3 }] = await Promise.all([
        supabase.from('supplier_invoices').select('*').eq('status', 'confirmed').is('delivery_id', null)
          .order('invoice_date', { ascending: true, nullsFirst: true }).range(0, 4999),
        supabase.from('supplier_invoices').select('id', { count: 'exact', head: true }).eq('status', 'pending_review'),
        supabase.from('invoice_deliveries').select('*').order('created_at', { ascending: false }).limit(24),
      ]);
      if (e1 || e2 || e3) throw e1 || e2 || e3;
      setState({ loading: false, undelivered: undelivered || [], pending: pending || 0, deliveries: deliveries || [] });
    } catch (e) {
      setState({ loading: false, error: e.message });
    }
  }
  useEffect(() => { load(); }, []);

  async function sendNew() {
    const rows = state.undelivered;
    if (!rows.length) return;
    if (!window.confirm(`להוריד חבילה של ${rows.length} חשבוניות ולסמן אותן כנשלחו לרו״ח?`)) return;
    setBusy(`0/${rows.length}`);
    try {
      const { blob, failed } = await buildInvoiceZip(rows, {
        indexName: 'סיכום-החבילה.csv', onProgress: (d, t) => setBusy(`${d}/${t}`),
      });
      if (failed.length) throw new Error(`${failed.length} קבצים לא ירדו (${failed.slice(0, 3).join(', ')}), החבילה לא סומנה. נסו שוב`);
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
      saveBlob(blob, `חשבוניות-לרו״ח_${today}.zip`);
      // Mark only what is in the ZIP that was just saved.
      const { data: d, error } = await supabase.rpc('create_invoice_delivery', {
        p_invoice_ids: rows.map((r) => r.id),
        p_created_by_name: user?.fullName || user?.primaryEmailAddress?.emailAddress || null,
      });
      if (error) throw new Error(`הקובץ ירד, אבל הסימון כ״נשלח״ נכשל: ${error.message}. אפשר ללחוץ שוב`);
      showToast(`📦 נשלחו ${d.invoice_count} חשבוניות`);
      onDelivered?.();
      load();
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function downloadAgain(dl) {
    setBusy(`0/${dl.invoice_count}`);
    try {
      const { data: rows, error } = await supabase.from('supplier_invoices').select('*')
        .eq('delivery_id', dl.id).order('invoice_date').range(0, 4999);
      if (error) throw error;
      const { blob, failed } = await buildInvoiceZip(rows || [], { indexName: 'סיכום-החבילה.csv', onProgress: (d, t) => setBusy(`${d}/${t}`) });
      saveBlob(blob, `חשבוניות-לרו״ח_${dl.created_at.slice(0, 10)}.zip`);
      if (failed.length) showToast(`⚠️ ${failed.length} קבצים לא ירדו`, 'warning');
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  if (state.loading) return <div style={card}><p style={{ color: '#6B7280', margin: 0 }}>טוען…</p></div>;
  if (state.error) return <div style={card}><p style={{ color: '#991B1B', margin: 0 }}>❌ {state.error}</p></div>;

  const rows = state.undelivered;
  const byMonth = rows.reduce((m, r) => m.set(ym(r.invoice_date), (m.get(ym(r.invoice_date)) || 0) + 1), new Map());
  const total = rows.reduce((s, r) => s + (Number(r.total_incl_vat) || 0), 0);

  return (
    <div style={card}>
      <h3 style={{ margin: 0, fontSize: '1.1rem' }}>📦 חבילה לרו״ח</h3>
      <p style={{ color: '#6B7280', fontSize: '0.86rem', margin: '0.3rem 0 0.8rem' }}>
        כל החשבוניות המאושרות שעוד לא נשלחו, מכל חודש. אחרי ההורדה הן מסומנות כנשלחו ולא ייכנסו שוב לחבילה הבאה.
      </p>

      {rows.length === 0 ? (
        <p style={{ fontWeight: 600, color: '#166534', margin: 0 }}>✅ אין חשבוניות חדשות. הכל נשלח.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.8rem' }}>
            <span style={chip('#EFF6FF', '#1E40AF')}>{rows.length} חשבוניות · ₪{money(total)}</span>
            {[...byMonth].map(([m, n]) => <span key={m} style={chip('#F3F4F6', '#4B5563')}>{m}: {n}</span>)}
          </div>
          <button style={btn('#3D4A2E', !!busy)} disabled={!!busy} onClick={sendNew}>
            {busy ? `מכין חבילה… ${busy}` : `📦 הורדת חבילה חדשה (${rows.length})`}
          </button>
        </>
      )}
      {state.pending > 0 && (
        <p style={{ fontSize: '0.84rem', color: '#92400E', margin: '0.7rem 0 0' }}>
          {state.pending} חשבוניות עדיין ממתינות לאישור. הן ייכנסו לחבילה אחרי שיאושרו.
        </p>
      )}

      {state.deliveries.length > 0 && (
        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: '0.92rem', color: '#374151' }}>חבילות שנשלחו ({state.deliveries.length})</summary>
          <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '560px' }}>
              <thead><tr>
                <th style={th}>נשלחה</th><th style={th}>ע״י</th><th style={th}>חשבוניות</th><th style={th}>טווח תאריכים</th><th style={{ ...th, textAlign: 'left' }}>סה״כ</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {state.deliveries.map((dl) => (
                  <tr key={dl.id}>
                    <td style={td}>{dateIL(dl.created_at)}</td>
                    <td style={{ ...td, color: '#6B7280' }}>{dl.created_by_name || ''}</td>
                    <td style={td}>{dl.invoice_count}</td>
                    <td style={td}>{dateIL(dl.oldest_invoice)} – {dateIL(dl.newest_invoice)}</td>
                    <td style={{ ...td, textAlign: 'left', direction: 'ltr' }}>{money(dl.total_incl_vat)}</td>
                    <td style={td}>
                      <button disabled={!!busy} onClick={() => downloadAgain(dl)} style={{ background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer', color: '#556B3A', fontWeight: 600 }}>⬇️ הורדה שוב</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
