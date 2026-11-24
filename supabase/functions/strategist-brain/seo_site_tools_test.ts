// deno run -A supabase/functions/strategist-brain/seo_site_tools_test.ts
// The proposal gate (off switch, per-run cap counted for the whole batch,
// duplicate pending proposals) against a fake Supabase.
import { gate, settings } from './seo_site_tools.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** A fake client: ops_profile value, how many proposals this run already filed, and which targets have one waiting. */
function fakeDb(opts: { value?: unknown; filed?: number; pending?: Array<[string, number]> }) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q },
        limit: () => q,
        maybeSingle: async () => ({ data: table === 'ops_profile' && opts.value !== undefined ? { value: opts.value } : null }),
        then: (resolve: (v: unknown) => void) => {
          if (table === 'site_change_log' && 'requested_by' in filters) return resolve({ count: opts.filed ?? 0 })
          const hit = (opts.pending ?? []).find(([t, id]) => t === filters.target_type && id === filters.target_id)
          return resolve({ data: hit ? [{ id: 'pending-1' }] : [] })
        },
      }
      return q
    },
  }
}
const ctx = { runId: 'run-1' }
const one = [{ target_type: 'term_description', target_id: 379 }]

check('missing setting → switched off', (await settings(fakeDb({}))).enabled === false)
check('default cap 6, capped at 20', (await settings(fakeDb({ value: { enabled: true } }))).max === 6 && (await settings(fakeDb({ value: { enabled: true, max_per_run: 99 } }))).max === 20)
check('off → refused', (await gate(fakeDb({ value: { enabled: false } }), ctx, one))?.includes('switched off') === true)
check('on, nothing filed, no duplicate → allowed', (await gate(fakeDb({ value: { enabled: true, max_per_run: 6 } }), ctx, one)) === null)
check('cap reached → refused', (await gate(fakeDb({ value: { enabled: true, max_per_run: 6 }, filed: 6 }), ctx, one))?.includes('at most 6') === true)
const three = [{ target_type: 'term_seo_meta', target_id: 379 }, { target_type: 'term_description', target_id: 379 }, { target_type: 'product_status', target_id: 5 }]
check('a batch of 3 with 5 already filed (cap 6) → refused as a whole', (await gate(fakeDb({ value: { enabled: true, max_per_run: 6 }, filed: 5 }), ctx, three))?.includes('adds 3') === true)
check('a batch of 3 with 3 already filed (cap 6) → allowed', (await gate(fakeDb({ value: { enabled: true, max_per_run: 6 }, filed: 3 }), ctx, three)) === null)
check('a waiting proposal for the same target → refused', (await gate(fakeDb({ value: { enabled: true }, pending: [['term_description', 379]] }), ctx, one))?.includes('already waiting') === true)
check('a waiting proposal for another target does not block', (await gate(fakeDb({ value: { enabled: true }, pending: [['term_description', 1]] }), ctx, one)) === null)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
