import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, FileText, Trash2, Upload } from 'lucide-react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import { readXlsxRows, parseLedger, reconcile } from '../../lib/ledgerReconcile';

// ── Reconciliation against the bookkeeper's ledger (admin + bookkeeper) ─────
// Upload the Hashavshevet כרטסת for a period (Excel); the lines are stored in
// ledger_imports / ledger_lines and matched against supplier_invoices here, in
// the browser, every time — so an invoice uploaded after the import still
// matches. Matching rules: src/lib/ledgerReconcile.js.

const BUCKET = 'supplier-invoices';
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dateIL = (d) => (d ? d.split('-').reverse().join('/') : '—');
const shiftDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const monthBounds = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
};

async function openFile(inv, showToast) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(inv.file_path, 300);
  if (error) { showToast(error.message, 'error'); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

function Section({ title, count, tone, children, open = true }) {
  return (
    <details open={open} className="inv-section">
      <summary>
        <ChevronDown className="inv-chev" size={16} aria-hidden="true" />
        {tone && <span className={`dot ${tone}`} aria-hidden="true" />}
        <span>{title}</span>
        <span className="inv-count num">{count}</span>
      </summary>
      <div className="inv-section-body">{children}</div>
    </details>
  );
}

function LinesTable({ lines }) {
  return (
    <div className="inv-table-wrap">
      <table className="inv-table">
        <thead><tr>
          <th>תאריך</th><th>פרטים</th><th>אסמכתא</th><th>ח-ן נגדי</th><th>חשבון</th><th className="end">סכום</th>
        </tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id ?? l.movement_id}>
              <td className="num">{dateIL(l.doc_date)}</td>
              <td className="inv-strong">{l.details}</td>
              <td>{l.ref2 || '—'}</td>
              <td className="inv-muted">{l.counter_account}</td>
              <td className="inv-muted">{l.account_name}</td>
              <td className="end amt">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LedgerReconcile({ month, onBooked }) {
  const { showToast, isAdmin, user } = useApp();
  const fileRef = useRef(null);
  const [state, setState] = useState({ loading: true, imp: null, result: null });
  const [busy, setBusy] = useState(false);

  async function load() {
    setState((s) => ({ ...s, loading: true }));
    try {
      const [first, last] = monthBounds(month);
      const { data: imps, error } = await supabase
        .from('ledger_imports').select('*')
        .lte('period_from', last).gte('period_to', first)
        .order('created_at', { ascending: false }).limit(1);
      if (error) throw error;
      const imp = imps?.[0] || null;
      if (!imp) { setState({ loading: false, imp: null, result: null }); onBooked?.(new Set()); return; }

      const [{ data: lines, error: lErr }, { data: invoices, error: iErr }] = await Promise.all([
        supabase.from('ledger_lines').select('*').eq('import_id', imp.id).order('doc_date').range(0, 9999),
        // A booking dated a few days off its invoice still matches.
        supabase.from('supplier_invoices').select('*')
          .gte('invoice_date', shiftDays(imp.period_from, -15)).lte('invoice_date', shiftDays(imp.period_to, 15))
          .range(0, 9999),
      ]);
      if (lErr) throw lErr;
      if (iErr) throw iErr;
      const lineRows = (lines || []).map((l) => ({ ...l, amount: Number(l.amount) }));
      const result = reconcile(invoices || [], lineRows, { from: imp.period_from, to: imp.period_to });
      setState({ loading: false, imp, result });
      onBooked?.(new Set(result.matches.map((m) => m.invoice.id)));
    } catch (e) {
      setState({ loading: false, imp: null, result: null });
      showToast(e.message, 'error');
    }
  }

  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    let importId = null;
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('נא להעלות קובץ Excel (‎.xlsx) של כרטסת מחשבשבת');
      const parsed = parseLedger(await readXlsxRows(await file.arrayBuffer()));
      const { data: same, error: sErr } = await supabase.from('ledger_imports').select('id')
        .eq('period_from', parsed.period_from).eq('period_to', parsed.period_to);
      if (sErr) throw sErr;
      const msg = `כרטסת ${dateIL(parsed.period_from)} – ${dateIL(parsed.period_to)}, ${parsed.lines.length} תנועות.`
        + (same?.length ? '\nכבר הועלתה כרטסת לאותה תקופה, והיא תוחלף.' : '') + '\n\nלייבא?';
      if (!window.confirm(msg)) return;

      const { data: imp, error: impErr } = await supabase.from('ledger_imports').insert({
        period_from: parsed.period_from, period_to: parsed.period_to, filename: file.name.slice(0, 200),
        line_count: parsed.lines.length, imported_by_name: user?.fullName || user?.primaryEmailAddress?.emailAddress || null,
      }).select('id').single();
      if (impErr) throw impErr;
      importId = imp.id;
      const rows = parsed.lines.map((l) => ({ ...l, import_id: imp.id }));
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await supabase.from('ledger_lines').insert(chunk);
        if (error) throw error;
      }
      // Only now drop the previous import of the same period: a failed upload keeps the old one.
      if (same?.length) {
        const { error } = await supabase.from('ledger_imports').delete().in('id', same.map((s) => s.id));
        if (error) throw error;
      }
      importId = null;
      showToast(`יובאו ${parsed.lines.length} תנועות`);
      load();
    } catch (err) {
      if (importId) await supabase.from('ledger_imports').delete().eq('id', importId);
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeImport() {
    if (!window.confirm('למחוק את הכרטסת שהועלתה?')) return;
    const { error } = await supabase.from('ledger_imports').delete().eq('id', state.imp.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('הכרטסת נמחקה');
    load();
  }

  const { imp, result, loading } = state;
  const differs = result?.matches.filter((m) => m.amountDiffers) || [];

  return (
    <section className="card flush">
      <div className="card-head inv-head">
        <h2>התאמה מול הנהלת חשבונות</h2>
        <div className="card-head-end inv-head-actions">
          {imp && isAdmin && <button type="button" className="btn ghost sm" disabled={busy} onClick={removeImport}><Trash2 aria-hidden="true" />מחיקת כרטסת</button>}
          <button type="button" className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" />{busy ? 'בייבוא…' : 'העלאת כרטסת (Excel)'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importFile} hidden />
      </div>

      {loading && <div className="empty-state">בטעינה…</div>}

      {!loading && !imp && (
        <div className="card-body">
          <p className="inv-empty">
            לא הועלתה כרטסת לחודש הזה. בחשבשבת: כרטסת הנהלת חשבונות לחשבונות ההוצאות, לתקופת החודש, ייצוא ל-Excel.
          </p>
        </div>
      )}

      {!loading && imp && result && (
        <>
          <div className="card-body">
            <p className="inv-meta num">
              כרטסת {dateIL(imp.period_from)} – {dateIL(imp.period_to)} · {imp.line_count} תנועות · {imp.filename}
              {imp.imported_by_name ? ` · הועלתה ע״י ${imp.imported_by_name}` : ''} · {new Date(imp.created_at).toLocaleDateString('he-IL')}
            </p>

            <div className="inv-tags inv-counts">
              <span className="tag ok num">{result.matches.length} הותאמו</span>
              <span className={`tag num${result.notBooked.length ? ' danger' : ''}`}>{result.notBooked.length} לא נקלטו בהנה״ח</span>
              {differs.length > 0 && <span className="tag warn num">{differs.length} בסכום שונה</span>}
              <span className="tag num">{result.noFile.length} נקלטו בלי קובץ במערכת</span>
            </div>

            {result.notBooked.length > 0 && (
              <div className="notice danger inv-notice" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <div>{result.notBooked.length} חשבוניות הועלו למערכת ולא נמצאו בכרטסת. יש לבדוק מול הנהלת החשבונות.</div>
              </div>
            )}
          </div>

          {result.notBooked.length > 0 && (
            <Section title="חשבוניות שלא נקלטו בהנה״ח" count={result.notBooked.length} tone="danger">
              <div className="inv-table-wrap">
                <table className="inv-table">
                  <thead><tr>
                    <th>תאריך</th><th>ספק</th><th>ח.פ</th><th>מס׳ חשבונית</th>
                    <th className="end">לפני מע״מ</th><th className="end">כולל מע״מ</th><th><span className="inv-sr">קובץ</span></th>
                  </tr></thead>
                  <tbody>
                    {result.notBooked.map((i) => (
                      <tr key={i.id}>
                        <td className="num">{dateIL(i.invoice_date)}</td>
                        <td className="inv-strong">{i.supplier_name || '—'}</td>
                        <td className="inv-muted">{i.supplier_tax_id || '—'}</td>
                        <td>{i.invoice_number || '—'}</td>
                        <td className="end amt">{money(i.amount_before_vat)}</td>
                        <td className="end amt">{money(i.total_incl_vat)}</td>
                        <td className="end">
                          <button type="button" className="btn-icon" title="צפייה בקובץ" aria-label="צפייה בקובץ" onClick={() => openFile(i, showToast)}><FileText aria-hidden="true" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {differs.length > 0 && (
            <Section title="הותאמו לפי מספר, אבל הסכום שונה" count={differs.length} tone="warn">
              <div className="inv-table-wrap">
                <table className="inv-table">
                  <thead><tr>
                    <th>ספק</th><th>מס׳ חשבונית</th>
                    <th className="end">בחשבונית לפני מע״מ</th><th className="end">בחשבונית כולל</th><th className="end">בכרטסת</th><th><span className="inv-sr">קובץ</span></th>
                  </tr></thead>
                  <tbody>
                    {differs.map(({ invoice: i, line: l }) => (
                      <tr key={i.id}>
                        <td className="inv-strong">{i.supplier_name}</td>
                        <td>{i.invoice_number}</td>
                        <td className="end amt">{money(i.amount_before_vat)}</td>
                        <td className="end amt">{money(i.total_incl_vat)}</td>
                        <td className="end amt inv-amt-warn">{money(l.amount)}</td>
                        <td className="end">
                          <button type="button" className="btn-icon" title="צפייה בקובץ" aria-label="צפייה בקובץ" onClick={() => openFile(i, showToast)}><FileText aria-hidden="true" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {result.noFile.length > 0 && (
            <Section title="נקלטו בהנה״ח, ואין קובץ במערכת" count={result.noFile.length} open={false}>
              <p className="inv-section-note">חשבוניות שהנהלת החשבונות קיבלה ממקור אחר. כדאי להעלות אותן כדי שהארכיון יהיה שלם.</p>
              <LinesTable lines={result.noFile} />
            </Section>
          )}

          {result.otherLines.length > 0 && (
            <Section title="תנועות בנק, אשראי ואחרות" count={result.otherLines.length} open={false}>
              <p className="inv-section-note">שורות בלי סוג מסמך (נקלטו מהבנק או מכרטיס האשראי). ייבדקו מול דפי הבנק והאשראי בשלב הבא.</p>
              <LinesTable lines={result.otherLines} />
            </Section>
          )}

          {result.reversed.length > 0 && (
            <p className="inv-footnote num">
              {result.reversed.length} שורות הן רישום וביטולו (מתקזזות), ולא נספרו.
            </p>
          )}
        </>
      )}
    </section>
  );
}
