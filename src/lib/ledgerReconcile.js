// Reconciling supplier invoices against the bookkeeper's Hashavshevet ledger.
//
// INPUT: a כרטסת הנהלת חשבונות exported to Excel. Layout (as exported):
//   row "תאריך מ..עד 01/09/2026 >> 30/09/2026 ; …"     → the period
//   header row with כותרת, תנועה, מנה, ס"ת, ח-ן נגדי, ת.אסמכ, ת.ערך, אסמ', אסמ'2,
//     פרטים, תמחיר, "… חובה", "… זכות", יתרה           → columns found by name
//   section row  [account name, account key, group]    → e.g. קניות 6002
//   movement rows (dates are Excel serial numbers)
//   "סה"כ מפתח חשבון" / "יתרת פתיחה" rows               → skipped
//
// What the ledger looks like in practice (Sept 2026 export):
//   • ח-ן נגדי is the supplier's ע.מ when the supplier has its own card, else a
//     shared card (17113 / 3039 / 3002 …) used for many small suppliers.
//   • אסמ'2 holds the invoice number, often only its LAST 4 DIGITS
//     (Si Pronto invoice 45736 is booked as 5736). Match on the suffix.
//   • amounts are before VAT (VAT goes to a separate account); credit notes
//     are negative. Some lines carry no VAT at all, so a line is compared with
//     both the invoice's pre-VAT amount and its total.
//   • a line booked and then reversed shows as +x / −x with the same card and
//     reference; both cancel and neither is a real document.
//   • ס"ת (movement type) is set for typed-in documents (חס, חסר …) and empty
//     for lines imported from the bank / card (batch 9997).

// ── Excel → rows ─────────────────────────────────────────────────────────────

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

/** First sheet of an .xlsx as an array of row arrays (strings / null). */
export async function readXlsxRows(arrayBuffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(arrayBuffer);
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const textOf = (el) => Array.from(el.getElementsByTagName('t')).map((t) => t.textContent).join('');

  const ssFile = zip.file('xl/sharedStrings.xml');
  const shared = ssFile ? Array.from(parse(await ssFile.async('string')).getElementsByTagName('si')).map(textOf) : [];

  // The first sheet in workbook order, via its relationship id.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = zip.file('xl/workbook.xml');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = parse(await wb.async('string')).getElementsByTagName('sheet')[0];
    const rid = first?.getAttribute('r:id');
    const rel = Array.from(parse(await rels.async('string')).getElementsByTagName('Relationship'))
      .find((r) => r.getAttribute('Id') === rid);
    if (rel) sheetPath = 'xl/' + rel.getAttribute('Target').replace(/^\/?xl\//, '');
  }
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error('לא נמצא גיליון בקובץ');

  const rows = [];
  for (const r of Array.from(parse(await sheetFile.async('string')).getElementsByTagName('row'))) {
    const row = [];
    for (const c of Array.from(r.getElementsByTagName('c'))) {
      const v = c.getElementsByTagName('v')[0];
      const type = c.getAttribute('t');
      let val = null;
      if (type === 's' && v) val = shared[Number(v.textContent)] ?? null;
      else if (type === 'inlineStr') val = textOf(c);
      else if (v) val = v.textContent;
      row[colIndex(c.getAttribute('r'))] = val;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? null : x)));
  }
  return rows;
}

// ── rows → ledger lines ──────────────────────────────────────────────────────

const clean = (v) => (v == null ? '' : String(v).replace(/[‎‏]/g, '').trim());

