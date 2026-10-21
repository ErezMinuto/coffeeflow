import React, { useEffect, useRef, useState } from 'react';
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

const card = { background: 'white', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '1000px', margin: '1.25rem auto' };
const btn = (bg, disabled) => ({ padding: '0.6rem 1rem', fontSize: '0.92rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer' });
const chip = (bg, color) => ({ background: bg, color, borderRadius: '999px', padding: '4px 12px', fontSize: '0.85rem', fontWeight: 700, whiteSpace: 'nowrap' });
const th = { textAlign: 'right', padding: '0.4rem 0.55rem', borderBottom: '2px solid #E5E7EB', fontSize: '0.8rem', color: '#374151', whiteSpace: 'nowrap' };
const td = { padding: '0.4rem 0.55rem', borderBottom: '1px solid #F3F4F6', fontSize: '0.86rem' };
const num = { ...td, textAlign: 'left', direction: 'ltr' };

async function openFile(inv, showToast) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(inv.file_path, 300);
  if (error) { showToast(`❌ ${error.message}`, 'error'); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

function Section({ title, color, children, open = true }) {
  return (
    <details open={open} style={{ marginTop: '1rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700, color, fontSize: '0.95rem' }}>{title}</summary>
      <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>{children}</div>
    </details>
  );
}

function LinesTable({ lines }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }}>
      <thead><tr>
        <th style={th}>תאריך</th><th style={th}>פרטים</th><th style={th}>אסמכתא</th><th style={th}>ח-ן נגדי</th><th style={th}>חשבון</th><th style={{ ...th, textAlign: 'left' }}>סכום</th>
      </tr></thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id ?? l.movement_id}>
            <td style={td}>{dateIL(l.doc_date)}</td>
            <td style={{ ...td, fontWeight: 600 }}>{l.details}</td>
            <td style={td}>{l.ref2 || '—'}</td>
            <td style={{ ...td, color: '#6B7280' }}>{l.counter_account}</td>
            <td style={{ ...td, color: '#6B7280' }}>{l.account_name}</td>
            <td style={num}>{money(l.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
      showToast(`❌ ${e.message}`, 'error');
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
      showToast(`✅ יובאו ${parsed.lines.length} תנועות`);
      load();
    } catch (err) {
      if (importId) await supabase.from('ledger_imports').delete().eq('id', importId);
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeImport() {
    if (!window.confirm('למחוק את הכרטסת שהועלתה?')) return;
    const { error } = await supabase.from('ledger_imports').delete().eq('id', state.imp.id);
    if (error) { showToast(`❌ ${error.message}`, 'error'); return; }
    showToast('🗑️ הכרטסת נמחקה');
    load();
  }

  const { imp, result, loading } = state;
  const differs = result?.matches.filter((m) => m.amountDiffers) || [];

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>📒 התאמה מול הנהלת חשבונות</h3>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button style={btn('#3D4A2E', busy)} disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'מייבא…' : '⬆️ העלאת כרטסת (Excel)'}
          </button>
          {imp && isAdmin && <button style={btn('#9CA3AF', busy)} disabled={busy} onClick={removeImport}>מחיקת כרטסת</button>}
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importFile} style={{ display: 'none' }} />
      </div>

      {loading && <p style={{ color: '#6B7280' }}>טוען…</p>}

      {!loading && !imp && (
        <p style={{ color: '#6B7280', fontSize: '0.9rem', marginBottom: 0 }}>
          לא הועלתה כרטסת לחודש הזה. בחשבשבת: כרטסת הנהלת חשבונות לחשבונות ההוצאות, לתקופת החודש, ייצוא ל-Excel.
        </p>
      )}

      {!loading && imp && result && (
        <>
          <p style={{ color: '#6B7280', fontSize: '0.82rem', margin: '0.5rem 0 0' }}>
            כרטסת {dateIL(imp.period_from)} – {dateIL(imp.period_to)} · {imp.line_count} תנועות · {imp.filename}
            {imp.imported_by_name ? ` · הועלתה ע״י ${imp.imported_by_name}` : ''} · {new Date(imp.created_at).toLocaleDateString('he-IL')}
          </p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            <span style={chip('#DCFCE7', '#166534')}>✅ {result.matches.length} הותאמו</span>
            <span style={chip(result.notBooked.length ? '#FEE2E2' : '#F3F4F6', result.notBooked.length ? '#991B1B' : '#6B7280')}>❌ {result.notBooked.length} לא נקלטו בהנה״ח</span>
            {differs.length > 0 && <span style={chip('#FEF3C7', '#92400E')}>⚠️ {differs.length} בסכום שונה</span>}
            <span style={chip('#EFF6FF', '#1E40AF')}>📄 {result.noFile.length} נקלטו בלי קובץ במערכת</span>
          </div>

          {result.notBooked.length > 0 && (
            <div style={{ background: '#FEE2E2', color: '#991B1B', padding: '0.7rem 0.9rem', borderRadius: '8px', fontSize: '0.9rem', marginTop: '0.9rem', fontWeight: 600 }}>
              {result.notBooked.length} חשבוניות הועלו למערכת ולא נמצאו בכרטסת. יש לבדוק מול הנהלת החשבונות.
            </div>
          )}

          {result.notBooked.length > 0 && (
            <Section title={`❌ חשבוניות שלא נקלטו בהנה״ח (${result.notBooked.length})`} color="#991B1B">
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }}>
                <thead><tr>
                  <th style={th}>תאריך</th><th style={th}>ספק</th><th style={th}>ח.פ</th><th style={th}>מס׳ חשבונית</th>
                  <th style={{ ...th, textAlign: 'left' }}>לפני מע״מ</th><th style={{ ...th, textAlign: 'left' }}>כולל מע״מ</th><th style={th}></th>
                </tr></thead>
                <tbody>
                  {result.notBooked.map((i) => (
                    <tr key={i.id}>
                      <td style={td}>{dateIL(i.invoice_date)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{i.supplier_name || '—'}</td>
                      <td style={{ ...td, color: '#6B7280' }}>{i.supplier_tax_id || '—'}</td>
                      <td style={td}>{i.invoice_number || '—'}</td>
                      <td style={num}>{money(i.amount_before_vat)}</td>
                      <td style={num}>{money(i.total_incl_vat)}</td>
                      <td style={td}><button title="צפייה בקובץ" onClick={() => openFile(i, showToast)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>📄</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {differs.length > 0 && (
            <Section title={`⚠️ הותאמו לפי מספר, אבל הסכום שונה (${differs.length})`} color="#92400E">
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }}>
                <thead><tr>
                  <th style={th}>ספק</th><th style={th}>מס׳ חשבונית</th>
                  <th style={{ ...th, textAlign: 'left' }}>בחשבונית לפני מע״מ</th><th style={{ ...th, textAlign: 'left' }}>בחשבונית כולל</th><th style={{ ...th, textAlign: 'left' }}>בכרטסת</th><th style={th}></th>
                </tr></thead>
                <tbody>
                  {differs.map(({ invoice: i, line: l }) => (
                    <tr key={i.id}>
                      <td style={{ ...td, fontWeight: 600 }}>{i.supplier_name}</td>
                      <td style={td}>{i.invoice_number}</td>
                      <td style={num}>{money(i.amount_before_vat)}</td>
                      <td style={num}>{money(i.total_incl_vat)}</td>
                      <td style={{ ...num, color: '#92400E', fontWeight: 700 }}>{money(l.amount)}</td>
                      <td style={td}><button title="צפייה בקובץ" onClick={() => openFile(i, showToast)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>📄</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {result.noFile.length > 0 && (
            <Section title={`📄 נקלטו בהנה״ח, ואין קובץ במערכת (${result.noFile.length})`} color="#1E40AF" open={false}>
              <p style={{ fontSize: '0.82rem', color: '#6B7280', margin: '0 0 0.4rem' }}>חשבוניות שהנהלת החשבונות קיבלה ממקור אחר. כדאי להעלות אותן כדי שהארכיון יהיה שלם.</p>
              <LinesTable lines={result.noFile} />
            </Section>
          )}

          {result.otherLines.length > 0 && (
            <Section title={`🏦 תנועות בנק / אשראי ואחרות (${result.otherLines.length})`} color="#6B7280" open={false}>
              <p style={{ fontSize: '0.82rem', color: '#6B7280', margin: '0 0 0.4rem' }}>שורות בלי סוג מסמך (נקלטו מהבנק או מכרטיס האשראי). ייבדקו מול דפי הבנק והאשראי בשלב הבא.</p>
              <LinesTable lines={result.otherLines} />
            </Section>
          )}

          {result.reversed.length > 0 && (
            <p style={{ fontSize: '0.8rem', color: '#9CA3AF', marginBottom: 0 }}>
              {result.reversed.length} שורות הן רישום וביטולו (מתקזזות), ולא נספרו.
            </p>
          )}
        </>
      )}
    </div>
  );
}
