// Behaviour tests for extract.ts.
//
//   deno run supabase/functions/supplier-invoices/extract_test.ts
//
// What matters: Israeli dates read day-first, amounts come out as numbers,
// a credit note is negative, the one missing figure is filled from the other
// two (never more), and a value the model left out stays null.
import { normaliseExtraction, parseJsonObject, toAmount, toDate, buildRequest } from './extract.ts'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) failures++
}

check('ISO date kept', toDate('2026-10-03') === '2026-10-03')
check('DD/MM/YYYY is day-first', toDate('03/10/2026') === '2026-10-03', String(toDate('03/10/2026')))
check('DD.MM.YY expands the year', toDate('3.10.26') === '2026-10-03', String(toDate('3.10.26')))
check('impossible date → null', toDate('31/02/2026') === null)
check('words → null', toDate('yesterday') === null)
check('year 0006 → null (misread)', toDate('0006-10-05') === null)
check('year 1999 → null', toDate('05/10/1999') === null)
check('two years ahead → null', toDate(`05/10/${new Date().getUTCFullYear() + 2}`) === null)

check('₪ and thousands separator stripped', toAmount('₪1,234.50') === 1234.5)
check('number kept', toAmount(99.999) === 100)
check('"null" string → null', toAmount('null') === null)

check('fenced JSON parsed', parseJsonObject('```json\n{"a":1}\n```').a === 1)
check('no JSON → empty object', Object.keys(parseJsonObject('sorry')).length === 0)

const inv = normaliseExtraction({
  supplier_name: ' קפה ירוק בע"מ ', supplier_tax_id: '51-234567-8', invoice_number: 10234,
  doc_type: 'tax_invoice', invoice_date: '14/10/2026',
  amount_before_vat: '1,000.00', vat_amount: null, total_incl_vat: 1180, allocation_number: '123 456 789',
})
check('name trimmed', inv.supplier_name === 'קפה ירוק בע"מ')
check('tax id digits only', inv.supplier_tax_id === '512345678', String(inv.supplier_tax_id))
check('invoice number as text', inv.invoice_number === '10234')
check('missing VAT filled from the other two', inv.vat_amount === 180, String(inv.vat_amount))
check('allocation number digits only', inv.allocation_number === '123456789')
check('currency defaults to ILS', inv.currency === 'ILS')

const credit = normaliseExtraction({ doc_type: 'credit_note', amount_before_vat: 100, vat_amount: 18, total_incl_vat: 118 })
check('credit note stored negative', credit.total_incl_vat === -118 && credit.amount_before_vat === -100 && credit.vat_amount === -18)

const sparse = normaliseExtraction({ total_incl_vat: 59, doc_type: 'nonsense' })
check('only total → others stay null', sparse.amount_before_vat === null && sparse.vat_amount === null)
check('unknown doc type → tax_invoice', sparse.doc_type === 'tax_invoice')
check('empty answer → all null', normaliseExtraction({}).supplier_name === null)

const pdfReq = buildRequest('application/pdf', 'AAAA') as { messages: Array<{ content: Array<{ type: string }> }> }
check('PDF goes as a document block', pdfReq.messages[0].content[0].type === 'document')
const imgReq = buildRequest('image/jpeg', 'AAAA') as { messages: Array<{ content: Array<{ type: string }> }> }
check('JPEG goes as an image block', imgReq.messages[0].content[0].type === 'image')

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`)
Deno.exit(failures === 0 ? 0 : 1)
