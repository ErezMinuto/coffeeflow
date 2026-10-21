import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import { parseCardStatement, reconcileCard } from '../../lib/cardStatement';

// ── Credit-card statements: every charge needs an invoice (admin + bookkeeper)
// Upload the card's monthly statement (Leumi "פרוט עסקאות לכרטיס", .xls); the
// lines are stored in statement_imports / statement_lines and matched against
// supplier_invoices here on every view. Rules: src/lib/cardStatement.js.

const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dateIL = (d) => (d ? d.split('-').reverse().join('/') : '—');
const shiftDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

const card = { background: 'white', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '1000px', margin: '1.25rem auto' };
const btn = (bg, disabled) => ({ padding: '0.6rem 1rem', fontSize: '0.92rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer' });
const chip = (bg, color) => ({ background: bg, color, borderRadius: '999px', padding: '4px 12px', fontSize: '0.85rem', fontWeight: 700, whiteSpace: 'nowrap' });
const th = { textAlign: 'right', padding: '0.4rem 0.55rem', borderBottom: '2px solid #E5E7EB', fontSize: '0.8rem', color: '#374151', whiteSpace: 'nowrap' };
const td = { padding: '0.4rem 0.55rem', borderBottom: '1px solid #F3F4F6', fontSize: '0.86rem' };
const num = { ...td, textAlign: 'left', direction: 'ltr' };

