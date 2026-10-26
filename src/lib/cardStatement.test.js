import { parseCardStatement, reconcileCard, reconcileCardLedger, toAmount, toDate } from './cardStatement';

// Shaped like a Bank Leumi card export (HTML saved as .xls), made-up values.
const HTML = `<html dir="RTL"><body>
<table><tr><td>פרוט עסקאות לכרטיס לאומי מסטרקארד 7113 לתקופה: ספטמבר 2026</td><td></td></tr></table>
<table>
<tr><td>עסקאות בש"ח במועד החיוב</td></tr>
<tr><th>תאריך העסקה</th><th>שם בית העסק</th><th>סכום העסקה</th><th>סוג העסקה</th><th>פרטים</th><th>סכום חיוב</th></tr>
<tr><td>02/09/26</td><td>יוחננוף - אחד העם</td><td>133.20</td><td>עסקה רגילה</td><td></td><td>133.20</td></tr>
<tr><td>30/08/26</td><td>סי פרונטו חברה למסחר</td><td>8,543.00</td><td>עסקה רגילה</td><td></td><td>8,543.00</td></tr>
<tr><td>23/08/26</td><td>אמישראגז</td><td>5,498.80</td><td>עסקת תשלומים רגילה</td><td>עסקה בתשלומים תשלום - 1 מ - 6.</td><td>916.45</td></tr>
<tr><td>01/09/26</td><td>Canva</td><td>52.10</td><td>סייקל חו"ל</td><td></td><td>52.10</td></tr>
<tr><td>05/09/26</td><td>החזר כספי</td><td>50.00-</td><td>זיכוי</td><td></td><td>50.00-</td></tr>
<tr><td></td><td></td><td></td><td></td><td>סה"כ:</td><td>9,594.75</td></tr>
</table>
<table><tr><td>בנק לאומי |</td></tr></table>
</body></html>`;

const inv = (id, supplier_name, invoice_date, total_incl_vat, currency = 'ILS') =>
  ({ id, supplier_name, invoice_date, total_incl_vat, currency });

describe('parseCardStatement', () => {
  const s = parseCardStatement(HTML);
  test('card and billing month from the title', () => {
    expect([s.card, s.period_month]).toEqual(['7113', '2026-09-01']);
  });
  test('one line per transaction; header and total skipped', () => {
    expect(s.lines).toHaveLength(5);
    expect(s.total_charged).toBe(9594.75);
  });
  test('installments keep the full purchase and this month’s charge', () => {
    expect(s.lines[2]).toMatchObject({ txn_amount: 5498.8, charge_amount: 916.45, txn_date: '2026-08-23' });
  });
  test('amount formats', () => {
    expect(toAmount('2,340.63')).toBe(2340.63);
    expect(toAmount('50.00-')).toBe(-50);
    expect(toDate('30/08/26')).toBe('2026-08-30');
  });
  test('another file is refused', () => {
    expect(() => parseCardStatement('<html><body><table><tr><td>x</td></tr></table></body></html>')).toThrow(/כרטיס/);
  });
});

describe('reconcileCard', () => {
  const { lines } = parseCardStatement(HTML);

  test('total incl. VAT matches the charge, within a week', () => {
    const r = reconcileCard([inv('y', 'יוחננוף', '2026-09-02', 133.2)], lines);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ rule: 'amount' });
  });
  test('installments match on the full purchase, not the monthly charge', () => {
    const r = reconcileCard([inv('g', 'אמישראגז', '2026-08-23', 5498.8)], lines);
    expect(r.matches[0].line.merchant).toBe('אמישראגז');
  });
  test('a USD invoice matches by name and date', () => {
    const r = reconcileCard([inv('c', 'Canva Pty. Ltd.', '2026-09-01', 15, 'USD')], lines);
    expect(r.matches[0]).toMatchObject({ rule: 'foreign' });
  });
  test('same amount but too far apart in time does not match', () => {
    const r = reconcileCard([inv('old', 'יוחננוף', '2026-07-01', 133.2)], lines);
    expect(r.matches).toHaveLength(0);
  });
  test('every unmatched charge is reported missing', () => {
    const r = reconcileCard([inv('y', 'יוחננוף', '2026-09-02', 133.2)], lines);
    expect(r.missing.map((l) => l.merchant)).toEqual(['סי פרונטו חברה למסחר', 'אמישראגז', 'Canva', 'החזר כספי']);
  });
  test('two equal charges need two invoices', () => {
    const two = [...lines, { ...lines[0] }];
    const r = reconcileCard([inv('y', 'יוחננוף', '2026-09-02', 133.2)], two);
    expect(r.matches).toHaveLength(1);
    expect(r.missing.filter((l) => l.merchant.startsWith('יוחננוף'))).toHaveLength(1);
  });
});

describe('reconcileCardLedger', () => {
  // Cases taken from the real Sept 2026 card statements and ledger.
  const L = (doc_date, amount, details, counter_account = '17113', ref2 = '1') => ({ doc_date, amount, details, counter_account, ref2 });
  const C = (txn_date, txn_amount, merchant) => ({ txn_date, txn_amount, merchant });
  const sept = { from: '2026-09-01', to: '2026-09-30' };

  test('booked before VAT, at the full amount, or with 2/3 of the VAT (vehicle)', () => {
    const r = reconcileCardLedger(
      [C('2026-09-02', 133.2, 'יוחננוף - אחד העם'), C('2026-09-01', 62.6, 'Google CLOUD 6T2T6R'), C('2026-09-04', 301, 'פז מזכרת בתיה')],
      [L('2026-09-02', 112.88, 'יוחננוף'), L('2026-09-01', 62.6, 'Google CLOUD 6T2T6R', '18177'), L('2026-09-04', 270.39, 'פז מזכרת בתיה')],
      sept);
    expect(r.booked).toHaveLength(3);
    expect(r.notBooked).toHaveLength(0);
  });
  test('a charge with no line of its amount is not booked', () => {
    const r = reconcileCardLedger([C('2026-09-07', 39.9, 'APPLE.COM/BILL')],
      [L('2026-09-11', 69.9, 'APPLE.COM/BILL'), L('2026-09-19', 97.9, 'APPLE.COM/BILL')], sept);
    expect(r.notBooked.map((c) => c.txn_amount)).toEqual([39.9]);
  });
  test('August charges on a September statement are outside the September ledger', () => {
    const r = reconcileCardLedger([C('2026-08-30', 8543, 'סי פרונטו חברה למסחר')], [], sept);
    expect([r.outside.length, r.notBooked.length]).toEqual([1, 0]);
  });
  test('two ledgers cover two months', () => {
    const r = reconcileCardLedger([C('2026-08-30', 64, 'גונסון')], [L('2026-08-30', 64, 'גונסון')],
      [{ from: '2026-08-01', to: '2026-08-31' }, sept]);
    expect(r.booked).toHaveLength(1);
  });
  test('same amount, no name match, more than 3 days apart: not booked', () => {
    const r = reconcileCardLedger([C('2026-09-01', 100, 'א')], [L('2026-09-06', 100, 'ב')], sept);
    expect(r.notBooked).toHaveLength(1);
  });
});
