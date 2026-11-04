// Behaviour tests for the invoice inbox (inbound_invoices.ts), with fake
// Resend / storage / database — nothing leaves the process.
//
//   deno run --allow-env supabase/functions/resend-webhook/inbound_invoices_test.ts
import {
  attachmentMime, bareAddress, findStaff, handleInboundInvoices, isForInbox, pickAttachments,
  senderAuthenticated,
} from './inbound_invoices.ts'
import type { Logger } from '../_shared/logger.ts'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) failures++
}

const INBOX = 'invoices@in.minuto.co.il'

// ── pure helpers ─────────────────────────────────────────────────────────────
check('bareAddress strips the display name', bareAddress('Erez <Erez@Minuto.co.il>') === 'erez@minuto.co.il')
check('bareAddress keeps a bare address', bareAddress(' a@b.co ') === 'a@b.co')
check('inbox matched in to', isForInbox({ to: ['Invoices@in.minuto.co.il'] }, INBOX))
check('inbox matched in received_for (auto-forward)', isForInbox({ to: ['erez@minuto.co.il'], received_for: [INBOX] }, INBOX))
check('other address at the subdomain is not the inbox', !isForInbox({ to: ['hello@in.minuto.co.il'] }, INBOX))
check('DKIM pass is enough', senderAuthenticated({ spf: 'fail', dkim: 'pass', dmarc: 'gray' }))
check('DMARC pass is enough', senderAuthenticated({ spf: 'pass', dkim: 'gray', dmarc: 'pass' }))
check('SPF alone is not enough', !senderAuthenticated({ spf: 'pass', dkim: 'gray', dmarc: 'gray' }))
check('no authentication → refused', !senderAuthenticated(null))

const roles = [
  { user_id: 'u_admin', email: 'Erez@minuto.co.il', full_name: 'Erez', role: 'admin' },
  { user_id: 'u_book', email: 'books@acct.co.il', full_name: 'Books', role: 'bookkeeper' },
  { user_id: 'u_emp', email: null, full_name: 'No email', role: 'employee' },
]
check('staff found case-insensitively', findStaff(roles, 'erez@MINUTO.co.il')?.user_id === 'u_admin')
check('bookkeeper is not staff', findStaff(roles, 'books@acct.co.il') === null)
check('unknown sender', findStaff(roles, 'x@evil.com') === null)

check('pdf by content type', attachmentMime('application/pdf', 'a') === 'application/pdf')
check('pdf by extension when octet-stream', attachmentMime('application/octet-stream', 'INV.PDF') === 'application/pdf')
check('image/jpg normalised', attachmentMime('image/jpg; name=a.jpg', 'a.jpg') === 'image/jpeg')
check('heic not supported', attachmentMime('image/heic', 'a.heic') === null)

const picks = pickAttachments([
  { id: '1', filename: 'inv.pdf', content_type: 'application/pdf', size: 120_000 },
  { id: '2', filename: 'logo.png', content_type: 'image/png', content_disposition: 'inline', size: 8_000 },
  { id: '3', filename: 'sig.jpg', content_type: 'image/jpeg', content_disposition: 'inline', size: 30_000 },
  { id: '4', filename: 'photo.jpg', content_type: 'image/jpeg', content_disposition: 'inline', size: 900_000 },
  { id: '5', filename: 'big.pdf', content_type: 'application/pdf', size: 11 * 1024 * 1024 },
  { id: '6', filename: 'a.zip', content_type: 'application/zip', size: 5000 },
])
const why = (id: string) => { const p = picks.find((x) => x.att.id === id)!; return 'skip' in p ? p.skip : p.mime }
check('pdf taken', why('1') === 'application/pdf')
check('tiny logo skipped', why('2') === 'tiny_image')
check('inline signature skipped', why('3') === 'inline_logo')
check('large inline photo taken', why('4') === 'image/jpeg')
check('over 10MB skipped', why('5') === 'too_large')
check('zip skipped', why('6') === 'unsupported_type')
const many = pickAttachments(Array.from({ length: 12 }, (_, i) => ({ id: String(i), filename: `${i}.pdf`, content_type: 'application/pdf', size: 1000 })))
check('at most 10 files per email', many.filter((p) => 'mime' in p).length === 10)

// ── end to end, with fakes ───────────────────────────────────────────────────
const PDF = new TextEncoder().encode('%PDF-1.4\nfake invoice body ' + 'x'.repeat(200))

function fakeLogger(): Logger & { events: string[] } {
  const events: string[] = []
  const l: any = {
    runId: 'run-test', events,
    debug: (e: string) => events.push(e), info: (e: string) => events.push(e),
    warn: (e: string) => events.push(e), error: (e: string) => events.push(e),
    finish: async () => {}, flush: async () => {},
  }
  return l
}

