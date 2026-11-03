import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import { parseBankStatement, reconcileBankLedger, reconcileBankInvoices, CATEGORIES } from '../../lib/bankStatement';

// ── Bank-account statements (admin + bookkeeper) ────────────────────────────
// Upload the account's movements (Leumi "תנועות עו"ש", .xls). Lines go to
// statement_imports / statement_lines (kind 'bank'; category in txn_type,
// reference in details). On every view:
//   • card settlements are checked against the uploaded card statements' totals
//   • every supplier payment is checked against the bookkeeper's ledgers
//     (booked?) and against supplier_invoices (invoice / receipt in the system?)
// Rules: src/lib/bankStatement.js.

const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dateIL = (d) => (d ? d.split('-').reverse().join('/') : '—');
const shiftDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const prevMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

const card = { background: 'white', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '1000px', margin: '1.25rem auto' };
const btn = (bg, disabled) => ({ padding: '0.6rem 1rem', fontSize: '0.92rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer' });
const chip = (bg, color) => ({ background: bg, color, borderRadius: '999px', padding: '4px 12px', fontSize: '0.85rem', fontWeight: 700, whiteSpace: 'nowrap' });
const th = { textAlign: 'right', padding: '0.4rem 0.55rem', borderBottom: '2px solid #E5E7EB', fontSize: '0.8rem', color: '#374151', whiteSpace: 'nowrap' };
const td = { padding: '0.4rem 0.55rem', borderBottom: '1px solid #F3F4F6', fontSize: '0.86rem', verticalAlign: 'top' };
const num = { ...td, textAlign: 'left', direction: 'ltr' };
const small = { fontSize: '0.78rem', color: '#6B7280' };

