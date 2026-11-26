import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { visualReuseReason } from './visual_reuse.ts'

const now = new Date('2026-11-26T00:03:00Z')

Deno.test('fresh, unposted visual may be posted', () => {
  assertEquals(visualReuseReason([], '2026-11-25T23:50:00Z', now), null)
})

Deno.test('a visual with a live post is spent', () => {
  const r = visualReuseReason([{ id: 'p1', status: 'completed', media_type: 'story' }], '2026-11-25T23:50:00Z', now)
  assertStringIncludes(r ?? '', 'already has an instagram_post (story, p1)')
})

Deno.test('a post cancelled in chat (status failed) still spends the visual', () => {
  // The 2026-11-23..26 repeat: the cancelled post left the image looking unused.
  const r = visualReuseReason([{ id: 'p2', status: 'failed', media_type: 'story' }], '2026-11-25T23:50:00Z', now)
  assertStringIncludes(r ?? '', 'cancelled or failed')
})

Deno.test('a render older than 24h is stale even if never posted', () => {
  const r = visualReuseReason([], '2026-11-23T01:03:04Z', now)
  assertStringIncludes(r ?? '', 'rendered 71h ago')
})

Deno.test('unknown render time does not block', () => {
  assertEquals(visualReuseReason([], null, now), null)
})
