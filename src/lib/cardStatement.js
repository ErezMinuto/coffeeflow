// Credit-card statements vs supplier invoices: every charge needs an invoice.
//
// INPUT: Bank Leumi "פרוט עסקאות לכרטיס" exported to Excel. The .xls is an
// HTML page, not a spreadsheet:
//   title   "פרוט עסקאות לכרטיס לאומי ויזה 8177 לתקופה: ספטמבר 2026"
//   table   "עסקאות בש"ח במועד החיוב", header row
//           תאריך העסקה | שם בית העסק | סכום העסקה | סוג העסקה | פרטים | סכום חיוב
//           (dd/mm/yy; amounts "2,340.63"; a total row "סה"כ:")
// A statement for billing month M holds purchases from ~mid M-1 to early M.
//
// MATCHING (a charge is the full payment, so against the invoice TOTAL):
//   1. amount  — |total − purchase| ≤ ₪1 and dates ≤ 7 days apart; the
//      purchase amount, not this month's installment
//   2. foreign — the card bills in ₪, so a USD/EUR invoice can only match by
//      supplier name and date (≤ 3 days)
// Each invoice and each charge is used once; closest date wins, a name match
// breaks ties.

import { namesMatch, findReversals } from './ledgerReconcile';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const clean = (s) => String(s ?? '').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();

export function toAmount(s) {
  let t = clean(s).replace(/[₪,\s]/g, '');
  if (!t) return null;
  let sign = 1;
  if (t.endsWith('-')) { sign = -1; t = t.slice(0, -1); }
  if (t.startsWith('-')) { sign = -1; t = t.slice(1); }
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(sign * n * 100) / 100 : null;
}

export function toDate(s) {
  const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Leumi card statement (HTML text) → { card, period_month, lines, total_charged }. */
export function parseCardStatement(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const text = clean(doc.body?.textContent);
  const title = text.match(/לכרטיס[^0-9]*?(\d{4})\s*לתקופה:\s*(\S+)\s+(\d{4})/);
  if (!title) throw new Error('זה לא נראה כמו פירוט עסקאות כרטיס אשראי של לאומי (לא נמצא מספר כרטיס ותקופה)');
  const monthIdx = MONTHS.indexOf(title[2]);
  if (monthIdx < 0) throw new Error(`חודש לא מוכר בכותרת: ${title[2]}`);
  const card = title[1];
  const period_month = `${title[3]}-${String(monthIdx + 1).padStart(2, '0')}-01`;

  const lines = [];
  let total_charged = null;
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    let col = null;
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => clean(c.textContent));
      if (!col) {
        if (cells.includes('תאריך העסקה') && cells.includes('שם בית העסק')) {
          col = {
            date: cells.indexOf('תאריך העסקה'), merchant: cells.indexOf('שם בית העסק'),
            amount: cells.indexOf('סכום העסקה'), type: cells.indexOf('סוג העסקה'),
            details: cells.indexOf('פרטים'), charge: cells.indexOf('סכום חיוב'),
          };
        }
        continue;
      }
      if (cells.some((c) => c.startsWith('סה"כ'))) {
        const t = toAmount(cells[col.charge]);
        if (t != null) total_charged = (total_charged ?? 0) + t;
        continue;
      }
      const txn_date = toDate(cells[col.date]);
      const txn_amount = toAmount(cells[col.amount]);
      if (!txn_date || txn_amount == null) continue;
      lines.push({
        txn_date,
        merchant: cells[col.merchant] || null,
        txn_amount,
        charge_amount: col.charge >= 0 ? toAmount(cells[col.charge]) : null,
        txn_type: col.type >= 0 ? cells[col.type] || null : null,
        details: col.details >= 0 ? cells[col.details] || null : null,
      });
    }
  }
  if (!lines.length) throw new Error('לא נמצאו עסקאות בקובץ');
  return { card, period_month, lines, total_charged: total_charged == null ? null : Math.round(total_charged * 100) / 100 };
}

const dayDiff = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : Infinity);
const isForeign = (inv) => inv.currency && inv.currency !== 'ILS';

