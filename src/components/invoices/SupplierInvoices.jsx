import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Camera, Check, CircleCheck, Clock, Download, FileText, FolderOpen,
  Loader2, Package, Pencil, Search, X, XCircle,
} from 'lucide-react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import {
  prepareInvoiceFile, blobToBase64, invoiceWarnings, DOC_TYPE_LABELS,
} from '../../lib/invoiceFiles';
import { buildInvoiceZip, saveBlob } from '../../lib/invoiceZip';
import DeliveryPanel from './DeliveryPanel';
import LedgerReconcile from './LedgerReconcile';
import CardReconcile from './CardReconcile';
import BankReconcile from './BankReconcile';
import { PageHeader, Kpi } from '../shared/ui';
import './invoices.css';

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

async function fnError(error) {
  // functions.invoke puts a non-2xx Response on error.context; the reason is in its body.
  try { const b = await error.context?.json?.(); if (b?.error) return b; } catch { /* keep message */ }
  return { error: error.message };
}

async function openFile(inv, showToast) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(inv.file_path, 300);
  if (error) { showToast(error.message, 'error'); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

// The DB refuses a second CONFIRMED invoice with the same supplier + number
// + type (migration 20261022_invoice_duplicates); say so in words.
const dbError = (e) => (e?.code === '23505'
  ? 'כבר קיימת חשבונית מאושרת מאותו ספק עם אותו מספר. זו כנראה כפילות, אפשר למחוק את ההעלאה הזו'
  : e?.message);

/** Read cleanly with nothing to look at: safe to approve in one click. */
function readyToApprove(inv) {
  return !!inv && inv.status === 'pending_review' && inv.extraction?.ok !== false
    && !inv.possible_duplicate_of && invoiceWarnings(inv).length === 0;
}

/** Confirm several invoices; one failing (e.g. a duplicate) does not stop the rest. */
async function approveMany(invoices) {
  const ok = [], failed = [];
  for (const inv of invoices) {
    const { data, error } = await supabase.from('supplier_invoices')
      .update({ status: 'confirmed' }).eq('id', inv.id).select('*');
    if (error || !data?.length) failed.push({ inv, message: error ? dbError(error) : 'אין הרשאה' });
    else ok.push(data[0]);
  }
  return { ok, failed };
}

const UPLOADABLE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };

