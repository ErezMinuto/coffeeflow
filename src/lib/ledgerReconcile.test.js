import { parseLedger, reconcile, numbersMatch, toISODate, findReversals } from './ledgerReconcile';

// Shaped like a real Hashavshevet כרטסת export (Sept 2026), with made-up values.
const H = [null, null, null, 'כותרת', 'תנועה', 'מנה', 'ס"ת', 'ח-ן נגדי', 'ת.אסמכ', 'ת.ערך', "אסמ'", "אסמ'2", 'פרטים', 'תמחיר', ' חובה / זכות (שקל) חובה', '  חובה / זכות (שקל) זכות', 'יתרה (שקל)'];
const line = (mov, batch, type, counter, serial, ref2, details, debit, credit = null) =>
  [null, null, null, '1', String(mov), batch, type, counter, String(serial), String(serial), '0', ref2, details, null, debit, credit, '0'];
// 46281 = 2026-09-16, 46268 = 2026-09-03, 46267 = 2026-09-02
const ROWS = [
  ['מינוטו קפה בע"מ'],
  ['כרטסת הנהלת חשבונות'],
  ['תאריך מ..עד ‎01/09/2026  >> 30/09/2026 ; תאריך ערך מ..עד ‎01/01/1980  >> 31/12/2029'],
  H,
  ['קניות', '6002', '600'],
  ['', null, 'יתרת פתיחה ', null, null, null, null, null, null, null, null, null, null, null, null, null, '-100'],
  line(1, '277', 'חס', '513463844', 46281, '5736', 'סי פרונטו חברה למסחר בע"מ', '3960.17'),
  line(2, '269', 'חס', '514539204', 46268, '7557', 'ב.א קדמה קפה בע"מ', '7890'),
  line(3, '269', 'חס', '514539204', 46268, '4289', 'ב.א קדמה קפה בע"מ-זיכוי', '-890'),
  line(4, '269', 'חס', '3019', 46267, '6516', 'אמנזיה - קפה', '4546.61'),
  line(5, '273', 'חס', '3019', 46267, '6516', 'אמנזיה - קפה', '-4546.61'),
  line(6, '273', 'חס', '557362514', 46267, '6516', 'קפה לנדוור', '4546.61'),
  line(7, '269', 'חס', '17113', 46267, '1721', 'יוחננוף', '112.88'),
  line(8, '9997', null, '18177', 46281, null, 'FACEBK *TBC2272AS4', '3418'),
  ['סה"כ מפתח חשבון', '6002', 'קניות', null, null, null, null, null, null, null, null, null, null, null, null, '1,000.00   חובה'],
  ['ביטוח לאומי מילואים', '4605', '610'],
  line(9, '9997', null, '10011', 46281, null, 'ביטוח לאומי-מילואים', null, '264'),
  ['מספר תנועות בדו"ח 9'],
];

const inv = (id, supplier_name, supplier_tax_id, invoice_number, invoice_date, amount_before_vat, total_incl_vat) =>
  ({ id, supplier_name, supplier_tax_id, invoice_number, invoice_date, amount_before_vat, total_incl_vat });

describe('parseLedger', () => {
  const { period_from, period_to, lines } = parseLedger(ROWS);

  test('reads the period from the report title', () => {
    expect([period_from, period_to]).toEqual(['2026-09-01', '2026-09-30']);
  });
  test('one line per movement; totals, sections and opening balance skipped', () => {
    expect(lines).toHaveLength(9);
  });
  test('Excel serial dates become ISO dates', () => {
    expect(lines[0].doc_date).toBe('2026-09-16');
    expect(toISODate('46267')).toBe('2026-09-02');
    expect(toISODate('03/09/26')).toBe('2026-09-03');
  });
  test('the section gives the account; credit column is negative', () => {
    expect(lines[0]).toMatchObject({ account_key: '6002', account_name: 'קניות', ref2: '5736', amount: 3960.17 });
    expect(lines[8]).toMatchObject({ account_key: '4605', amount: -264 });
  });
  test('a file that is not a ledger is refused', () => {
    expect(() => parseLedger([['שם', 'סכום'], ['a', '1']])).toThrow(/כרטסת/);
  });
});

describe('numbersMatch', () => {
  test('the ledger keeps the last digits', () => {
    expect(numbersMatch('45736', '5736')).toBe(true);
    expect(numbersMatch('45737', '5736')).toBe(false);
  });
  test('two digits are too few to call a tail match', () => {
    expect(numbersMatch('12336', '36')).toBe(false);
    expect(numbersMatch('36', '36')).toBe(true);
  });
  test('letters and leading zeros ignored', () => {
    expect(numbersMatch('MGS2609802', '09802')).toBe(true);
  });
});

describe('reconcile', () => {
  const { lines } = parseLedger(ROWS);
  const period = { from: '2026-09-01', to: '2026-09-30' };

  test('the invoice Erez found missing (Si Pronto 45737) is reported as not booked', () => {
    const r = reconcile([
      inv('45737', 'סי פרונטו חברה למסחר בע"מ', '513463844', '45737', '2026-09-16', 1925.42, 2272),
      inv('45736', 'סי פרונטו חברה למסחר בע"מ', '513463844', '45736', '2026-09-16', 3960.17, 4673),
    ], lines, period);
    expect(r.notBooked.map((i) => i.id)).toEqual(['45737']);
    expect(r.matches[0]).toMatchObject({ rule: 'number', amountDiffers: false });
  });

  test('supplier card + number matches even when the amount was mistyped, and says so', () => {
    const r = reconcile([inv('k', 'Kedma', '514539204', '17557', '2026-09-03', 7980, 9416.4)], lines, period);
    expect(r.matches[0]).toMatchObject({ rule: 'number', amountDiffers: true });
  });

  test('credit notes match their negative booking', () => {
    const r = reconcile([inv('c', 'Kedma', '514539204', '14289', '2026-09-03', -890, -1050.2)], lines, period);
    expect(r.matches[0].line.amount).toBe(-890);
  });

  test('shared card: number + amount', () => {
    const r = reconcile([inv('y', 'יוחננוף', null, '1721', '2026-09-02', 112.88, 133.2)], lines, period);
    expect(r.matches[0]).toMatchObject({ rule: 'number_amount' });
  });

  test('a booking and its reversal cancel; the re-booking is what matches', () => {
    expect([...findReversals(lines)].sort()).toEqual([3, 4]);
    const r = reconcile([inv('a', 'לנדוור', null, '6516', '2026-09-02', 4546.61, 5365)], lines, period);
    expect(r.matches[0].line.details).toBe('קפה לנדוור');
    expect(r.reversed).toHaveLength(2);
  });

  test('document lines without an invoice → noFile; bank/card lines → otherLines', () => {
    const r = reconcile([], lines, period);
    expect(r.noFile).toHaveLength(5);         // 1,2,3,6,7 (4/5 reversed)
    expect(r.otherLines).toHaveLength(2);     // FACEBK, ביטוח לאומי
  });

  test('an invoice outside the period is a candidate but never "not booked"', () => {
    const r = reconcile([inv('oct', 'X', '1', '1', '2026-10-02', 5, 5.9)], lines, period);
    expect(r.notBooked).toHaveLength(0);
  });
});