const RULES = [
  { name: 'amount', test: (inv, l) => !isForeign(inv) && inv.total_incl_vat != null && Math.abs(Number(inv.total_incl_vat) - l.txn_amount) <= 1 && dayDiff(inv.invoice_date, l.txn_date) <= 7 },
  { name: 'foreign', test: (inv, l) => isForeign(inv) && dayDiff(inv.invoice_date, l.txn_date) <= 3 && namesMatch(inv.supplier_name, l.merchant) },
];

/** → { matches: [{ invoice, line, rule }], missing: charges without an invoice } */
export function reconcileCard(invoices, lines) {
  const usedInv = new Set(), usedLine = new Set(), matches = [];
  const sorted = [...lines.keys()].sort((a, b) => String(lines[a].txn_date).localeCompare(String(lines[b].txn_date)));
  for (const rule of RULES) {
    for (const i of sorted) {
      if (usedLine.has(i)) continue;
      const l = lines[i];
      let best = null, bestScore = Infinity;
      for (const inv of invoices) {
        if (usedInv.has(inv.id) || !rule.test(inv, l)) continue;
        // closest date first; a name match is worth half a day
        const score = dayDiff(inv.invoice_date, l.txn_date) - (namesMatch(inv.supplier_name, l.merchant) ? 0.5 : 0);
        if (score < bestScore) { best = inv; bestScore = score; }
      }
      if (!best) continue;
      usedInv.add(best.id); usedLine.add(i);
      matches.push({ invoice: best, line: l, rule: rule.name });
    }
  }
  return { matches, missing: lines.filter((_, i) => !usedLine.has(i)) };
}

// ── card charges vs the bookkeeper's ledger ──────────────────────────────────
// Was every charge booked? The ledger books a VAT invoice BEFORE VAT, a
// no-VAT purchase (bank/card import, foreign service, fee) at its full amount,
// and a vehicle expense (ס"ת חסר: fuel …) with only 2/3 of the VAT deducted,
// so a charge fits a line at the charge, the charge ÷ 1.18, or the charge
// minus 2/3 of its VAT (Paz ₪301.00 → ₪270.39 in the Sept 2026 ledger).
// Only charges dated inside the ledger's period can be checked: a statement for
// billing month M also holds purchases from M-1, which belong to M-1's ledger.

const VAT = 1.18;
const fitsAmount = (ledgerAmount, txn) => {
  const vat = txn - txn / VAT;
  return [txn, txn - vat, txn - (vat * 2) / 3].some((a) => Math.abs(ledgerAmount - a) <= 1);
};

const LEDGER_RULES = [
  { name: 'amount_name', test: (l, c, gap) => gap <= 7 && fitsAmount(l.amount, c.txn_amount) && namesMatch(l.details, c.merchant) },
  { name: 'amount_date', test: (l, c, gap) => gap <= 3 && fitsAmount(l.amount, c.txn_amount) },
];

/**
 * cardLines:   statement lines (all cards)
 * ledgerLines: the bookkeeper's lines; periods = [{ from, to }] the ledgers cover
 * → { booked: [{ card, line, rule }], notBooked: charges in the period with no line,
 *     outside: charges dated outside the ledger period (not checkable) }
 */
export function reconcileCardLedger(cardLines, ledgerLines, periods) {
  const reversed = findReversals(ledgerLines);
  const used = new Set(reversed);
  const list = Array.isArray(periods) ? periods : [periods];
  const inPeriod = (d) => !!d && list.some((p) => d >= p.from && d <= p.to);
  const checkable = cardLines.filter((c) => inPeriod(c.txn_date));
  const outside = cardLines.filter((c) => !inPeriod(c.txn_date));
  const booked = [];
  const done = new Set();

  for (const rule of LEDGER_RULES) {
    for (const c of checkable) {
      if (done.has(c)) continue;
      let best = -1, bestGap = Infinity;
      ledgerLines.forEach((l, i) => {
        if (used.has(i)) return;
        const gap = dayDiff(l.doc_date, c.txn_date);
        if (rule.test(l, c, gap) && gap < bestGap) { best = i; bestGap = gap; }
      });
      if (best < 0) continue;
      used.add(best); done.add(c);
      booked.push({ card: c, line: ledgerLines[best], rule: rule.name });
    }
  }
  return { booked, notBooked: checkable.filter((c) => !done.has(c)), outside };
}
