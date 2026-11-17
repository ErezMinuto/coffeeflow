import React, { useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
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
      showToast(`יובאו ${s.lines.length} תנועות`);
      load();
    } catch (err) {
      if (importId) await supabase.from('statement_imports').delete().eq('id', importId);
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeImport() {
    if (!window.confirm('למחוק את דוח הבנק של החודש הזה?')) return;
    const { error } = await supabase.from('statement_imports').delete().eq('id', state.imp.id);
    if (error) { showToast(error.message, 'error'); return; }
    load();
  }

  const s = state;
  const byCat = (key) => (s.lines || []).filter((l) => l.category === key);
  const sum = (ls) => ls.reduce((a, l) => a + l.amount, 0);
  const notBooked = (s.payments || []).filter((p) => s.notBookedIds?.has(p.id));
  const noInvoice = (s.payments || []).filter((p) => !s.invoicesBy?.has(p.id));

  return (
    <section className="card flush">
      <div className="card-head inv-head">
        <h2>חשבון הבנק: תשלומים לספקים</h2>
        <div className="card-head-end inv-head-actions">
          {s.imp && isAdmin && <button type="button" className="btn ghost sm" disabled={busy} onClick={removeImport}><Trash2 aria-hidden="true" />מחיקה</button>}
          <button type="button" className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" />{busy ? 'בייבוא…' : 'העלאת דוח תנועות'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".xls,.html,.htm" onChange={importFile} hidden />
      </div>

      {s.loading && <div className="empty-state">בטעינה…</div>}

      {!s.loading && !s.imp && (
        <div className="card-body">
          <p className="inv-empty">
            לא הועלה דוח בנק לחודש הזה. באתר לאומי: תנועות בחשבון, מה-1 עד סוף החודש, ייצוא לאקסל.
          </p>
        </div>
      )}

      {!s.loading && s.imp && s.lines && (
        <>
          <div className="card-body">
            <p className="inv-meta num">חשבון {s.imp.account_label} · {s.imp.line_count} תנועות · {s.imp.filename}</p>

            <div className="inv-tags inv-counts">
              <span className="tag brand num">{s.payments.length} תשלומים לספקים · ₪{money(sum(s.payments))}</span>
              {CATEGORIES.map((c) => byCat(c.key).length > 0 && (
                <span key={c.key} className="tag num">{c.label}: {byCat(c.key).length} · ₪{money(sum(byCat(c.key)))}</span>
              ))}
              <span className="tag num">זיכויים: {byCat('income').length}</span>
            </div>

            {s.cards.length > 0 && (
              <ul className="inv-card-checks">
                {s.cards.map((c) => (
                  <li key={c.id}>
                    <span className={`dot ${c.statement ? 'ok' : 'warn'}`} aria-hidden="true" />
                    <span className="num">{c.description} {c.reference} · ₪{money(c.amount)} · {dateIL(c.txn_date)}</span>
                    <span className="inv-hint">{c.statement ? 'תואם לפירוט הכרטיס שהועלה' : 'לא הועלה פירוט כרטיס בסכום הזה, ולכן העסקאות שלו לא נבדקו'}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="inv-tags inv-counts">
              {s.ledgersLoaded ? (
                <span className={`tag num ${notBooked.length ? 'danger' : 'ok'}`}>
                  {notBooked.length ? `${notBooked.length} לא נמצאו בכרטסת · ₪${money(sum(notBooked))}` : 'כל התשלומים נמצאו בכרטסת'}
                </span>
              ) : (
                <span className="tag warn">לא הועלתה כרטסת, אין מול מה לבדוק</span>
              )}
              <span className={`tag num ${noInvoice.length ? 'danger' : 'ok'}`}>
                {noInvoice.length ? `${noInvoice.length} בלי חשבונית במערכת · ₪${money(sum(noInvoice))}` : 'לכל התשלומים יש חשבונית'}
              </span>
            </div>
            {s.ledgersLoaded && !s.prevCovered && notBooked.length > 0 && (
              <div className="inv-note">
                <span className="dot warn" aria-hidden="true" />
                <span>תשלום בתחילת החודש משלם לרוב חשבונית מהחודש הקודם. כדי שהבדיקה תהיה מלאה, העלו גם את הכרטסת של {prevMonth(month).split('-').reverse().join('/')}.</span>
              </div>
            )}
          </div>

          {s.payments.length > 0 && (
            <div className="inv-table-wrap inv-table-top">
              <table className="inv-table inv-table-bank">
                <thead><tr>
                  <th>תאריך</th><th>תיאור</th><th>אסמכתא</th><th className="end">סכום</th>
                  <th>בכרטסת</th><th>חשבונית במערכת</th>
                </tr></thead>
                <tbody>
                  {s.payments.map((p) => {
                    const line = s.bookedBy.get(p.id);
                    const invs = s.invoicesBy.get(p.id);
                    return (
                      <tr key={p.id} className={(!line && s.notBookedIds.has(p.id)) || !invs ? 'is-flagged' : undefined}>
                        <td className="num">{dateIL(p.txn_date)}</td>
                        <td className="inv-strong">{p.description}</td>
                        <td className="inv-muted">{p.reference}</td>
                        <td className="end amt">{money(p.amount)}</td>
                        <td>
                          {line ? <span className="inv-status"><span className="dot ok" aria-hidden="true" /><span className="inv-hint num">{line.details} · {dateIL(line.doc_date)} · ₪{money(line.amount)}</span></span>
                            : s.notBookedIds.has(p.id) ? <span className="inv-status is-danger"><span className="dot danger" aria-hidden="true" />לא נמצא</span>
                            : <span className="inv-status"><span className="dot" aria-hidden="true" /><span className="inv-hint">לא נבדק</span></span>}
                        </td>
                        <td>
                          {invs ? <span className="inv-status"><span className="dot ok" aria-hidden="true" /><span className="inv-hint">{invs.map((i) => `${i.supplier_name || ''} #${i.invoice_number || ''}`).join(', ')}</span></span>
                            : <span className="inv-status is-danger"><span className="dot danger" aria-hidden="true" />אין</span>}
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
    </section>
  );
}
