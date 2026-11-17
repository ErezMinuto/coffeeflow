import React, { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, CircleCheck, Download } from 'lucide-react';
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
      // An impossible date (year 0006) cannot be written any more (constraint
      // 20261025b), so marking it sent would fail the whole package: hold it
      // back until someone fixes the date from its file.
      const bad = (undelivered || []).filter((r) => r.invoice_date && r.invoice_date < '2000-01-01');
      setState({
        loading: false, pending: pending || 0, deliveries: deliveries || [], badDates: bad,
        undelivered: (undelivered || []).filter((r) => !bad.includes(r)),
      });
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
      showToast(`נשלחו ${d.invoice_count} חשבוניות`);
      onDelivered?.();
      load();
    } catch (e) {
      showToast(e.message, 'error');
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
      if (failed.length) showToast(`${failed.length} קבצים לא ירדו`, 'warning');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  const head = (
    <div className="card-head">
      <h2>חבילה לרו״ח</h2>
    </div>
  );
  if (state.loading) return <section className="card flush">{head}<div className="empty-state">בטעינה…</div></section>;
  if (state.error) return <section className="card flush">{head}<div className="card-body"><div className="notice danger" role="alert">{state.error}</div></div></section>;

  const rows = state.undelivered;
  const byMonth = rows.reduce((m, r) => m.set(ym(r.invoice_date), (m.get(ym(r.invoice_date)) || 0) + 1), new Map());
  const total = rows.reduce((s, r) => s + (Number(r.total_incl_vat) || 0), 0);

  return (
    <section className="card flush inv-delivery">
      {head}
      <div className="card-body">
        <p className="inv-lead">
          כל החשבוניות המאושרות שעוד לא נשלחו, מכל חודש. אחרי ההורדה הן מסומנות כנשלחו ולא ייכנסו שוב לחבילה הבאה.
        </p>

        {rows.length === 0 ? (
          <div className="inv-allgood">
            <CircleCheck size={18} aria-hidden="true" />
            <span>אין חשבוניות חדשות. הכל נשלח.</span>
          </div>
        ) : (
          <div className="inv-delivery-row">
            <div className="inv-delivery-sum">
              <div className="inv-delivery-total num">{rows.length} חשבוניות · ₪{money(total)}</div>
              <div className="inv-tags">
                {[...byMonth].map(([m, n]) => <span key={m} className="tag num">{m}: {n}</span>)}
              </div>
            </div>
            <button type="button" className="btn primary" disabled={!!busy} onClick={sendNew}>
              <Download aria-hidden="true" />
              {busy ? `הכנת חבילה… ${busy}` : `הורדת חבילה חדשה (${rows.length})`}
            </button>
          </div>
        )}
        {state.badDates.length > 0 && (
          <div className="notice danger inv-notice">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>{state.badDates.length} חשבוניות עם תאריך לא תקין ({state.badDates.map((r) => `${r.supplier_name || ''} #${r.invoice_number || ''}`).join(', ')}) לא ייכנסו לחבילה עד שהתאריך יתוקן.</div>
          </div>
        )}
        {state.pending > 0 && (
          <div className="inv-note">
            <span className="dot warn" aria-hidden="true" />
            <span>{state.pending} חשבוניות עדיין ממתינות לאישור. הן ייכנסו לחבילה אחרי שיאושרו.</span>
          </div>
        )}
      </div>

      {state.deliveries.length > 0 && (
        <details className="inv-section">
          <summary>
            <ChevronDown className="inv-chev" size={16} aria-hidden="true" />
            <span>חבילות שנשלחו</span>
            <span className="inv-count num">{state.deliveries.length}</span>
          </summary>
          <div className="inv-table-wrap">
            <table className="inv-table">
              <thead><tr>
                <th>נשלחה</th><th>ע״י</th><th className="end">חשבוניות</th><th>טווח תאריכים</th><th className="end">סה״כ</th><th><span className="inv-sr">פעולות</span></th>
              </tr></thead>
              <tbody>
                {state.deliveries.map((dl) => (
                  <tr key={dl.id}>
                    <td className="num">{dateIL(dl.created_at)}</td>
                    <td className="inv-muted">{dl.created_by_name || ''}</td>
                    <td className="end num">{dl.invoice_count}</td>
                    <td className="num">{dateIL(dl.oldest_invoice)} – {dateIL(dl.newest_invoice)}</td>
                    <td className="end amt">{money(dl.total_incl_vat)}</td>
                    <td className="end">
                      <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => downloadAgain(dl)}>
                        <Download aria-hidden="true" />הורדה שוב
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