/** Files as dropped or picked; a .zip is opened and its images / PDFs taken out. */
async function expandFiles(files) {
  const out = [], skipped = [];
  for (const f of files) {
    if (!/\.zip$/i.test(f.name) && !/zip/.test(f.type)) { out.push(f); continue; }
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(f);
    for (const entry of Object.values(zip.files)) {
      const base = entry.name.split('/').pop();
      if (entry.dir || !base || base.startsWith('.') || entry.name.includes('__MACOSX')) continue;
      const mime = UPLOADABLE[base.split('.').pop().toLowerCase()];
      if (!mime) { skipped.push(base); continue; }
      out.push(new File([await entry.async('blob')], base, { type: mime }));
    }
  }
  return { files: out, skipped };
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
      if (f.invoice_date && !(f.invoice_date >= '2000-01-01')) throw new Error('התאריך לא תקין. בדקו את השנה');
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
      if (error) throw new Error(dbError(error));
      if (!data?.length) throw new Error('אין הרשאה לעדכן את החשבונית הזו');
      showToast(confirm ? 'החשבונית אושרה' : 'נשמר');
      onSaved(data[0]);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('למחוק את החשבונית ואת הקובץ?')) return;
    setBusy(true);
    const { error } = await supabase.functions.invoke('supplier-invoices', { body: { action: 'delete', id: invoice.id } });
    setBusy(false);
    if (error) { showToast((await fnError(error)).error, 'error'); return; }
    showToast('נמחקה');
    onDeleted(invoice.id);
  }

  const field = (label, k, props = {}) => (
    <label className="inv-field">
      <span>{label}</span>
      <input value={f[k]} onChange={set(k)} disabled={!canEdit} {...props} />
    </label>
  );

  return (
    <div className="inv-form">
      <div className="inv-form-top">
        <button type="button" className="btn sm" onClick={() => openFile(invoice, showToast)}>
          <FileText aria-hidden="true" />צפייה בקובץ
        </button>
        {invoice.extraction && invoice.extraction.ok === false && (
          <span className="tag warn inv-tag-wrap">לא הצלחנו לקרוא את החשבונית. נא למלא ידנית</span>
        )}
        {onClose && (
          <button type="button" className="btn-icon inv-form-close" onClick={onClose} aria-label="סגירה" title="סגירה">
            <X aria-hidden="true" />
          </button>
        )}
      </div>

      {duplicates?.length > 0 && (
        <div className="notice danger inv-notice" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            נראה שהחשבונית הזו כבר הועלתה:
            <ul className="inv-dup-list">
              {duplicates.map((d) => (
                <li key={d.id} className="num">{d.supplier_name} #{d.invoice_number}, {dateIL(d.invoice_date)}, ₪{money(d.total_incl_vat)}{d.uploaded_by_name ? `, הועלתה ע״י ${d.uploaded_by_name}` : ''}</li>
              ))}
            </ul>
            אם זו אותה חשבונית, מחקו את ההעלאה הזו.
          </div>
        </div>
      )}
      {!duplicates?.length && invoice.possible_duplicate_of && (
        <div className="notice danger inv-notice" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>נראה שחשבונית זהה כבר קיימת במערכת (אותו ספק ומספר, או אותו ספק, תאריך וסכום). אם זו אותה חשבונית, מחקו את ההעלאה הזו.</div>
        </div>
      )}

      <div className="inv-fields">
        {field('שם הספק', 'supplier_name')}
        {field('ח.פ / ע.מ', 'supplier_tax_id', { inputMode: 'numeric' })}
        {field('מספר חשבונית', 'invoice_number')}
        <label className="inv-field">
          <span>סוג מסמך</span>
          <select value={f.doc_type} onChange={set('doc_type')} disabled={!canEdit}>
            {Object.entries(DOC_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {field('תאריך', 'invoice_date', { type: 'date', min: '2000-01-01', max: `${new Date().getFullYear() + 1}-12-31` })}
        {field('לפני מע״מ', 'amount_before_vat', { type: 'number', step: '0.01', inputMode: 'decimal' })}
        {field('מע״מ', 'vat_amount', { type: 'number', step: '0.01', inputMode: 'decimal' })}
        {field('סה״כ כולל מע״מ', 'total_incl_vat', { type: 'number', step: '0.01', inputMode: 'decimal' })}
        {field('מספר הקצאה', 'allocation_number', { inputMode: 'numeric' })}
        {field('הערה', 'notes')}
      </div>

      {warnings.length > 0 && (
        <div className="notice warn inv-notice">
          <AlertTriangle size={16} aria-hidden="true" />
          <ul className="inv-warn-list">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      {canEdit && (
        <div className="inv-form-actions">
          {invoice.status === 'pending_review'
            ? <button type="button" className="btn primary" disabled={busy} onClick={() => save(true)}><Check aria-hidden="true" />אישור</button>
            : <button type="button" className="btn primary" disabled={busy} onClick={() => save(false)}>שמירה</button>}
          {invoice.status === 'pending_review' && <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>שמירה בלי לאשר</button>}
          {canDelete && <button type="button" className="btn danger inv-delete" disabled={busy} onClick={remove}>מחיקה</button>}
        </div>
      )}
    </div>
  );
}

// ── Upload ──────────────────────────────────────────────────────────────────
// Pick, photograph or drop files (a .zip is opened). Three upload at a time:
// more and a phone on shop Wi-Fi starts failing; fewer and 100 invoices take
// 8 minutes. Each lands as pending_review; the clean ones are approved in one
// click, the rest are checked one by one.
const PARALLEL = 3;

function Uploader({ onUploaded }) {
  const { showToast, isAdmin } = useApp();
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [queue, setQueue] = useState([]);   // { key, name, state, message?, invoice?, duplicates? }
  const [progress, setProgress] = useState({ total: 0, done: 0 });
  const [dragging, setDragging] = useState(false);
  const [approving, setApproving] = useState(false);

  const patch = (key, p) => setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...p } : it)));

  async function processOne(it) {
    patch(it.key, { state: 'working' });
    try {
      const { blob, mime } = await prepareInvoiceFile(it.file);
      const data = await blobToBase64(blob);
      const { data: res, error } = await supabase.functions.invoke('supplier-invoices', {
        body: { action: 'ingest', filename: it.name, mime, data },
      });
      if (error) {
        const b = await fnError(error);
        patch(it.key, { state: 'error', message: b.error, file: undefined });
      } else {
        patch(it.key, { state: 'review', invoice: res.invoice, duplicates: res.possible_duplicates, file: undefined });
        onUploaded(res.invoice);
      }
    } catch (err) {
      patch(it.key, { state: 'error', message: err.message, file: undefined });
    } finally {
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
  }

  async function addFiles(list) {
    let files = Array.from(list || []);
    if (!files.length) return;
    try {
      const { files: expanded, skipped } = await expandFiles(files);
      if (skipped.length) showToast(`${skipped.length} קבצים ב-ZIP דולגו (לא תמונה / PDF)`, 'warning');
      files = expanded;
    } catch (e) {
      showToast(`לא הצלחנו לפתוח את קובץ ה-ZIP: ${e.message}`, 'error');
      return;
    }
    if (!files.length) return;
    const stamp = Date.now();
    const items = files.map((file, i) => ({ key: `${stamp}-${i}`, name: file.name, file, state: 'waiting' }));
    setQueue((q) => [...items, ...q]);
    setProgress((p) => (p.done >= p.total ? { total: items.length, done: 0 } : { ...p, total: p.total + items.length }));
    let next = 0;
    const worker = async () => { while (next < items.length) await processOne(items[next++]); };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  }

  const onPick = (e) => { const f = e.target.files; addFiles(f).finally(() => { e.target.value = ''; }); };
  const onDrop = (e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files); };

  const done = (key, inv) => { patch(key, { state: 'done', invoice: inv }); onUploaded(inv); };
  const dropped = (key) => setQueue((q) => q.filter((it) => it.key !== key));
  const inReview = queue.filter((it) => it.state === 'review');
  const ready = inReview.filter((it) => readyToApprove(it.invoice));
  const errors = queue.filter((it) => it.state === 'error').length;
  const running = progress.done < progress.total;

  async function approveReady() {
    setApproving(true);
    try {
      const { ok, failed } = await approveMany(ready.map((it) => it.invoice));
      const keyOf = new Map(ready.map((it) => [it.invoice.id, it.key]));
      ok.forEach((inv) => done(keyOf.get(inv.id), inv));
      failed.forEach(({ inv, message }) => patch(keyOf.get(inv.id), { invoice: { ...inv, possible_duplicate_of: inv.possible_duplicate_of || 'db' }, approveError: message }));
      showToast(failed.length ? `אושרו ${ok.length}, ${failed.length} לא אושרו (כנראה כפילות)` : `אושרו ${ok.length} חשבוניות`, failed.length ? 'warning' : 'success');
    } finally {
      setApproving(false);
    }
  }

  return (
    <section
      className={`card flush inv-upload${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={onDrop}
    >
      <div className="card-head">
        <h2>העלאת חשבוניות</h2>
      </div>
      <div className="card-body">
        <p className="inv-lead">
          אפשר לצלם, לבחור קבצים או לגרור לכאן קבצים או ZIP, גם הרבה יחד. המערכת קוראת את הפרטים ובודקת כפילויות, ונשאר רק לאשר.
        </p>
        <div className="inv-upload-actions">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            <FolderOpen aria-hidden="true" />בחירת קבצים
          </button>
          <button type="button" className="btn primary" onClick={() => cameraRef.current?.click()}>
            <Camera aria-hidden="true" />צילום חשבונית
          </button>
          <span className="inv-hint">תמונה, PDF או ZIP</span>
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onPick} hidden />
        <input ref={fileRef} type="file" accept="image/*,application/pdf,.zip,application/zip" multiple onChange={onPick} hidden />

        {progress.total > 0 && (
          <div className="inv-progress">
            <div className="inv-progress-row">
              <span className="num">{running ? `העלאה וקריאה… ${progress.done} מתוך ${progress.total}` : `הסתיים: ${progress.total} קבצים`}</span>
              {errors > 0 && <span className="inv-text-danger num">{errors} נכשלו</span>}
            </div>
            <div className="meter" role="progressbar" aria-label="התקדמות ההעלאה" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
              <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
            {running && <p className="inv-hint">נא לא לסגור את הדף עד הסיום.</p>}
          </div>
        )}

        {inReview.length > 0 && (
          <div className="inv-review-bar">
            <span className="tag warn num">{inReview.length} ממתינות לאישור</span>
            {ready.length > 0 && (
              <button type="button" className="btn primary sm" disabled={approving} onClick={approveReady}>
                <Check aria-hidden="true" />
                {approving ? 'באישור…' : `אישור כל ה-${ready.length} שנקראו בלי בעיות`}
              </button>
            )}
            {inReview.length > ready.length && (
              <span className="inv-hint num">{inReview.length - ready.length} צריכות בדיקה ידנית (אזהרה, כפילות או שלא נקראו)</span>
            )}
          </div>
        )}
      </div>

      {queue.length > 0 && (
        <ul className="inv-queue">
          {queue.map((it) => (
            <li key={it.key} className="inv-queue-item">
              {it.state === 'waiting' && (
                <div className="inv-q-line is-muted">
                  <Clock size={16} aria-hidden="true" />
                  <span className="inv-q-name">{it.name}</span>
                  <span className="inv-q-msg">בתור</span>
                </div>
              )}
              {it.state === 'working' && (
                <div className="inv-q-line">
                  <Loader2 size={16} className="inv-spin" aria-hidden="true" />
                  <span className="inv-q-name">{it.name}</span>
                  <span className="inv-q-msg inv-hint">כיווץ, העלאה וקריאת החשבונית…</span>
                </div>
              )}
              {it.state === 'error' && (
                <div className="inv-q-line is-danger">
                  <XCircle size={16} aria-hidden="true" />
                  <span className="inv-q-name">{it.name}</span>
                  <span className="inv-q-msg">{it.message}</span>
                  <button type="button" className="btn-icon inv-q-end" onClick={() => dropped(it.key)} aria-label="הסרה מהרשימה" title="הסרה מהרשימה">
                    <X aria-hidden="true" />
                  </button>
                </div>
              )}
              {it.state === 'done' && (
                <div className="inv-q-line is-ok">
                  <CircleCheck size={16} aria-hidden="true" />
                  <span className="inv-q-name">{it.invoice?.supplier_name || it.name} #{it.invoice?.invoice_number || ''}</span>
                  <span className="inv-q-msg">אושרה</span>
                </div>
              )}
              {it.state === 'review' && readyToApprove(it.invoice) && (
                <div className="inv-q-line">
                  <span className="tag ok">מוכנה לאישור</span>
                  <span className="inv-q-name"><strong>{it.invoice.supplier_name}</strong> #{it.invoice.invoice_number}</span>
                  <span className="inv-q-msg inv-hint num">{dateIL(it.invoice.invoice_date)} · ₪{money(it.invoice.total_incl_vat)}</span>
                  <button type="button" className="btn ghost sm inv-q-end" aria-expanded={!!it.expanded} onClick={() => patch(it.key, { expanded: !it.expanded })}>
                    {it.expanded ? 'סגירה' : 'בדיקה ועריכה'}
                  </button>
                </div>
              )}
              {it.state === 'review' && (!readyToApprove(it.invoice) || it.expanded) && (
                <>
                  {it.approveError && (
                    <div className="inv-q-line is-danger inv-q-approve-error">
                      <XCircle size={16} aria-hidden="true" />
                      <span className="inv-q-msg">{it.approveError}</span>
                    </div>
                  )}
                  <InvoiceForm
                    invoice={it.invoice}
                    duplicates={it.duplicates}
                    canEdit
                    isAdmin={isAdmin}
                    onSaved={(inv) => (inv.status === 'confirmed' ? done(it.key, inv) : (patch(it.key, { invoice: inv }), onUploaded(inv)))}
                    onDeleted={(id) => { dropped(it.key); onUploaded({ id, _deleted: true }); showToast('ההעלאה בוטלה'); }}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
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
      showToast(e.message, 'error');
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

  // A month by invoice date, for looking things up. What the bookkeeper is
  // SENT goes through the delivery package (DeliveryPanel), not this.
  async function downloadZip() {
    if (!rows?.length) return;
    setZipping(`0/${rows.length}`);
    try {
      const { blob, failed } = await buildInvoiceZip(rows, {
        indexName: `סיכום_${month}.csv`, booked, onProgress: (d, t) => setZipping(`${d}/${t}`),
      });
      saveBlob(blob, `חשבוניות-ספקים_${month}.zip`);
      showToast(failed.length ? `${failed.length} קבצים לא ירדו: ${failed.join(', ')}` : `ירדו ${rows.length} חשבוניות`, failed.length ? 'warning' : 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setZipping(null);
    }
  }

  const canEditRow = (r) => isAdmin || (!isBookkeeper && r.uploaded_by === user?.id && r.status === 'pending_review');
  const readyRows = (rows || []).filter((r) => canEditRow(r) && readyToApprove(r));
  const [approvingAll, setApprovingAll] = useState(false);

  async function approveAllReady() {
    setApprovingAll(true);
    try {
      const { ok, failed } = await approveMany(readyRows);
      ok.forEach(upsertRow);
      showToast(failed.length ? `אושרו ${ok.length}, ${failed.length} לא אושרו: ${failed[0].message}` : `אושרו ${ok.length} חשבוניות`, failed.length ? 'warning' : 'success');
    } finally {
      setApprovingAll(false);
    }
  }

  return (
    <div className="page invoices-page">
      <PageHeader
        title="חשבוניות ספקים"
        subtitle={seesAll ? 'חשבוניות החודש, החבילה לרו״ח וההתאמות מול הנהלת החשבונות' : 'צילום והעלאה של חשבוניות על תשלומים לספקים'}
        actions={(
          <label className="inv-month">
            <span>חודש</span>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </label>
        )}
      />

      {rows && rows.length > 0 && (
        <section className="kpis inv-kpis" aria-label="סיכום החודש">
          <Kpi label="חשבוניות בחודש" value={rows.length} note={seesAll ? 'לפי תאריך החשבונית' : 'שהעליתם, לפי תאריך החשבונית'} />
          <Kpi label="ממתינות לאישור" value={pending} note={pending > 0 ? 'צריכות בדיקה ואישור' : 'אין חשבוניות שממתינות'} />
          <Kpi label="לפני מע״מ" value={`₪${money(sum('amount_before_vat'))}`} note="סכום החשבוניות בחודש" />
          <Kpi label="כולל מע״מ" value={`₪${money(sum('total_incl_vat'))}`} note="סכום החשבוניות בחודש" />
        </section>
      )}

      {!isBookkeeper && <Uploader onUploaded={upsertRow} />}
      {seesAll && <DeliveryPanel onDelivered={load} />}

      <section className="card flush">
        <div className="card-head inv-head">
          <div>
            <h2>חשבוניות החודש</h2>
            {!seesAll && <div className="inv-head-sub">מוצגות החשבוניות שהעליתם.</div>}
          </div>
          <div className="card-head-end inv-head-actions">
            {rows && readyRows.length > 0 && (
              <button type="button" className="btn primary sm" disabled={approvingAll} onClick={approveAllReady}>
                <Check aria-hidden="true" />
                {approvingAll ? 'באישור…' : `אישור ${readyRows.length} שנקראו בלי בעיות`}
              </button>
            )}
            {seesAll && rows?.length > 0 && (
              <button type="button" className="btn sm" disabled={!!zipping} onClick={downloadZip}>
                <Download aria-hidden="true" />
                {zipping ? `הכנת ZIP… ${zipping}` : `הורדת החודש לעיון (${rows.length})`}
              </button>
            )}
          </div>
        </div>

        {loading && !rows && <div className="empty-state">בטעינה…</div>}
        {rows && rows.length === 0 && <div className="empty-state">אין חשבוניות בחודש הזה.</div>}
        {rows && rows.length > 0 && (
          <div className="inv-table-wrap inv-table-main-wrap">
            <table className="inv-table inv-table-main">
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>ספק</th>
                  <th>מס׳ חשבונית</th>
                  <th>סוג</th>
                  <th className="end">לפני מע״מ</th>
                  <th className="end">כולל מע״מ</th>
                  <th>סטטוס</th>
                  <th>הועלה ע״י</th>
                  <th><span className="inv-sr">פעולות</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <React.Fragment key={r.id}>
                    <tr className={openId === r.id ? 'is-open' : undefined}>
                      <td className="num">{dateIL(r.invoice_date)}</td>
                      <td className="inv-strong">{r.supplier_name || '—'}</td>
                      <td>{r.invoice_number || '—'}</td>
                      <td className="inv-muted inv-nowrap">{DOC_TYPE_LABELS[r.doc_type] || r.doc_type}</td>
                      <td className="end amt">{money(r.amount_before_vat)}</td>
                      <td className="end amt">{money(r.total_incl_vat)}</td>
                      <td>
                        <div className="inv-tags">
                          {r.status === 'confirmed'
                            ? <span className="tag ok">אושר</span>
                            : <span className="tag warn">ממתין לבדיקה</span>}
                          {seesAll && r.delivery_id && <span title="נשלחה לרו״ח בחבילה" className="tag"><Package size={13} aria-hidden="true" />נשלח</span>}
                          {r.possible_duplicate_of && <span title="נראה שחשבונית זהה כבר קיימת במערכת" className="tag danger">כפילות?</span>}
                          {seesAll && booked.has(r.id) && <span title="נמצאה בכרטסת הנהלת החשבונות" className="tag brand">נקלט</span>}
                          {invoiceWarnings(r).length > 0 && (
                            <span className="inv-warn-ico" role="img" title={invoiceWarnings(r).join('\n')} aria-label={invoiceWarnings(r).join(', ')}>
                              <AlertTriangle size={15} aria-hidden="true" />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="inv-muted">{r.uploaded_by_name || ''}</td>
                      <td>
                        <div className="action-buttons">
                          <button type="button" className="btn-icon" title="צפייה בקובץ" aria-label="צפייה בקובץ" onClick={() => openFile(r, showToast)}>
                            <FileText aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={`btn-icon${openId === r.id ? ' is-active' : ''}`}
                            title={canEditRow(r) ? 'עריכה' : 'פרטים'}
                            aria-label={canEditRow(r) ? 'עריכה' : 'פרטים'}
                            aria-expanded={openId === r.id}
                            onClick={() => setOpenId(openId === r.id ? null : r.id)}
                          >
                            {canEditRow(r) ? <Pencil aria-hidden="true" /> : <Search aria-hidden="true" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {openId === r.id && (
                      <tr className="inv-form-row">
                        <td colSpan={9}>
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
          </div>
        )}
      </section>

      {seesAll && (
        <div className="inv-group-title">
          <h2>התאמות החודש</h2>
          <p>מול הכרטסת של הנהלת החשבונות, פירוטי כרטיסי האשראי ודוח הבנק</p>
        </div>
      )}
      {seesAll && <LedgerReconcile month={month} onBooked={setBooked} />}
      {seesAll && <CardReconcile month={month} />}
      {seesAll && <BankReconcile month={month} />}
    </div>
  );
}
