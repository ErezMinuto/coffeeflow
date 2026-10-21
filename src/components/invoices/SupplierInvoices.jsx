import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import {
  prepareInvoiceFile, blobToBase64, invoiceWarnings, invoiceFileName, DOC_TYPE_LABELS,
} from '../../lib/invoiceFiles';
import LedgerReconcile from './LedgerReconcile';
import CardReconcile from './CardReconcile';

// ── Supplier invoices (חשבוניות ספקים) ──────────────────────────────────────
// Staff photograph / upload every invoice for a payment Minuto made to a
// supplier. The photo is shrunk in the browser, the supplier-invoices edge
// function stores it and reads the fields with Claude, and the uploader checks
// them and confirms. The bookkeeper (role 'bookkeeper', who sees only this
// page) and admins see every invoice and download a month as a ZIP.
// Who sees which rows is enforced by RLS (migration 20261021_supplier_invoices).

const BUCKET = 'supplier-invoices';
const TZ = 'Asia/Jerusalem';
const thisMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }).slice(0, 7);
const monthRange = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${ym}-01`, `${next}-01`];
};
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dateIL = (d) => (d ? d.split('-').reverse().join('/') : '—');

const EDITABLE = ['supplier_name', 'supplier_tax_id', 'invoice_number', 'doc_type', 'invoice_date',
  'amount_before_vat', 'vat_amount', 'total_incl_vat', 'allocation_number', 'notes'];

const pill = (bg, color) => ({
  background: bg, color, borderRadius: '999px', padding: '2px 10px', fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
});
const card = { background: 'white', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '1000px', margin: '1.25rem auto' };
const btn = (bg, disabled) => ({ padding: '0.65rem 1.05rem', fontSize: '0.95rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer' });
const input = { padding: '0.5rem 0.65rem', fontSize: '0.95rem', border: '1px solid #D5DBC8', borderRadius: '8px', width: '100%', boxSizing: 'border-box' };
const th = { textAlign: 'right', padding: '0.5rem 0.6rem', borderBottom: '2px solid #E5E7EB', fontSize: '0.82rem', color: '#374151', whiteSpace: 'nowrap' };
const td = { padding: '0.45rem 0.6rem', borderBottom: '1px solid #F3F4F6', fontSize: '0.88rem' };

async function fnError(error) {
  // functions.invoke puts a non-2xx Response on error.context; the reason is in its body.
  try { const b = await error.context?.json?.(); if (b?.error) return b; } catch { /* keep message */ }
  return { error: error.message };
}

async function openFile(inv, showToast) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(inv.file_path, 300);
  if (error) { showToast(`❌ ${error.message}`, 'error'); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

// ── One invoice's fields, editable ──────────────────────────────────────────
function InvoiceForm({ invoice, duplicates, canEdit, isAdmin, onSaved, onDeleted, onClose }) {
  const { showToast } = useApp();
  const [f, setF] = useState(() => Object.fromEntries(EDITABLE.map((k) => [k, invoice[k] ?? ''])));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const warnings = invoiceWarnings(f);
  const canDelete = isAdmin || invoice.status === 'pending_review';

  async function save(confirm) {
    setBusy(true);
    try {
      const num = (v) => (v === '' || v == null ? null : Number(v));
      const patch = {
        ...Object.fromEntries(EDITABLE.map((k) => [k, f[k] === '' ? null : f[k]])),
        amount_before_vat: num(f.amount_before_vat),
        vat_amount: num(f.vat_amount),
        total_incl_vat: num(f.total_incl_vat),
        supplier_tax_id: f.supplier_tax_id ? String(f.supplier_tax_id).replace(/\D/g, '') || null : null,
        doc_type: f.doc_type || 'tax_invoice',
        ...(confirm ? { status: 'confirmed' } : {}),
      };
      const { data, error } = await supabase.from('supplier_invoices').update(patch).eq('id', invoice.id).select('*');
      if (error) throw error;
      if (!data?.length) throw new Error('אין הרשאה לעדכן את החשבונית הזו');
      showToast(confirm ? '✅ החשבונית אושרה' : '✅ נשמר');
      onSaved(data[0]);
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('למחוק את החשבונית ואת הקובץ?')) return;
    setBusy(true);
    const { error } = await supabase.functions.invoke('supplier-invoices', { body: { action: 'delete', id: invoice.id } });
    setBusy(false);
    if (error) { showToast(`❌ ${(await fnError(error)).error}`, 'error'); return; }
    showToast('🗑️ נמחקה');
    onDeleted(invoice.id);
  }

  const field = (label, k, props = {}) => (
    <label style={{ fontSize: '0.82rem', color: '#374151', display: 'block' }}>
      {label}
      <input value={f[k]} onChange={set(k)} disabled={!canEdit} style={{ ...input, marginTop: '0.2rem' }} {...props} />
    </label>
  );

  return (
    <div style={{ border: '1px solid #E5E7EB', borderRadius: '10px', padding: '1rem', background: '#FAFBF7' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <button onClick={() => openFile(invoice, showToast)} style={{ ...btn('#6B7280', false), padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>📄 צפייה בקובץ</button>
        {invoice.extraction && invoice.extraction.ok === false && (
          <span style={pill('#FEF3C7', '#92400E')}>לא הצלחנו לקרוא את החשבונית. נא למלא ידנית</span>
        )}
        {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer' }} aria-label="סגירה">✕</button>}
      </div>

      {duplicates?.length > 0 && (
        <div style={{ background: '#FEE2E2', color: '#991B1B', padding: '0.6rem 0.8rem', borderRadius: '8px', fontSize: '0.88rem', marginBottom: '0.75rem' }}>
          ⚠️ נראה שהחשבונית הזו כבר הועלתה:
          {duplicates.map((d) => (
            <div key={d.id}>• {d.supplier_name} #{d.invoice_number}, {dateIL(d.invoice_date)}, ₪{money(d.total_incl_vat)}{d.uploaded_by_name ? `, הועלתה ע״י ${d.uploaded_by_name}` : ''}</div>
          ))}
          אם זו אותה חשבונית, מחקו את ההעלאה הזו.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.6rem' }}>
        {field('שם הספק', 'supplier_name')}
        {field('ח.פ / ע.מ', 'supplier_tax_id', { inputMode: 'numeric' })}
        {field('מספר חשבונית', 'invoice_number')}
        <label style={{ fontSize: '0.82rem', color: '#374151', display: 'block' }}>
          סוג מסמך
          <select value={f.doc_type} onChange={set('doc_type')} disabled={!canEdit} style={{ ...input, marginTop: '0.2rem' }}>
            {Object.entries(DOC_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {field('תאריך', 'invoice_date', { type: 'date' })}
        {field('לפני מע״מ', 'amount_before_vat', { type: 'number', step: '0.01', inputMode: 'decimal' })}
        {field('מע״מ', 'vat_amount', { type: 'number', step: '0.01', inputMode: 'decimal' })}
        {field('סה״כ כולל מע״מ', 'total_incl_vat', { type: 'number', step: '0.01', inputMode: 'decimal' })}
        {field('מספר הקצאה', 'allocation_number', { inputMode: 'numeric' })}
        {field('הערה', 'notes')}
      </div>

      {warnings.length > 0 && (
        <ul style={{ background: '#FEF3C7', color: '#92400E', padding: '0.5rem 1.6rem', borderRadius: '8px', fontSize: '0.85rem', margin: '0.75rem 0 0' }}>
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      {canEdit && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
          {invoice.status === 'pending_review'
            ? <button style={btn('#16A34A', busy)} disabled={busy} onClick={() => save(true)}>✓ אישור</button>
            : <button style={btn('#16A34A', busy)} disabled={busy} onClick={() => save(false)}>שמירה</button>}
          {invoice.status === 'pending_review' && <button style={btn('#6B7280', busy)} disabled={busy} onClick={() => save(false)}>שמירה בלי לאשר</button>}
          {canDelete && <button style={btn('#DC2626', busy)} disabled={busy} onClick={remove}>מחיקה</button>}
        </div>
      )}
    </div>
  );
}

// ── Upload ──────────────────────────────────────────────────────────────────
function Uploader({ onUploaded }) {
  const { showToast, isAdmin } = useApp();
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [queue, setQueue] = useState([]);   // { key, name, state, message?, invoice?, duplicates? }

  const patch = (key, p) => setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...p } : it)));

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const items = files.map((file, i) => ({ key: `${Date.now()}-${i}`, name: file.name, file, state: 'waiting' }));
    setQueue((q) => [...items, ...q]);

    // One at a time: a phone on shop Wi-Fi uploading 10 photos at once fails.
    for (const it of items) {
      patch(it.key, { state: 'working' });
      try {
        const { blob, mime } = await prepareInvoiceFile(it.file);
        const data = await blobToBase64(blob);
        const { data: res, error } = await supabase.functions.invoke('supplier-invoices', {
          body: { action: 'ingest', filename: it.name, mime, data },
        });
        if (error) {
          const b = await fnError(error);
          patch(it.key, { state: 'error', message: b.error });
          continue;
        }
        patch(it.key, { state: 'review', invoice: res.invoice, duplicates: res.possible_duplicates, file: undefined });
        onUploaded(res.invoice);
      } catch (err) {
        patch(it.key, { state: 'error', message: err.message });
      }
    }
  }

  const done = (key, inv) => { patch(key, { state: 'done', invoice: inv }); onUploaded(inv); };
  const dropped = (key) => setQueue((q) => q.filter((it) => it.key !== key));
  const waiting = queue.filter((it) => it.state === 'review').length;

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>📤 העלאת חשבונית</h3>
      <p style={{ color: '#6B7280', fontSize: '0.88rem', marginTop: 0 }}>
        צלמו או העלו כל חשבונית / קבלה מספק. אפשר כמה קבצים יחד. המערכת קוראת את הפרטים, ואתם בודקים ומאשרים.
      </p>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button style={btn('#3D4A2E', false)} onClick={() => cameraRef.current?.click()}>📷 צילום חשבונית</button>
        <button style={btn('#556B3A', false)} onClick={() => fileRef.current?.click()}>📁 בחירת קבצים (תמונה / PDF)</button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={handleFiles} style={{ display: 'none' }} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple onChange={handleFiles} style={{ display: 'none' }} />

      {waiting > 0 && <p style={{ color: '#92400E', fontWeight: 600, fontSize: '0.9rem' }}>{waiting} ממתינות לבדיקה ואישור ⬇️</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
        {queue.map((it) => (
          <div key={it.key}>
            {it.state === 'waiting' && <div style={{ color: '#6B7280', fontSize: '0.88rem' }}>⏳ {it.name}: בתור</div>}
            {it.state === 'working' && <div style={{ color: '#1E40AF', fontSize: '0.88rem' }}>⏳ {it.name}: מכווץ, מעלה וקורא את החשבונית…</div>}
            {it.state === 'error' && (
              <div style={{ color: '#991B1B', fontSize: '0.88rem' }}>
                ❌ {it.name}: {it.message}
                <button onClick={() => dropped(it.key)} style={{ background: 'none', border: 'none', cursor: 'pointer', marginInlineStart: '0.4rem' }}>✕</button>
              </div>
            )}
            {it.state === 'done' && (
              <div style={{ color: '#166534', fontSize: '0.88rem' }}>
                ✅ {it.invoice?.supplier_name || it.name} #{it.invoice?.invoice_number || ''}: אושרה
              </div>
            )}
            {it.state === 'review' && (
              <InvoiceForm
                invoice={it.invoice}
                duplicates={it.duplicates}
                canEdit
                isAdmin={isAdmin}
                onSaved={(inv) => (inv.status === 'confirmed' ? done(it.key, inv) : (patch(it.key, { invoice: inv }), onUploaded(inv)))}
                onDeleted={(id) => { dropped(it.key); onUploaded({ id, _deleted: true }); showToast('🗑️ ההעלאה בוטלה'); }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function SupplierInvoices() {
  const { showToast, isAdmin, userRole, user } = useApp();
  const isBookkeeper = userRole === 'bookkeeper';
  const seesAll = isAdmin || isBookkeeper;
  const [month, setMonth] = useState(thisMonth());
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [zipping, setZipping] = useState(null);   // "3/40" while building
  const [booked, setBooked] = useState(() => new Set());   // invoice ids matched in the bookkeeper's ledger

  async function load() {
    setLoading(true);
    try {
      const [from, to] = monthRange(month);
      // An invoice without a date (still being checked) shows in the month it was uploaded.
      const { data, error } = await supabase
        .from('supplier_invoices')
        .select('*')
        .or(`and(invoice_date.gte.${from},invoice_date.lt.${to}),and(invoice_date.is.null,created_at.gte.${from},created_at.lt.${to})`)
        .order('invoice_date', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the table in step with the uploader without a reload.
  function upsertRow(inv) {
    setRows((r) => {
      if (!r) return r;
      if (inv._deleted) return r.filter((x) => x.id !== inv.id);
      const [from, to] = monthRange(month);
      const day = inv.invoice_date || (inv.created_at || '').slice(0, 10);
      const inMonth = day >= from && day < to;
      const without = r.filter((x) => x.id !== inv.id);
      return inMonth ? [...without, inv].sort((a, b) => String(a.invoice_date || '9').localeCompare(String(b.invoice_date || '9'))) : without;
    });
  }

  const sum = (k) => (rows || []).reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const pending = (rows || []).filter((r) => r.status === 'pending_review').length;

  async function downloadZip() {
    if (!rows?.length) return;
    if (pending && !window.confirm(`${pending} חשבוניות עדיין לא אושרו. להוריד בכל זאת? (הן יסומנו בקובץ הסיכום)`)) return;
    setZipping(`0/${rows.length}`);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const used = new Set();
      const failed = [];
      const zipNames = new Map();
      for (let i = 0; i < rows.length; i++) {
        const inv = rows[i];
        let name = invoiceFileName(inv);
        for (let n = 2; used.has(name); n++) name = invoiceFileName(inv).replace(/(\.[^.]+)$/, `_${n}$1`);
        used.add(name);
        const { data, error } = await supabase.storage.from(BUCKET).download(inv.file_path);
        if (error) failed.push(name); else zip.file(name, data);
        zipNames.set(inv.id, name);
        setZipping(`${i + 1}/${rows.length}`);
      }
      const header = ['תאריך', 'ספק', 'ח.פ', 'מספר חשבונית', 'סוג', 'לפני מע"מ', 'מע"מ', 'סה"כ כולל מע"מ', 'מספר הקצאה', 'סטטוס', 'נקלט בהנה"ח', 'הועלה ע"י', 'קובץ'];
      const lines = rows.map((r) => [
        dateIL(r.invoice_date), r.supplier_name, r.supplier_tax_id, r.invoice_number, DOC_TYPE_LABELS[r.doc_type] || r.doc_type,
        r.amount_before_vat, r.vat_amount, r.total_incl_vat, r.allocation_number,
        r.status === 'confirmed' ? 'אושר' : 'ממתין לבדיקה', booked.has(r.id) ? 'כן' : '', r.uploaded_by_name, zipNames.get(r.id),
      ]);
      lines.push(['', 'סה"כ', '', '', '', sum('amount_before_vat').toFixed(2), sum('vat_amount').toFixed(2), sum('total_incl_vat').toFixed(2)]);
      const csv = '﻿' + [header, ...lines].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      zip.file(`סיכום_${month}.csv`, csv);
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `חשבוניות-ספקים_${month}.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast(failed.length ? `⚠️ ${failed.length} קבצים לא ירדו: ${failed.join(', ')}` : `✅ ירדו ${rows.length} חשבוניות`, failed.length ? 'warning' : 'success');
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      setZipping(null);
    }
  }

  const canEditRow = (r) => isAdmin || (!isBookkeeper && r.uploaded_by === user?.id && r.status === 'pending_review');

  return (
    <div style={{ direction: 'rtl', paddingBottom: '3rem' }}>
      <h2 style={{ textAlign: 'center', marginTop: '1.25rem' }}>חשבוניות ספקים</h2>

      {!isBookkeeper && <Uploader onUploaded={upsertRow} />}

      <div style={card}>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.88rem', color: '#374151' }}>חודש&nbsp;
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ ...input, width: 'auto' }} />
          </label>
          {seesAll && rows?.length > 0 && (
            <button style={btn('#3D4A2E', !!zipping)} disabled={!!zipping} onClick={downloadZip}>
              {zipping ? `מכין ZIP… ${zipping}` : `⬇️ הורדת כל החודש (${rows.length})`}
            </button>
          )}
        </div>
        {!seesAll && <p style={{ color: '#6B7280', fontSize: '0.82rem', marginBottom: 0 }}>מוצגות החשבוניות שהעליתם.</p>}

        {loading && !rows && <p style={{ color: '#6B7280' }}>טוען…</p>}
        {rows && (
          <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
            <p style={{ color: '#6B7280', fontSize: '0.85rem', marginTop: 0 }}>
              {rows.length} חשבוניות · לפני מע״מ ₪{money(sum('amount_before_vat'))} · כולל מע״מ ₪{money(sum('total_incl_vat'))}
              {pending > 0 && <span style={{ ...pill('#FEF3C7', '#92400E'), marginInlineStart: '0.5rem' }}>{pending} ממתינות לאישור</span>}
            </p>
            {rows.length === 0 ? (
              <p style={{ color: '#6B7280' }}>אין חשבוניות בחודש הזה.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '760px' }}>
                <thead>
                  <tr>
                    <th style={th}>תאריך</th>
                    <th style={th}>ספק</th>
                    <th style={th}>מס׳ חשבונית</th>
                    <th style={th}>סוג</th>
                    <th style={{ ...th, textAlign: 'left' }}>לפני מע״מ</th>
                    <th style={{ ...th, textAlign: 'left' }}>כולל מע״מ</th>
                    <th style={th}>סטטוס</th>
                    <th style={th}>הועלה ע״י</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <React.Fragment key={r.id}>
                      <tr>
                        <td style={td}>{dateIL(r.invoice_date)}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{r.supplier_name || '—'}</td>
                        <td style={td}>{r.invoice_number || '—'}</td>
                        <td style={td}>{DOC_TYPE_LABELS[r.doc_type] || r.doc_type}</td>
                        <td style={{ ...td, textAlign: 'left', direction: 'ltr' }}>{money(r.amount_before_vat)}</td>
                        <td style={{ ...td, textAlign: 'left', direction: 'ltr' }}>{money(r.total_incl_vat)}</td>
                        <td style={td}>
                          {r.status === 'confirmed'
                            ? <span style={pill('#DCFCE7', '#166534')}>אושר</span>
                            : <span style={pill('#FEF3C7', '#92400E')}>ממתין לבדיקה</span>}
                          {seesAll && booked.has(r.id) && <span title="נמצאה בכרטסת הנהלת החשבונות" style={{ ...pill('#EFF6FF', '#1E40AF'), marginInlineStart: '0.3rem' }}>📒 נקלט</span>}
                          {invoiceWarnings(r).length > 0 && <span title={invoiceWarnings(r).join('\n')} style={{ marginInlineStart: '0.3rem' }}>⚠️</span>}
                        </td>
                        <td style={{ ...td, color: '#6B7280' }}>{r.uploaded_by_name || ''}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          <button title="צפייה בקובץ" onClick={() => openFile(r, showToast)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }}>📄</button>
                          <button title={canEditRow(r) ? 'עריכה' : 'פרטים'} onClick={() => setOpenId(openId === r.id ? null : r.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }}>{canEditRow(r) ? '✏️' : '🔍'}</button>
                        </td>
                      </tr>
                      {openId === r.id && (
                        <tr>
                          <td colSpan={9} style={{ padding: '0.5rem 0' }}>
                            <InvoiceForm
                              invoice={r}
                              canEdit={canEditRow(r)}
                              isAdmin={isAdmin}
                              onClose={() => setOpenId(null)}
                              onSaved={(inv) => { upsertRow(inv); setOpenId(null); }}
                              onDeleted={(id) => { upsertRow({ id, _deleted: true }); setOpenId(null); }}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {seesAll && <LedgerReconcile month={month} onBooked={setBooked} />}
      {seesAll && <CardReconcile month={month} />}
    </div>
  );
}
