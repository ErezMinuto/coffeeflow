// Reading a supplier invoice with Claude, and cleaning what comes back.
//
// The model sees the shrunk photo / PDF and answers with one JSON object.
// Everything it says is a suggestion: the uploader sees the fields and fixes
// them before confirming, so normaliseExtraction() only coerces types and
// drops what is clearly not a value — it never invents one.

import { claudeBody, claudeHeaders, claudeText } from '../_shared/claude.ts'

export const DOC_TYPES = [
  'tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_note', 'transaction_invoice', 'other',
] as const
export type DocType = typeof DOC_TYPES[number]

export interface InvoiceFields {
  supplier_name: string | null
  supplier_tax_id: string | null
  invoice_number: string | null
  doc_type: DocType
  invoice_date: string | null
  amount_before_vat: number | null
  vat_amount: number | null
  total_incl_vat: number | null
  currency: string
  allocation_number: string | null
}

export const PROMPT = `This is a document Minuto Café (an Israeli coffee roastery) received from a supplier — usually a Hebrew tax invoice (חשבונית מס), tax invoice-receipt (חשבונית מס קבלה), receipt (קבלה) or credit note (חשבונית זיכוי).

Read it and answer with ONE JSON object and nothing else:
{
  "supplier_name":      the ISSUER's business name as printed (not Minuto, which is the customer), or null,
  "supplier_tax_id":    the issuer's ח.פ / ע.מ / עוסק מורשה number, digits only, or null,
  "invoice_number":     the document number, or null,
  "doc_type":           one of "tax_invoice", "tax_invoice_receipt", "receipt", "credit_note", "transaction_invoice" (חשבון עסקה), "other",
  "invoice_date":       the document date as YYYY-MM-DD (Israeli documents write DD/MM/YYYY), or null,
  "amount_before_vat":  total before VAT (סה"כ לפני מע"מ), a number, or null,
  "vat_amount":         the VAT amount (מע"מ), a number, or null,
  "total_incl_vat":     the final total including VAT (סה"כ לתשלום / סה"כ כולל מע"מ), a number, or null,
  "currency":           "ILS" unless another currency is clearly printed (then its ISO code),
  "allocation_number":  the מספר הקצאה (allocation number, usually 9 digits) if printed, or null
}

Amounts are positive numbers without currency signs or thousands separators. If a value is not printed or you cannot read it, use null — never guess.`

export function buildRequest(mime: string, base64: string): Record<string, unknown> {
  const source = { type: 'base64', media_type: mime, data: base64 }
  const block = mime === 'application/pdf' ? { type: 'document', source } : { type: 'image', source }
  return claudeBody({
    messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
    effort: 'low',
  })
}

export async function extractInvoice(
  apiKey: string, mime: string, base64: string, fetchFn: typeof fetch = fetch,
): Promise<{ fields: InvoiceFields; raw: string }> {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: claudeHeaders(apiKey),
    body: JSON.stringify(buildRequest(mime, base64)),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Claude ${res.status}: ${json?.error?.message ?? 'no body'}`)
  const raw = claudeText(json)
  return { fields: normaliseExtraction(parseJsonObject(raw)), raw }
}

/** The first {...} in the text; tolerates a ```json fence or a stray sentence. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const v = JSON.parse(text.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s && s.toLowerCase() !== 'null' ? s : null
}

export function toAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
  const s = str(v)
  if (!s) return null
  const n = Number(s.replace(/[₪,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

export function toDate(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  let y: number, m: number, d: number
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (match) { y = +match[1]; m = +match[2]; d = +match[3] }
  else {
    match = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/)   // Israeli DD/MM/YYYY
    if (!match) return null
    d = +match[1]; m = +match[2]; y = +match[3]
    if (y < 100) y += 2000
  }
  // A supplier invoice is from this century and not from next year; anything
  // else is a misread (an invoice was saved as year 0006 on 2026-10-22).
  if (y < 2000 || y > new Date().getUTCFullYear() + 1) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const digits = (v: unknown): string | null => {
  const s = str(v)?.replace(/\D/g, '')
  return s ? s : null
}

export function normaliseExtraction(o: Record<string, unknown>): InvoiceFields {
  const docType = DOC_TYPES.includes(o.doc_type as DocType) ? o.doc_type as DocType : 'tax_invoice'
  let before = toAmount(o.amount_before_vat)
  let vat = toAmount(o.vat_amount)
  let total = toAmount(o.total_incl_vat)

  // A credit note reduces what Minuto owes: stored negative, so a month's sum
  // and the later bank/card matching come out right.
  if (docType === 'credit_note') {
    const neg = (n: number | null) => n == null ? n : -Math.abs(n)
    before = neg(before); vat = neg(vat); total = neg(total)
  }
  // Fill in the one missing figure when the other two are printed.
  const r = (n: number) => Math.round(n * 100) / 100
  if (vat == null && before != null && total != null) vat = r(total - before)
  else if (before == null && vat != null && total != null) before = r(total - vat)
  else if (total == null && before != null && vat != null) total = r(before + vat)

  const currency = str(o.currency)?.toUpperCase()
  return {
    supplier_name: str(o.supplier_name),
    supplier_tax_id: digits(o.supplier_tax_id),
    invoice_number: str(o.invoice_number),
    doc_type: docType,
    invoice_date: toDate(o.invoice_date),
    amount_before_vat: before,
    vat_amount: vat,
    total_incl_vat: total,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : 'ILS',
    allocation_number: digits(o.allocation_number),
  }
}
