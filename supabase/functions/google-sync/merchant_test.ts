// deno test supabase/functions/google-sync/merchant_test.ts
import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { accountIdFromName, classifyMerchantError, productRow, resolveAccountId, MerchantError } from './merchant.ts'

Deno.test('accountIdFromName parses accounts/{id} only', () => {
  assertEquals(accountIdFromName('accounts/123456'), '123456')
  assertEquals(accountIdFromName('accounts/12/products/x'), null)
  assertEquals(accountIdFromName(undefined), null)
})

Deno.test('classifyMerchantError tells set-up problems from failures', () => {
  assertEquals(classifyMerchantError(401, '{"error":{"status":"UNAUTHENTICATED","message":"GCP project with id x and number 1 is not registered with the merchant account."}}'), 'not_registered')
  assertEquals(classifyMerchantError(403, '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}'), 'no_permission')
  assertEquals(classifyMerchantError(500, 'backend error'), 'error')
  assertEquals(classifyMerchantError(401, 'invalid credentials'), 'error')
})

Deno.test('productRow maps status, issues and worst severity', () => {
  const row = productRow({
    name: 'accounts/9/products/he~IL~sku-1', offerId: 'sku-1', contentLanguage: 'he', feedLabel: 'IL',
    productAttributes: { title: 'Brazil', link: 'https://minuto.co.il/p/brazil', availability: 'IN_STOCK' },
    productStatus: {
      destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: [], disapprovedCountries: ['IL'] }, { reportingContext: 'FREE_LISTINGS', approvedCountries: ['IL'] }],
      itemLevelIssues: [{ code: 'missing_gtin', severity: 'NOT_IMPACTED' }, { code: 'price_mismatch', severity: 'DISAPPROVED', reportingContext: 'SHOPPING_ADS' }, { code: 'odd', severity: 'SOMETHING_NEW' }],
      googleExpirationDate: '2026-12-20T00:00:00Z',
    },
  }, '9')!
  assertEquals(row.offer_id, 'sku-1')
  assertEquals(row.title, 'Brazil')
  assertEquals(row.worst_severity, 'DISAPPROVED')
  assertEquals(row.approved_anywhere, true)
  assertEquals(row.disapproved_anywhere, true)
  assertEquals(row.destination_statuses[1].pendingCountries, [])
  assertEquals(row.item_issues.length, 3)
  assertEquals(row.google_expires_at, '2026-12-20T00:00:00Z')
})

Deno.test('productRow: no status → NONE, no name → null, offerId falls back to the name', () => {
  const row = productRow({ name: 'accounts/9/products/he~IL~sku-2' }, '9')!
  assertEquals(row.worst_severity, 'NONE')
  assertEquals(row.offer_id, 'sku-2')
  assertEquals(row.approved_anywhere, false)
  assertEquals(productRow({}, '9'), null)
})

Deno.test('resolveAccountId: GOOGLE_MERCHANT_ID wins and must be digits', async () => {
  assertEquals(await resolveAccountId('t', ' 555 '), '555')
  let problem = ''
  try { await resolveAccountId('t', 'abc') } catch (e) { problem = (e as MerchantError).problem }
  assertEquals(problem, 'no_account')
})
