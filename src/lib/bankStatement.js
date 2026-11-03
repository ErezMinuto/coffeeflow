// Bank-account statements: every payment to a supplier must be booked and
// have an invoice / receipt.
//
// INPUT: Bank Leumi "תנועות עו"ש" exported to Excel — an HTML table saved as
// .xls:
//   "תאריך: 30.09.2026 - 01.09.2026"                         → the period
//   header  סניף | חשבון | תאריך | תיאור תנועה | אסמכתא | בחובה | בזכות | יתרה בש"ח | הערות
//   rows    dd/mm/yyyy, amounts "5,000" / "3,881.7"
//
// A digital transfer (העברה דיגיטל) does NOT name the payee, so payments are
// matched by amount and date. Each debit is first classified; only supplier
// payments are checked. The card settlements are checked against the uploaded
// card statements instead (the card panel checks their charges one by one).

import { findReversals, namesMatch } from './ledgerReconcile';

const clean = (s) => String(s ?? '').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();
const toAmount = (s) => {
  const t = clean(s).replace(/[₪,\s]/g, '');
  if (!t) return 0;
  const n = Number(t.endsWith('-') ? `-${t.slice(0, -1)}` : t);
  return Number.isFinite(n) ? n : 0;
};
const toDate = (s) => {
  const m = clean(s).match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

// Order matters: the first rule that fits wins.
export const CATEGORIES = [
  { key: 'card',   label: 'חיוב כרטיס אשראי',      test: (d) => /ויזה|מאסטרקארד|דיינרס|ישראכרט|אמריקן|אמקס|כאל|מקס/.test(d) },
  { key: 'salary', label: 'משכורות',               test: (d) => /משכורת/.test(d) },
  { key: 'tax',    label: 'מסים וביטוח לאומי',     test: (d) => /ביטוח לאומי|רשויות|מס הכנסה|מע"מ|מעמ/.test(d) },
  { key: 'fee',    label: 'עמלות בנק',             test: (d) => /עמל|^עמ\.|מסלול|דמי ניהול/.test(d) },
];
export function classify(line) {
  if (line.amount <= 0) return 'income';
  return CATEGORIES.find((c) => c.test(line.description || ''))?.key || 'supplier';
}

/** Leumi current-account export (HTML text) → { account, period_from, period_to, lines }. */
export function parseBankStatement(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = Array.from(doc.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td,th')).map((c) => clean(c.textContent)));
  const hIdx = rows.findIndex((r) => r.includes('תיאור תנועה') && r.includes('בחובה'));
  if (hIdx < 0) throw new Error('זה לא נראה כמו דוח תנועות בחשבון של לאומי (לא נמצאה שורת כותרות)');
  const h = rows[hIdx];
  const col = (name) => h.indexOf(name);
  const c = {
    branch: col('סניף'), account: col('חשבון'), date: col('תאריך'), desc: col('תיאור תנועה'),
    ref: col('אסמכתא'), debit: col('בחובה'), credit: col('בזכות'),
  };

  const lines = [];
  let account = null;
  for (const raw of rows.slice(hIdx + 1)) {
    // Rows can carry one cell more or less than the header (a leading
    // selection column); line them up by where the date actually is.
    const at = raw.findIndex((x) => toDate(x));
    if (at < 0) continue;
    const off = at - c.date;
    const r = (i) => (i < 0 ? '' : raw[i + off] ?? '');
    const txn_date = toDate(r(c.date));
    if (!account && c.account >= 0) account = [r(c.branch), r(c.account)].filter(Boolean).join('-');
    const amount = Math.round((toAmount(r(c.debit)) - toAmount(r(c.credit))) * 100) / 100;   // + = money out
    const line = { txn_date, description: r(c.desc) || null, reference: r(c.ref) || null, amount };
    lines.push({ ...line, category: classify(line) });
  }
  if (!lines.length) throw new Error('לא נמצאו תנועות בקובץ');

  const text = clean(doc.body?.textContent);
  const p = text.match(/תאריך:\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*-\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
  const dates = lines.map((l) => l.txn_date).sort();
  let [period_from, period_to] = p ? [toDate(p[1]), toDate(p[2])].sort() : [dates[0], dates[dates.length - 1]];
  return { account: account || 'unknown', period_from, period_to, lines };
}

const VAT = 1.18;
const dayDiff = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;   // signed: a − b
const fits = (x, y) => Math.abs(x - y) <= 1;

// A payment usually settles an invoice booked earlier (up to ~6 weeks); some
// are billed after (the bookkeeper's own fee: paid 11/09, invoice 18/09).
// When the bank names the payee (a direct debit), the name carries the match,
// so the window opens both ways (Tabit: paid 16/09, invoice 30/09).
const BEFORE = 45, AFTER = 10, NAMED = 45;
const inWindow = (docDate, payDate) => {
  const d = dayDiff(payDate, docDate);
  return d >= -AFTER && d <= BEFORE;
};

/**
 * Supplier payments vs the bookkeeper's ledger. A payment fits a ledger line
 * at its full amount (no-VAT: rent, foreign) or before VAT (÷ 1.18).
 * → { booked: [{ payment, line }], notBooked, outside }
 */
export function reconcileBankLedger(payments, ledgerLines, periods) {
  const reversed = findReversals(ledgerLines);
  const used = new Set(reversed);
  // Checkable when a ledger covers the payment date (its invoice may be older,
  // so an unmatched early-month payment may sit in the previous month's ledger).
  const covered = (d) => periods.some((p) => d >= p.from && d <= p.to);
  const checkable = payments.filter((p) => covered(p.txn_date));
  const booked = [];
  const done = new Set();
  const passes = [
    // a named direct debit: the name carries it, the window opens both ways
    (l, p) => Math.abs(dayDiff(p.txn_date, l.doc_date)) <= NAMED && namesMatch(l.details, p.description),
    (l, p) => inWindow(l.doc_date, p.txn_date),
  ];
  for (const pass of passes) {
    for (const p of checkable) {
      if (done.has(p)) continue;
      let best = -1, bestGap = Infinity;
      ledgerLines.forEach((l, i) => {
        if (used.has(i) || !l.doc_date) return;
        if (!(fits(l.amount, p.amount) || fits(l.amount, p.amount / VAT)) || !pass(l, p)) return;
        const gap = Math.abs(dayDiff(p.txn_date, l.doc_date));
        if (gap < bestGap) { best = i; bestGap = gap; }
      });
      if (best < 0) continue;
      used.add(best); done.add(p);
      booked.push({ payment: p, line: ledgerLines[best] });
    }
  }
  return { booked, notBooked: checkable.filter((p) => !done.has(p)), outside: payments.filter((p) => !covered(p.txn_date)) };
}

/**
 * Supplier payments vs uploaded invoices: one invoice whose total equals the
 * payment, or 2–4 invoices of ONE supplier that add up to it (a transfer often
 * settles several). Invoice dated up to 45 days before / 5 after the payment.
 * → { matches: [{ payment, invoices }], missing }
 */
export function reconcileBankInvoices(payments, invoices) {
  const used = new Set();
  const matches = [];
  const total = (i) => Number(i.total_incl_vat);
  const sorted = [...payments].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const done = new Set();

  // 1. single invoice, closest date
  for (const p of sorted) {
    let best = null, bestGap = Infinity;
    for (const inv of invoices) {
      if (used.has(inv.id) || inv.total_incl_vat == null || !inv.invoice_date || !inWindow(inv.invoice_date, p.txn_date)) continue;
      if (!fits(total(inv), p.amount)) continue;
      const gap = Math.abs(dayDiff(p.txn_date, inv.invoice_date));
      if (gap < bestGap) { best = inv; bestGap = gap; }
    }
    if (best) { used.add(best.id); done.add(p); matches.push({ payment: p, invoices: [best] }); }
  }

  // 2. several invoices of one supplier
  for (const p of sorted) {
    if (done.has(p)) continue;
    const bySupplier = new Map();
    for (const inv of invoices) {
      if (used.has(inv.id) || inv.total_incl_vat == null || !inv.invoice_date || !inWindow(inv.invoice_date, p.txn_date)) continue;
      const k = inv.supplier_tax_id || inv.supplier_name;
      if (!k) continue;
      if (!bySupplier.has(k)) bySupplier.set(k, []);
      bySupplier.get(k).push(inv);
    }
    let found = null;
    for (const group of bySupplier.values()) {
      const g = group.slice(0, 12);
      const search = (start, picked, sum) => {
        if (picked.length >= 2 && fits(sum, p.amount)) return picked;
        if (picked.length === 4) return null;
        for (let i = start; i < g.length; i++) {
          const r = search(i + 1, [...picked, g[i]], sum + total(g[i]));
          if (r) return r;
        }
        return null;
      };
      found = search(0, [], 0);
      if (found) break;
    }
    if (found) { found.forEach((i) => used.add(i.id)); done.add(p); matches.push({ payment: p, invoices: found }); }
  }
  return { matches, missing: sorted.filter((p) => !done.has(p)) };
}
