// Behaviour tests for duplicates.ts.
//
//   deno run supabase/functions/supplier-invoices/duplicates_test.ts
import { duplicateReason } from './duplicates.ts'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) failures++
}

const kedma = { supplier_name: 'B.A Kedma Cafe LTD', supplier_tax_id: '514539204', invoice_number: '18067', doc_type: 'tax_invoice', invoice_date: '2026-10-21', total_incl_vat: 10660.12 }

check('same supplier + number', duplicateReason(kedma, { ...kedma }) === 'same_supplier_number')
check('number reversed by an RTL PDF still matches', duplicateReason(
  { ...kedma, invoice_number: 'MGS2609802' }, { ...kedma, invoice_number: '2609802MGS' }) === 'same_supplier_number')
check('number misread, but same date and total', duplicateReason(kedma, { ...kedma, invoice_number: '18061' }) === 'same_supplier_date_total')
check('same number, different supplier: not a duplicate', duplicateReason(kedma, { ...kedma, supplier_tax_id: '513463844' }) === null)
check('same supplier, different invoice: not a duplicate', duplicateReason(kedma, { ...kedma, invoice_number: '18068', total_incl_vat: 500 }) === null)
check('an invoice and its receipt are two documents', duplicateReason(kedma, { ...kedma, doc_type: 'receipt', invoice_date: '2026-10-25' }) === null)
check('no tax id read: name + number', duplicateReason(
  { ...kedma, supplier_tax_id: null }, { ...kedma, supplier_tax_id: null, supplier_name: 'B.A Kedma Cafe Ltd.' }) === 'same_name_number')
check('no tax id and no number: never a duplicate', duplicateReason(
  { supplier_name: 'יוחננוף' }, { supplier_name: 'יוחננוף' }) === null)

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`)
Deno.exit(failures === 0 ? 0 : 1)
