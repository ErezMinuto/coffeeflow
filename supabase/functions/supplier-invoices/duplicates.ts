// Is a newly uploaded invoice one that is already in the system?
//
// The identical file never gets this far (file_sha256 is unique). This is for
// a second photo / scan of the same paper, or the same invoice uploaded by two
// people — where the AI may also have misread a field. So several signals:
//   • same supplier ע.מ + same invoice number (digits only — an RTL PDF can
//     come back as "2609802MGS" for "MGS2609802") + same doc type
//   • same supplier ע.מ + same date + same total (the number was misread)
//   • no ע.מ read: same supplier name + same number

export interface InvoiceLike {
  id?: string
  supplier_name?: string | null
  supplier_tax_id?: string | null
  invoice_number?: string | null
  doc_type?: string | null
  invoice_date?: string | null
  total_incl_vat?: number | string | null
}

export const digitsOf = (s?: string | null) => String(s ?? '').replace(/\D/g, '')
const nameKey = (s?: string | null) =>
  String(s ?? '').toLowerCase().replace(/בע["'״׳]?מ|ltd|[^\p{L}\p{N}]+/gu, '')

export function duplicateReason(a: InvoiceLike, b: InvoiceLike): string | null {
  const numA = digitsOf(a.invoice_number), numB = digitsOf(b.invoice_number)
  const sameNumber = !!numA && numA === numB
  const sameType = (a.doc_type ?? 'tax_invoice') === (b.doc_type ?? 'tax_invoice')
  if (a.supplier_tax_id && a.supplier_tax_id === b.supplier_tax_id) {
    if (sameNumber && sameType) return 'same_supplier_number'
    const ta = Number(a.total_incl_vat), tb = Number(b.total_incl_vat)
    if (a.invoice_date && a.invoice_date === b.invoice_date && a.total_incl_vat != null && b.total_incl_vat != null
        && Math.abs(ta - tb) <= 1) return 'same_supplier_date_total'
    return null
  }
  if (!a.supplier_tax_id || !b.supplier_tax_id) {
    const na = nameKey(a.supplier_name)
    if (na && na === nameKey(b.supplier_name) && sameNumber && sameType) return 'same_name_number'
  }
  return null
}
