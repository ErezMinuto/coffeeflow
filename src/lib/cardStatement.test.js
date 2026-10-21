import { parseCardStatement, reconcileCard, toAmount, toDate } from './cardStatement';

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