export function toISODate(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {                       // Excel serial day
    const n = Math.floor(Number(s));
    if (n < 20000 || n > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const toNum = (v) => {
  const s = clean(v).replace(/,/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const HEADERS = {
  header_id: 'כותרת', movement_id: 'תנועה', batch: 'מנה', movement_type: 'ס"ת',
  counter_account: 'ח-ן נגדי', doc_date: 'ת.אסמכ', value_date: 'ת.ערך',
  ref1: "אסמ'", ref2: "אסמ'2", details: 'פרטים',
};

/** Hashavshevet ledger rows → { period_from, period_to, lines }. Throws on a file that is not one. */
export function parseLedger(rows) {
  let period_from = null, period_to = null;
  for (const row of rows.slice(0, 10)) {
    const m = clean(row.find((c) => clean(c).includes('תאריך מ..עד')))
      .match(/תאריך מ\.\.עד\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*>>\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (m) { period_from = toISODate(m[1]); period_to = toISODate(m[2]); break; }
  }

  const hIdx = rows.findIndex((r) => r.some((c) => clean(c) === 'כותרת') && r.some((c) => clean(c) === 'תנועה'));
  if (hIdx < 0) throw new Error('זה לא נראה כמו כרטסת מחשבשבת: לא נמצאה שורת כותרות (כותרת / תנועה)');
  const header = rows[hIdx].map(clean);
  const col = {};
  for (const [k, label] of Object.entries(HEADERS)) col[k] = header.indexOf(label);
  col.debit = header.findIndex((h) => h.includes('חובה') && h.endsWith('חובה'));
  col.credit = header.findIndex((h) => h.includes('זכות') && h.endsWith('זכות'));
  const missing = ['movement_id', 'counter_account', 'doc_date', 'ref2', 'details', 'debit']
    .filter((k) => col[k] < 0);
  if (missing.length) throw new Error(`חסרות עמודות בכרטסת: ${missing.join(', ')}`);

  const lines = [];
  let account_key = null, account_name = null;
  for (const row of rows.slice(hIdx + 1)) {
    const first = clean(row[0]);
    const get = (k) => (col[k] >= 0 ? clean(row[col[k]]) : '');
    if (first.startsWith('סה"כ')) continue;
    if (first && /^[\d-]+$/.test(clean(row[1])) && !get('movement_id')) {   // section: name, key, group
      account_name = first; account_key = clean(row[1]);
      continue;
    }
    if (!/^\d+$/.test(get('movement_id'))) continue;               // opening balance, blanks
    lines.push({
      account_key, account_name,
      header_id: get('header_id') || null,
      movement_id: get('movement_id'),
      batch: get('batch') || null,
      movement_type: get('movement_type') || null,
      counter_account: get('counter_account') || null,
      doc_date: toISODate(row[col.doc_date]),
      value_date: col.value_date >= 0 ? toISODate(row[col.value_date]) : null,
      ref1: get('ref1') || null,
      ref2: get('ref2') || null,
      details: get('details') || null,
      amount: Math.round((toNum(row[col.debit]) - (col.credit >= 0 ? toNum(row[col.credit]) : 0)) * 100) / 100,
    });
  }
  if (!lines.length) throw new Error('לא נמצאו תנועות בכרטסת');

  if (!period_from || !period_to) {
    const dates = lines.map((l) => l.doc_date).filter(Boolean).sort();
    period_from = period_from || dates[0];
    period_to = period_to || dates[dates.length - 1];
  }
  return { period_from, period_to, lines };
}

// ── matching ─────────────────────────────────────────────────────────────────

const digits = (v) => String(v ?? '').replace(/\D/g, '');

/** Invoice number vs ledger reference: equal, or one is the tail of the other (≥ 3 digits). */
export function numbersMatch(invoiceNumber, ref) {
  const a = digits(invoiceNumber).replace(/^0+/, ''), b = digits(ref).replace(/^0+/, '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 3) return false;
  return a.endsWith(b) || b.endsWith(a);
}

const TOLERANCE = 1;   // ₪, rounding between the invoice and the booking
export function amountsMatch(inv, amount) {
  return [inv.amount_before_vat, inv.total_incl_vat]
    .filter((v) => v != null && v !== '')
    .some((v) => Math.abs(Number(v) - amount) <= TOLERANCE);
}

const dayDiff = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : Infinity);

const STOP = new Set(['בע"מ', 'בעמ', "בע''מ", 'ltd', 'בע', 'מ', 'ושות', 'קפה', 'cafe', 'coffee', 'חברה', 'למסחר']);
const tokens = (s) => String(s ?? '').toLowerCase()
  .replace(/["'״׳.,()\-–/]/g, ' ').split(/\s+/)
  .filter((t) => t.length >= 2 && !STOP.has(t));
export function namesMatch(a, b) {
  const tb = new Set(tokens(b));
  return tokens(a).some((t) => t.length >= 3 && tb.has(t));
}

/** Line indexes that are a booking and its reversal (+x / −x, same card and reference). */
export function findReversals(lines) {
  const out = new Set();
  const groups = new Map();
  lines.forEach((l, i) => {
    if (!l.amount) return;
    const k = `${l.counter_account}|${l.ref2}|${Math.abs(l.amount).toFixed(2)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  for (const idx of groups.values()) {
    const pos = idx.filter((i) => lines[i].amount > 0);
    const neg = idx.filter((i) => lines[i].amount < 0);
    for (let n = 0; n < Math.min(pos.length, neg.length); n++) { out.add(pos[n]); out.add(neg[n]); }
  }
  return out;
}

// Applied in this order; each invoice and each line is used at most once.
const RULES = [
  // same supplier card + same invoice number: a match even if the amount was mistyped
  { name: 'number', test: (inv, l) => !!inv.supplier_tax_id && digits(l.counter_account) === inv.supplier_tax_id && numbersMatch(inv.invoice_number, l.ref2) },
  // shared card, but the number and the amount agree
  { name: 'number_amount', test: (inv, l) => numbersMatch(inv.invoice_number, l.ref2) && amountsMatch(inv, l.amount) },
  // supplier card + amount, number booked differently
  { name: 'tax_amount', test: (inv, l) => !!inv.supplier_tax_id && digits(l.counter_account) === inv.supplier_tax_id && amountsMatch(inv, l.amount) && dayDiff(inv.invoice_date, l.doc_date) <= 10 },
  // shared card, no usable number: name + amount + date
  { name: 'name_amount', test: (inv, l) => amountsMatch(inv, l.amount) && dayDiff(inv.invoice_date, l.doc_date) <= 5 && namesMatch(inv.supplier_name, l.details) },
];

/**
 * invoices: supplier_invoices rows (a window a little wider than the period, so
 *   a booking dated a few days off still finds its invoice)
 * lines:    parsed / stored ledger lines for the period
 * → {
 *     matches:    [{ invoice, line, rule, amountDiffers }],
 *     notBooked:  invoices inside the period that no line matched,
 *     noFile:     document lines (ס"ת set) that matched no invoice,
 *     otherLines: unmatched lines without a document type (bank / card imports …),
 *     reversed:   lines cancelled by their reversal,
 *   }
 */
export function reconcile(invoices, lines, period) {
  const reversedIdx = findReversals(lines);
  const usedLine = new Set(reversedIdx);
  const usedInv = new Set();
  const matches = [];

  const invs = [...invoices].sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)));
  for (const rule of RULES) {
    for (const inv of invs) {
      if (usedInv.has(inv.id)) continue;
      let best = -1, bestGap = Infinity;
      lines.forEach((l, i) => {
        if (usedLine.has(i) || !rule.test(inv, l)) return;
        const gap = dayDiff(inv.invoice_date, l.doc_date);
        if (gap < bestGap) { best = i; bestGap = gap; }
      });
      if (best < 0) continue;
      usedInv.add(inv.id); usedLine.add(best);
      matches.push({ invoice: inv, line: lines[best], rule: rule.name, amountDiffers: !amountsMatch(inv, lines[best].amount) });
    }
  }

  const inPeriod = (d) => !!d && (!period || (d >= period.from && d <= period.to));
  return {
    matches,
    notBooked: invs.filter((inv) => !usedInv.has(inv.id) && inPeriod(inv.invoice_date)),
    noFile: lines.filter((l, i) => !usedLine.has(i) && l.movement_type),
    otherLines: lines.filter((l, i) => !usedLine.has(i) && !l.movement_type),
    reversed: lines.filter((_, i) => reversedIdx.has(i)),
  };
}