export default function CardReconcile({ month }) {
  const { showToast, isAdmin, user } = useApp();
  const fileRef = useRef(null);
  const [state, setState] = useState({ loading: true, imports: [], result: null });
  const [busy, setBusy] = useState(false);

  async function load() {
    setState((s) => ({ ...s, loading: true }));
    try {
      const { data: imports, error } = await supabase.from('statement_imports').select('*')
        .eq('kind', 'card').eq('period_month', `${month}-01`).order('account_label');
      if (error) throw error;
      if (!imports?.length) { setState({ loading: false, imports: [], result: null }); return; }

      const { data: lines, error: lErr } = await supabase.from('statement_lines').select('*')
        .in('import_id', imports.map((i) => i.id)).order('txn_date').range(0, 9999);
      if (lErr) throw lErr;
      const label = Object.fromEntries(imports.map((i) => [i.id, i.account_label]));
      const rows = (lines || []).map((l) => ({
        ...l, card: label[l.import_id], txn_amount: Number(l.txn_amount),
        charge_amount: l.charge_amount == null ? null : Number(l.charge_amount),
      }));
      const dates = rows.map((l) => l.txn_date).filter(Boolean).sort();
      let invoices = [];
      if (dates.length) {
        const { data, error: iErr } = await supabase.from('supplier_invoices').select('*')
          .gte('invoice_date', shiftDays(dates[0], -10)).lte('invoice_date', shiftDays(dates[dates.length - 1], 7))
          .range(0, 9999);
        if (iErr) throw iErr;
        invoices = data || [];
      }
      setState({ loading: false, imports, result: reconcileCard(invoices, rows) });
    } catch (e) {
      setState({ loading: false, imports: [], result: null });
      showToast(`❌ ${e.message}`, 'error');
    }
  }

  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  async function importFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) {
        let importId = null;
        try {
          const s = parseCardStatement(await file.text());
          const { data: same, error: sErr } = await supabase.from('statement_imports').select('id')
            .eq('kind', 'card').eq('account_label', s.card).eq('period_month', s.period_month);
          if (sErr) throw sErr;
          const msg = `כרטיס ${s.card}, חודש חיוב ${s.period_month.slice(5, 7)}/${s.period_month.slice(0, 4)}: ${s.lines.length} עסקאות`
            + (s.total_charged != null ? `, סה״כ חיוב ₪${money(s.total_charged)}` : '')
            + (same?.length ? '.\nכבר הועלה פירוט לכרטיס ולחודש הזה, והוא יוחלף.' : '.') + '\n\nלייבא?';
          if (!window.confirm(msg)) continue;

          const { data: imp, error: impErr } = await supabase.from('statement_imports').insert({
            kind: 'card', account_label: s.card, period_month: s.period_month, filename: file.name.slice(0, 200),
            line_count: s.lines.length, total_charged: s.total_charged,
            imported_by_name: user?.fullName || user?.primaryEmailAddress?.emailAddress || null,
          }).select('id').single();
          if (impErr) throw impErr;
          importId = imp.id;
          const { error: lErr } = await supabase.from('statement_lines').insert(s.lines.map((l) => ({ ...l, import_id: imp.id })));
          if (lErr) throw lErr;
          if (same?.length) {
            const { error } = await supabase.from('statement_imports').delete().in('id', same.map((x) => x.id));
            if (error) throw error;
          }
          importId = null;
          showToast(`✅ כרטיס ${s.card}: יובאו ${s.lines.length} עסקאות`);
        } catch (err) {
          if (importId) await supabase.from('statement_imports').delete().eq('id', importId);
          showToast(`❌ ${file.name}: ${err.message}`, 'error');
        }
      }
    } finally {
      setBusy(false);
      load();
    }
  }

  async function removeImport(id, label) {
    if (!window.confirm(`למחוק את פירוט כרטיס ${label} לחודש הזה?`)) return;
    const { error } = await supabase.from('statement_imports').delete().eq('id', id);
    if (error) { showToast(`❌ ${error.message}`, 'error'); return; }
    load();
  }

  const { imports, result, loading } = state;
  const missing = result ? [...result.missing].sort((a, b) => Math.abs(b.txn_amount) - Math.abs(a.txn_amount)) : [];
  const missingSum = missing.reduce((s, l) => s + l.txn_amount, 0);

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>💳 כרטיסי אשראי מול חשבוניות</h3>
        <button style={btn('#3D4A2E', busy)} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'מייבא…' : '⬆️ העלאת פירוט כרטיס'}
        </button>
        <input ref={fileRef} type="file" multiple accept=".xls,.html,.htm" onChange={importFiles} style={{ display: 'none' }} />
      </div>

      {loading && <p style={{ color: '#6B7280' }}>טוען…</p>}

      {!loading && !imports.length && (
        <p style={{ color: '#6B7280', fontSize: '0.9rem', marginBottom: 0 }}>
          לא הועלה פירוט כרטיס לחודש החיוב הזה. באתר לאומי: פירוט עסקאות לכרטיס, בחירת החודש, ייצוא לאקסל. אפשר להעלות כמה כרטיסים יחד.
        </p>
      )}

      {!loading && imports.length > 0 && result && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.6rem', fontSize: '0.82rem', color: '#6B7280' }}>
            {imports.map((i) => (
              <span key={i.id}>
                כרטיס {i.account_label}: {i.line_count} עסקאות{i.total_charged != null ? `, ₪${money(i.total_charged)}` : ''}
                {isAdmin && <button title="מחיקה" onClick={() => removeImport(i.id, i.account_label)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}>🗑️</button>}
              </span>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            <span style={chip('#DCFCE7', '#166534')}>✅ {result.matches.length} עם חשבונית</span>
            <span style={chip(missing.length ? '#FEE2E2' : '#F3F4F6', missing.length ? '#991B1B' : '#6B7280')}>
              ❌ {missing.length} חיובים בלי חשבונית{missing.length ? ` · ₪${money(missingSum)}` : ''}
            </span>
          </div>

          {missing.length > 0 && (
            <details open style={{ marginTop: '1rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, color: '#991B1B', fontSize: '0.95rem' }}>❌ חיובים בכרטיס שאין להם חשבונית במערכת ({missing.length})</summary>
              <p style={{ fontSize: '0.82rem', color: '#6B7280', margin: '0.4rem 0' }}>מהגדול לקטן. לכל אחד צריך להעלות חשבונית או קבלה.</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '600px' }}>
                  <thead><tr>
                    <th style={th}>תאריך</th><th style={th}>בית עסק</th><th style={th}>כרטיס</th><th style={th}>סוג</th><th style={{ ...th, textAlign: 'left' }}>סכום העסקה</th>
                  </tr></thead>
                  <tbody>
                    {missing.map((l) => (
                      <tr key={l.id}>
                        <td style={td}>{dateIL(l.txn_date)}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{l.merchant}</td>
                        <td style={{ ...td, color: '#6B7280' }}>{l.card}</td>
                        <td style={{ ...td, color: '#6B7280', fontSize: '0.8rem' }}>{l.details || l.txn_type}</td>
                        <td style={num}>{money(l.txn_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {result.matches.length > 0 && (
            <details style={{ marginTop: '1rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, color: '#166534', fontSize: '0.95rem' }}>✅ חיובים שנמצאה להם חשבונית ({result.matches.length})</summary>
              <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '600px' }}>
                  <thead><tr>
                    <th style={th}>תאריך</th><th style={th}>בית עסק</th><th style={{ ...th, textAlign: 'left' }}>חיוב</th><th style={th}>חשבונית</th><th style={{ ...th, textAlign: 'left' }}>סה״כ בחשבונית</th>
                  </tr></thead>
                  <tbody>
                    {result.matches.map(({ line: l, invoice: i }) => (
                      <tr key={l.id}>
                        <td style={td}>{dateIL(l.txn_date)}</td>
                        <td style={td}>{l.merchant}</td>
                        <td style={num}>{money(l.txn_amount)}</td>
                        <td style={td}>{i.supplier_name} #{i.invoice_number}</td>
                        <td style={num}>{money(i.total_incl_vat)} {i.currency !== 'ILS' ? i.currency : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
