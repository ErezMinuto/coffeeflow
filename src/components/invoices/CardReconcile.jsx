import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Trash2, Upload } from 'lucide-react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import { parseCardStatement, reconcileCard, reconcileCardLedger } from '../../lib/cardStatement';

// ── Credit-card statements (admin + bookkeeper) ─────────────────────────────
// Upload the card's monthly statement (Leumi "פרוט עסקאות לכרטיס", .xls); the
// lines are stored in statement_imports / statement_lines and checked here on
// every view, two ways:
//   • against the bookkeeper's ledgers that cover the purchase dates — was
//     every charge booked?
//   • against supplier_invoices — is there an invoice file for every charge?
// Rules: src/lib/cardStatement.js.

const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dateIL = (d) => (d ? d.split('-').reverse().join('/') : '—');
const shiftDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

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
      let ledger = null;
      if (dates.length) {
        const first = dates[0], last = dates[dates.length - 1];
        const { data, error: iErr } = await supabase.from('supplier_invoices').select('*')
          .gte('invoice_date', shiftDays(first, -10)).lte('invoice_date', shiftDays(last, 7))
          .range(0, 9999);
        if (iErr) throw iErr;
        invoices = data || [];

        // The bookkeeper's ledgers covering these purchases: a September statement
        // holds August purchases too, so it may need two. Newest import per period.
        const { data: limps, error: liErr } = await supabase.from('ledger_imports').select('*')
          .lte('period_from', last).gte('period_to', first).order('created_at', { ascending: false });
        if (liErr) throw liErr;
        const seen = new Set();
        const ledgers = (limps || []).filter((i) => {
          const k = `${i.period_from}|${i.period_to}`;
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
        if (ledgers.length) {
          const { data: ll, error: llErr } = await supabase.from('ledger_lines').select('*')
            .in('import_id', ledgers.map((i) => i.id)).range(0, 19999);
          if (llErr) throw llErr;
          ledger = reconcileCardLedger(rows, (ll || []).map((l) => ({ ...l, amount: Number(l.amount) })),
            ledgers.map((i) => ({ from: i.period_from, to: i.period_to })));
        } else {
          ledger = reconcileCardLedger(rows, [], []);
        }
      }
      setState({ loading: false, imports, result: reconcileCard(invoices, rows), ledger });
    } catch (e) {
      setState({ loading: false, imports: [], result: null });
      showToast(e.message, 'error');
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
          showToast(`כרטיס ${s.card}: יובאו ${s.lines.length} עסקאות`);
        } catch (err) {
          if (importId) await supabase.from('statement_imports').delete().eq('id', importId);
          showToast(`${file.name}: ${err.message}`, 'error');
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
    if (error) { showToast(error.message, 'error'); return; }
    load();
  }

  const { imports, result, loading, ledger } = state;
  const missing = result ? [...result.missing].sort((a, b) => Math.abs(b.txn_amount) - Math.abs(a.txn_amount)) : [];
  const missingSum = missing.reduce((s, l) => s + l.txn_amount, 0);
  const unbooked = ledger ? [...ledger.notBooked].sort((a, b) => Math.abs(b.txn_amount) - Math.abs(a.txn_amount)) : [];
  const unbookedSum = unbooked.reduce((s, l) => s + l.txn_amount, 0);
  const uncheckedMonths = ledger
    ? [...new Set(ledger.outside.map((c) => c.txn_date?.slice(0, 7)).filter(Boolean))].sort()
      .map((ym) => `${ym.slice(5, 7)}/${ym.slice(0, 4)}`)
    : [];

  return (
    <section className="card flush">
      <div className="card-head inv-head">
        <h2>כרטיסי אשראי מול הנהלת חשבונות וחשבוניות</h2>
        <div className="card-head-end inv-head-actions">
          <button type="button" className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" />{busy ? 'בייבוא…' : 'העלאת פירוט כרטיס'}
          </button>
        </div>
        <input ref={fileRef} type="file" multiple accept=".xls,.html,.htm" onChange={importFiles} hidden />
      </div>

      {loading && <div className="empty-state">בטעינה…</div>}

      {!loading && !imports.length && (
        <div className="card-body">
          <p className="inv-empty">
            לא הועלה פירוט כרטיס לחודש החיוב הזה. באתר לאומי: פירוט עסקאות לכרטיס, בחירת החודש, ייצוא לאקסל. אפשר להעלות כמה כרטיסים יחד.
          </p>
        </div>
      )}

      {!loading && imports.length > 0 && result && (
        <>
          <div className="card-body">
            <div className="inv-imports">
              {imports.map((i) => (
                <span key={i.id} className="inv-import num">
                  כרטיס {i.account_label}: {i.line_count} עסקאות{i.total_charged != null ? `, ₪${money(i.total_charged)}` : ''}
                  {isAdmin && (
                    <button type="button" className="btn-icon danger inv-import-del" title="מחיקה" aria-label={`מחיקת פירוט כרטיס ${i.account_label}`} onClick={() => removeImport(i.id, i.account_label)}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  )}
                </span>
              ))}
            </div>

            {/* 1. Was every charge booked by the bookkeeper? */}
            {ledger && (
              <div className="inv-sub">
                <h3>האם כל חיוב נקלט בהנהלת החשבונות?</h3>
                {ledger.booked.length + ledger.notBooked.length > 0 && (
                  <div className="inv-tags inv-counts">
                    <span className="tag ok num">{ledger.booked.length} נקלטו</span>
                    <span className={`tag num${unbooked.length ? ' danger' : ''}`}>
                      {unbooked.length} לא נמצאו בכרטסת{unbooked.length ? ` · ₪${money(unbookedSum)}` : ''}
                    </span>
                  </div>
                )}
                {uncheckedMonths.length > 0 && (
                  <div className="inv-note">
                    <span className="dot warn" aria-hidden="true" />
                    <span>{ledger.outside.length} חיובים מחודשים שלא הועלתה להם כרטסת ({uncheckedMonths.join(', ')}), ולכן לא נבדקו. העלו את הכרטסת של {uncheckedMonths.join(' ושל ')} בחלק ״התאמה מול הנהלת חשבונות״ בחודש המתאים.</span>
                  </div>
                )}
                {unbooked.length > 0 && (
                  <div className="inv-table-wrap inv-sub-table">
                    <table className="inv-table">
                      <thead><tr>
                        <th>תאריך</th><th>בית עסק</th><th>כרטיס</th><th className="end">סכום</th>
                      </tr></thead>
                      <tbody>
                        {unbooked.map((l) => (
                          <tr key={l.id}>
                            <td className="num">{dateIL(l.txn_date)}</td>
                            <td className="inv-strong">{l.merchant}</td>
                            <td className="inv-muted">{l.card}</td>
                            <td className="end amt">{money(l.txn_amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* 2. Is there an invoice file for every charge? */}
            <div className="inv-sub">
              <h3>האם לכל חיוב יש חשבונית במערכת?</h3>
              <div className="inv-tags inv-counts">
                <span className="tag ok num">{result.matches.length} עם חשבונית</span>
                <span className={`tag num${missing.length ? ' danger' : ''}`}>
                  {missing.length} חיובים בלי חשבונית{missing.length ? ` · ₪${money(missingSum)}` : ''}
                </span>
              </div>
            </div>
          </div>

          {missing.length > 0 && (
            <details open className="inv-section">
              <summary>
                <ChevronDown className="inv-chev" size={16} aria-hidden="true" />
                <span className="dot danger" aria-hidden="true" />
                <span>חיובים בכרטיס שאין להם חשבונית במערכת</span>
                <span className="inv-count num">{missing.length}</span>
              </summary>
              <div className="inv-section-body">
                <p className="inv-section-note">מהגדול לקטן. לכל אחד צריך להעלות חשבונית או קבלה.</p>
                <div className="inv-table-wrap">
                  <table className="inv-table">
                    <thead><tr>
                      <th>תאריך</th><th>בית עסק</th><th>כרטיס</th><th>סוג</th><th className="end">סכום העסקה</th>
                    </tr></thead>
                    <tbody>
                      {missing.map((l) => (
                        <tr key={l.id}>
                          <td className="num">{dateIL(l.txn_date)}</td>
                          <td className="inv-strong">{l.merchant}</td>
                          <td className="inv-muted">{l.card}</td>
                          <td className="inv-muted inv-small">{l.details || l.txn_type}</td>
                          <td className="end amt">{money(l.txn_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          )}

          {result.matches.length > 0 && (
            <details className="inv-section">
              <summary>
                <ChevronDown className="inv-chev" size={16} aria-hidden="true" />
                <span className="dot ok" aria-hidden="true" />
                <span>חיובים שנמצאה להם חשבונית</span>
                <span className="inv-count num">{result.matches.length}</span>
              </summary>
              <div className="inv-section-body">
                <div className="inv-table-wrap">
                  <table className="inv-table">
                    <thead><tr>
                      <th>תאריך</th><th>בית עסק</th><th className="end">חיוב</th><th>חשבונית</th><th className="end">סה״כ בחשבונית</th>
                    </tr></thead>
                    <tbody>
                      {result.matches.map(({ line: l, invoice: i }) => (
                        <tr key={l.id}>
                          <td className="num">{dateIL(l.txn_date)}</td>
                          <td>{l.merchant}</td>
                          <td className="end amt">{money(l.txn_amount)}</td>
                          <td>{i.supplier_name} #{i.invoice_number}</td>
                          <td className="end amt">{money(i.total_incl_vat)} {i.currency !== 'ILS' ? i.currency : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
