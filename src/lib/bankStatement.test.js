import { parseBankStatement, classify, reconcileBankLedger, reconcileBankInvoices } from './bankStatement';

// Shaped like a Bank Leumi "תנועות עו"ש" export (HTML saved as .xls), made-up values.
const row = (date, desc, ref, debit, credit) =>
  `<tr><td>725</td><td>196400/55</td><td>${date}</td><td>${desc}</td><td>${ref}</td><td>${debit}</td><td>${credit}</td><td>1,000</td><td></td></tr>`;
const HTML = `<html><body><table>
<tr><td>בנק לאומי | תאריך שמירה/הדפסה: 21/10/2026</td></tr>
<tr><td>תאריך: 30.09.2026 - 01.09.2026</td></tr>
<tr><td></td><td>סניף</td><td>חשבון</td><td>תאריך</td><td>תיאור תנועה</td><td>אסמכתא</td><td>בחובה</td><td>בזכות</td><td>יתרה בש"ח</td><td>הערות</td></tr>
${row('22/09/2026', 'העברה דיגיטל', '143866', '22,908', '')}
${row('16/09/2026', 'טאביט טכנולו-י', '288', '632', '')}
${row('15/09/2026', 'לאומי ויזה', '8177', '36,195.43', '')}
${row('08/09/2026', 'העברת משכורת', '34385', '56,665', '')}
${row('25/09/2026', 'רשויות אינטרנט', '3375', '4,773', '')}
${row('22/09/2026', 'ביטוח לאומי-י', '38286', '6,683', '')}
${row('08/09/2026', 'עמ.גל"י לבנקים', '34379', '13.2', '')}
${row('29/09/2026', 'בנק הפועלים', '99012', '', '5,000')}
${row('03/09/2026', 'שיק', '5000211', '6,500', '')}
</table></body></html>`;

describe('parseBankStatement', () => {
  const s = parseBankStatement(HTML);
  test('account, period and every movement', () => {
    expect([s.account, s.period_from, s.period_to, s.lines.length]).toEqual(['725-196400/55', '2026-09-01', '2026-09-30', 9]);
  });
  test('debit is money out (+), credit is money in (−)', () => {
    expect(s.lines[0].amount).toBe(22908);
    expect(s.lines[7].amount).toBe(-5000);
  });
  test('classification', () => {
    expect(s.lines.map((l) => l.category)).toEqual(['supplier', 'supplier', 'card', 'salary', 'tax', 'tax', 'fee', 'income', 'supplier']);
  });
  test('a different file is refused', () => {
    expect(() => parseBankStatement('<html><body><table><tr><td>x</td></tr></table></body></html>')).toThrow(/תנועות/);
  });
  test('Mastercard and Diners are card settlements', () => {
    expect(classify({ amount: 1, description: 'ל.מאסטרקארד' })).toBe('card');
    expect(classify({ amount: 1, description: 'לאומי דיינרס' })).toBe('card');
  });
});

describe('reconcileBankLedger', () => {
  // Cases taken from the real Sept 2026 statement and ledger.
  const P = (txn_date, amount, description = 'העברה דיגיטל') => ({ txn_date, amount, description, category: 'supplier' });
  const L = (doc_date, amount, details) => ({ doc_date, amount, details, counter_account: '1', ref2: '1' });
  const sept = [{ from: '2026-09-01', to: '2026-09-30' }];

  test('a transfer settles an invoice booked earlier, before VAT', () => {
    const r = reconcileBankLedger([P('2026-09-22', 22908)], [L('2026-09-02', 19413.56, 'איבן בית מאפה')], sept);
    expect(r.booked).toHaveLength(1);
  });
  test('rent by cheque is booked at the full amount', () => {
    const r = reconcileBankLedger([P('2026-09-03', 6500, 'שיק')], [L('2026-09-01', 6500, 'סבן ניצה - שכירות')], sept);
    expect(r.booked).toHaveLength(1);
  });
  test('a named direct debit prefers its own supplier, even dated two weeks later', () => {
    const r = reconcileBankLedger([P('2026-09-16', 632, 'טאביט טכנולו-י')],
      [L('2026-09-02', 534.75, 'מדבקה ברגע בע"מ'), L('2026-09-30', 535.59, 'טאביט טכנולוגיות בע"מ')], sept);
    expect(r.booked[0].line.details).toMatch(/טאביט/);
  });
  test('an unnamed transfer does not reach an invoice dated weeks after it', () => {
    const r = reconcileBankLedger([P('2026-09-02', 2000)], [L('2026-09-28', 1694.92, 'X')], sept);
    expect(r.notBooked).toHaveLength(1);
  });
  test('a payment dated outside every uploaded ledger is not checked', () => {
    const r = reconcileBankLedger([P('2026-10-02', 100)], [], sept);
    expect([r.outside.length, r.notBooked.length]).toEqual([1, 0]);
  });
});

describe('reconcileBankInvoices', () => {
  const P = (txn_date, amount) => ({ txn_date, amount, description: 'העברה דיגיטל' });
  const I = (id, supplier_tax_id, invoice_date, total_incl_vat) => ({ id, supplier_tax_id, supplier_name: supplier_tax_id, invoice_date, total_incl_vat });

  test('one invoice for the whole payment', () => {
    const r = reconcileBankInvoices([P('2026-09-22', 22908)], [I('a', '516449444', '2026-09-02', 22908)]);
    expect(r.matches[0].invoices.map((i) => i.id)).toEqual(['a']);
  });
  test('one transfer paying three invoices of the same supplier', () => {
    const r = reconcileBankInvoices([P('2026-09-30', 1000)],
      [I('a', '1', '2026-09-01', 300), I('b', '1', '2026-09-10', 450), I('c', '1', '2026-09-20', 250), I('x', '2', '2026-09-05', 1000.5 + 5)]);
    expect(r.matches[0].invoices.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
  });
  test('invoices of different suppliers are never added together', () => {
    const r = reconcileBankInvoices([P('2026-09-30', 700)], [I('a', '1', '2026-09-01', 300), I('b', '2', '2026-09-10', 400)]);
    expect(r.missing).toHaveLength(1);
  });
});