function fakeSupabase() {
  const inserted: any[] = []
  const uploads: string[] = []
  const query = (table: string) => {
    const q: any = {
      _t: table, _filters: {} as Record<string, unknown>, _insert: null as any,
      select() { return q }, eq(k: string, v: unknown) { q._filters[k] = v; return q },
      neq() { return q }, is() { return q }, order() { return q }, limit() { return q },
      update() { return q },
      insert(row: any) { q._insert = row; return q },
      async maybeSingle() {
        if (table === 'supplier_invoices') return { data: inserted.find((r) => r.file_sha256 === q._filters.file_sha256) ?? null, error: null }
        if (table === 'user_roles') return { data: { full_name: 'Erez', email: 'erez@minuto.co.il' }, error: null }
        return { data: null, error: null }
      },
      async single() {
        if (q._insert) { const row = { id: `inv-${inserted.length + 1}`, ...q._insert }; inserted.push(row); return { data: row, error: null } }
        return { data: null, error: null }
      },
      then(res: any) {   // awaited directly: user_roles list, duplicate candidates
        if (table === 'user_roles') return res({ data: roles, error: null })
        return res({ data: [], error: null })
      },
    }
    return q
  }
  return {
    inserted, uploads,
    from: query,
    storage: { from: () => ({
      upload: async (p: string) => { uploads.push(p); return { error: null } },
      remove: async () => ({ error: null }),
    }) },
  }
}

function fakeFetch(email: Record<string, unknown>, attachments: unknown[]) {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/attachments')) return j({ object: 'list', data: attachments })
    if (url.includes('/emails/receiving/')) return j(email)
    if (url.startsWith('https://cdn.test/')) return new Response(PDF, { status: 200 })
    if (url.includes('api.anthropic.com')) {
      return j({ content: [{ type: 'text', text: '{"supplier_name":"Kedma","invoice_number":"18067","doc_type":"tax_invoice","invoice_date":"2026-10-21","total_incl_vat":100}' }] })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fn, calls }
}

const goodEmail = {
  id: 'em1', from: 'erez@minuto.co.il', subject: 'Fwd: חשבונית 18067',
  authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
}
const atts = [
  { id: 'a1', filename: 'inv.pdf', content_type: 'application/pdf', size: PDF.length, download_url: 'https://cdn.test/a1' },
  { id: 'a2', filename: 'logo.png', content_type: 'image/png', content_disposition: 'inline', size: 4000, download_url: 'https://cdn.test/a2' },
]

// The extractor calls fetch globally — route it through the fake too.
async function run(email: Record<string, unknown>, list: unknown[], sb = fakeSupabase()) {
  const f = fakeFetch(email, list)
  const realFetch = globalThis.fetch
  globalThis.fetch = f.fn
  try {
    const log = fakeLogger()
    const r = await handleInboundInvoices('em1', { supabase: sb, log, resendKey: 're_test', anthropicKey: 'sk-test', fetchFn: f.fn })
    return { r, sb, log, calls: f.calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

{
  const { r, sb } = await run(goodEmail, atts)
  check('staff + DKIM → pdf stored', r.code === 'stored' && r.stored.length === 1, JSON.stringify(r))
  const row = sb.inserted[0]
  check('stored under the sender', row?.uploaded_by === 'u_admin' && row?.uploaded_by_name === 'Erez')
  check('stored as the extracted supplier', row?.supplier_name === 'Kedma' && row?.invoice_number === '18067')
  check('source recorded', row?.extraction?.source?.channel === 'email' && row?.extraction?.source?.email_id === 'em1')
  check('logo skipped, not stored', r.skipped.some((s) => s.filename === 'logo.png') && sb.uploads.length === 1)
}
{
  const sb = fakeSupabase()
  await run(goodEmail, atts, sb)
  const { r } = await run(goodEmail, atts, sb)
  check('same email again → identical file refused, not stored twice',
    r.code === 'nothing_stored' && r.failed === 0 && r.skipped.some((s) => s.reason === 'duplicate_file') && sb.inserted.length === 1,
    JSON.stringify(r))
}
{
  const { r, sb, calls } = await run({ ...goodEmail, from: 'stranger@gmail.com' }, atts)
  check('unknown sender → nothing stored', r.code === 'not_staff' && sb.inserted.length === 0)
  check('unknown sender → attachments never downloaded', !calls.some((c) => c.includes('cdn.test') || c.endsWith('/attachments')))
}
{
  const { r, sb } = await run({ ...goodEmail, authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } }, atts)
  check('forged staff From (DKIM/DMARC fail) → nothing stored', r.code === 'not_authenticated' && sb.inserted.length === 0)
}
{
  const { r } = await run(goodEmail, [])
  check('no attachments → reported', r.code === 'no_attachments')
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed')
if (failures) Deno.exit(1)