export default function BankReconcile({ month }) {
  const { showToast, isAdmin, user } = useApp();
  const fileRef = useRef(null);
  const [state, setState] = useState({ loading: true, imp: null });
  const [busy, setBusy] = useState(false);

  async function load() {
    setState((s) => ({ ...s, loading: true }));
    try {
      const { data: imps, error } = await supabase.from('statement_imports').select('*')
        .eq('kind', 'bank').eq('period_month', `${month}-01`).order('created_at', { ascending: false }).limit(1);
      if (error) throw error;
      const imp = imps?.[0];
      if (!imp) { setState({ loading: false, imp: null }); return; }

      const { data: raw, error: lErr } = await supabase.from('statement_lines').select('*')
        .eq('import_id', imp.id).order('txn_date', { ascending: false }).range(0, 9999);
      if (lErr) throw lErr;
      const lines = (raw || []).map((l) => ({
        id: l.id, txn_date: l.txn_date, description: l.merchant, reference: l.details,
        amount: Number(l.txn_amount), category: l.txn_type,
      }));
      const payments = lines.filter((l) => l.category === 'supplier');
      const dates = lines.map((l) => l.txn_date).sort();
      const first = dates[0], last = dates[dates.length - 1];

      // Ledgers: a payment usually settles an invoice from earlier, so look back 45 days.
      const { data: limps, error: liErr } = await supabase.from('ledger_imports').select('*')
        .lte('period_from', last).gte('period_to', shiftDays(first, -45)).order('created_at', { ascending: false });
      if (liErr) throw liErr;
      const seen = new Set();
      const ledgers = (limps || []).filter((i) => { const k = `${i.period_from}|${i.period_to}`; if (seen.has(k)) return false; seen.add(k); return true; });
      let ledgerLines = [];
      if (ledgers.length) {
        const { data: ll, error: llErr } = await supabase.from('ledger_lines').select('*')
          .in('import_id', ledgers.map((i) => i.id)).range(0, 29999);
        if (llErr) throw llErr;
        ledgerLines = (ll || []).map((l) => ({ ...l, amount: Number(l.amount) }));
      }
      const periods = ledgers.map((i) => ({ from: i.period_from, to: i.period_to }));
      const ledger = reconcileBankLedger(payments, ledgerLines, periods);
      const prevCovered = periods.some((p) => p.from.slice(0, 7) <= prevMonth(month) && p.to.slice(0, 7) >= prevMonth(month));

      const { data: invoices, error: iErr } = await supabase.from('supplier_invoices').select('*')
        .gte('invoice_date', shiftDays(first, -45)).lte('invoice_date', shiftDays(last, 10)).range(0, 9999);
      if (iErr) throw iErr;
      const inv = reconcileBankInvoices(payments, invoices || []);

      // Card settlements vs the uploaded card statements (any billing month).
      const cardLines = lines.filter((l) => l.category === 'card');
      let cardStatements = [];
      if (cardLines.length) {
        const { data: cs, error: csErr } = await supabase.from('statement_imports').select('account_label,period_month,total_charged')
          .eq('kind', 'card').in('account_label', [...new Set(cardLines.map((l) => l.reference).filter(Boolean))]);
        if (csErr) throw csErr;
        cardStatements = cs || [];
      }

      const bookedBy = new Map(ledger.booked.map((m) => [m.payment.id, m.line]));
      const invoicesBy = new Map(inv.matches.map((m) => [m.payment.id, m.invoices]));
      setState({
        loading: false, imp, lines, payments, ledgersLoaded: ledgers.length > 0, prevCovered,
        bookedBy, invoicesBy, notBookedIds: new Set(ledger.notBooked.map((p) => p.id)),
        cards: cardLines.map((l) => ({
          ...l,
          statement: cardStatements.find((s) => s.account_label === l.reference && s.total_charged != null && Math.abs(Number(s.total_charged) - l.amount) <= 1),
        })),
      });
    } catch (e) {
      setState({ loading: false, imp: null });
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
      const s = parseBankStatement(await file.text());
      const period_month = `${s.period_from.slice(0, 7)}-01`;
      if (s.period_from.slice(0, 7) !== s.period_to.slice(0, 7)) {
        throw new Error('הדוח חוצה חודשים. נא לייצא חודש אחד בכל פעם (מה-1 עד סוף החודש)');
      }
      const { data: same, error: sErr } = await supabase.from('statement_imports').select('id')
        .eq('kind', 'bank').eq('account_label', s.account).eq('period_month', period_month);
      if (sErr) throw sErr;
      const sup = s.lines.filter((l) => l.category === 'supplier');
      const msg = `חשבון ${s.account}, ${dateIL(s.period_from)} – ${dateIL(s.period_to)}: ${s.lines.length} תנועות, מהן ${sup.length} תשלומים לספקים.`
        + (same?.length ? '\nכבר הועלה דוח לחשבון ולחודש הזה, והוא יוחלף.' : '') + '\n\nלייבא?';
      if (!window.confirm(msg)) return;

      const { data: imp, error: impErr } = await supabase.from('statement_imports').insert({
        kind: 'bank', account_label: s.account, period_month, filename: file.name.slice(0, 200), line_count: s.lines.length,
        imported_by_name: user?.fullName || user?.primaryEmailAddress?.emailAddress || null,
      }).select('id').single();
      if (impErr) throw impErr;
      importId = imp.id;
      const { error: lErr } = await supabase.from('statement_lines').insert(s.lines.map((l) => ({
        import_id: imp.id, txn_date: l.txn_date, merchant: l.description, txn_amount: l.amount,
        txn_type: l.category, details: l.reference,
      })));
      if (lErr) throw lErr;
      if (same?.length) {
        const { error } = await supabase.from('statement_imports').delete().in('id', same.map((x) => x.id));
        if (error) throw error;
      }
      importId = null;
      showToast(`✅ יובאו ${s.lines.length} תנועות`);
      load();
    } catch (err) {
      if (importId) await supabase.from('statement_imports').delete().eq('id', importId);
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeImport() {
    if (!window.confirm('למחוק את דוח הבנק של החודש הזה?')) return;
    const { error } = await supabase.from('statement_imports').delete().eq('id', state.imp.id);
    if (error) { showToast(`❌ ${error.message}`, 'error'); return; }
    load();
  }

  const s = state;
  const byCat = (key) => (s.lines || []).filter((l) => l.category === key);
  const sum = (ls) => ls.reduce((a, l) => a + l.amount, 0);
  const notBooked = (s.payments || []).filter((p) => s.notBookedIds?.has(p.id));
  const noInvoice = (s.payments || []).filter((p) => !s.invoicesBy?.has(p.id));

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>🏦 חשבון הבנק: תשלומים לספקים</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={btn('#3D4A2E', busy)} disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'מייבא…' : '⬆️ העלאת דוח תנועות'}</button>
          {s.imp && isAdmin && <button style={btn('#9CA3AF', busy)} disabled={busy} onClick={removeImport}>מחיקה</button>}
        </div>
        <input ref={fileRef} type="file" accept=".xls,.html,.htm" onChange={importFile} style={{ display: 'none' }} />
      </div>

      {s.loading && <p style={{ color: '#6B7280' }}>טוען…</p>}

      {!s.loading && !s.imp && (
        <p style={{ color: '#6B7280', fontSize: '0.9rem', marginBottom: 0 }}>
          לא הועלה דוח בנק לחודש הזה. באתר לאומי: תנועות בחשבון, מה-1 עד סוף החודש, ייצוא לאקסל.
        </p>
      )}

      {!s.loading && s.imp && s.lines && (
        <>
          <p style={{ ...small, margin: '0.5rem 0 0' }}>חשבון {s.imp.account_label} · {s.imp.line_count} תנועות · {s.imp.filename}</p>

          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
            <span style={chip('#EFF6FF', '#1E40AF')}>💸 {s.payments.length} תשלומים לספקים · ₪{money(sum(s.payments))}</span>
            {CATEGORIES.map((c) => byCat(c.key).length > 0 && (
              <span key={c.key} style={chip('#F3F4F6', '#4B5563')}>{c.label}: {byCat(c.key).length} · ₪{money(sum(byCat(c.key)))}</span>
            ))}
            <span style={chip('#F3F4F6', '#4B5563')}>זיכויים: {byCat('income').length}</span>
          </div>

          {s.cards.length > 0 && (
            <div style={{ marginTop: '0.7rem', fontSize: '0.86rem' }}>
              {s.cards.map((c) => (
                <div key={c.id}>
                  {c.statement ? '✅' : '⚠️'} {c.description} {c.reference} · ₪{money(c.amount)} · {dateIL(c.txn_date)}
                  <span style={small}> {c.statement ? `· תואם לפירוט הכרטיס שהועלה` : '· לא הועלה פירוט כרטיס בסכום הזה, ולכן העסקאות שלו לא נבדקו'}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
            {s.ledgersLoaded ? (
              <span style={chip(notBooked.length ? '#FEE2E2' : '#DCFCE7', notBooked.length ? '#991B1B' : '#166534')}>
                📒 {notBooked.length ? `${notBooked.length} לא נמצאו בכרטסת · ₪${money(sum(notBooked))}` : 'כל התשלומים נמצאו בכרטסת'}
              </span>
            ) : (
              <span style={chip('#FEF3C7', '#92400E')}>📒 לא הועלתה כרטסת, אין מול מה לבדוק</span>
            )}
            <span style={chip(noInvoice.length ? '#FEE2E2' : '#DCFCE7', noInvoice.length ? '#991B1B' : '#166534')}>
              🧾 {noInvoice.length ? `${noInvoice.length} בלי חשבונית במערכת · ₪${money(sum(noInvoice))}` : 'לכל התשלומים יש חשבונית'}
            </span>
          </div>
          {s.ledgersLoaded && !s.prevCovered && notBooked.length > 0 && (
            <p style={{ fontSize: '0.82rem', color: '#92400E', margin: '0.5rem 0 0' }}>
              תשלום בתחילת החודש משלם לרוב חשבונית מהחודש הקודם. כדי שהבדיקה תהיה מלאה, העלו גם את הכרטסת של {prevMonth(month).split('-').reverse().join('/')}.
            </p>
          )}

          {s.payments.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '720px' }}>
                <thead><tr>
                  <th style={th}>תאריך</th><th style={th}>תיאור</th><th style={th}>אסמכתא</th><th style={{ ...th, textAlign: 'left' }}>סכום</th>
                  <th style={th}>📒 בכרטסת</th><th style={th}>🧾 חשבונית במערכת</th>
                </tr></thead>
                <tbody>
                  {s.payments.map((p) => {
                    const line = s.bookedBy.get(p.id);
                    const invs = s.invoicesBy.get(p.id);
                    return (
                      <tr key={p.id} style={{ background: (!line && s.notBookedIds.has(p.id)) || !invs ? '#FFFBFB' : undefined }}>
                        <td style={td}>{dateIL(p.txn_date)}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{p.description}</td>
                        <td style={{ ...td, color: '#6B7280' }}>{p.reference}</td>
                        <td style={num}>{money(p.amount)}</td>
                        <td style={td}>
                          {line ? <>✅ <span style={small}>{line.details} · {dateIL(line.doc_date)} · ₪{money(line.amount)}</span></>
                            : s.notBookedIds.has(p.id) ? <span style={{ color: '#991B1B', fontWeight: 600 }}>❌ לא נמצא</span>
                            : <span style={small}>לא נבדק</span>}
                        </td>
                        <td style={td}>
                          {invs ? <>✅ <span style={small}>{invs.map((i) => `${i.supplier_name || ''} #${i.invoice_number || ''}`).join(', ')}</span></>
                            : <span style={{ color: '#991B1B', fontWeight: 600 }}>❌ אין</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
