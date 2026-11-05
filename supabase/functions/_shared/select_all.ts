// Read every row of a PostgREST query, page by page.
//
// PostgREST caps each response at the project's max-rows (1,000 on Supabase),
// whatever .limit() asks for, and says nothing when it does. A reader that sums
// rows from one request therefore sums an arbitrary first page. This walks
// .range() pages until a page comes back empty, so it is correct for any server
// cap. The query must have a stable order (order by a unique column, e.g. id),
// or rows can repeat or be skipped between pages.
//
//   const rows = await selectAll((from, to) =>
//     supabase.from('t').select('a, b').gte('date', since).order('id').range(from, to))

// deno-lint-ignore no-explicit-any
type Page<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>

export async function selectAll<T>(page: Page<T>, opts: { pageSize?: number; maxRows?: number; label?: string } = {}): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000
  const maxRows = opts.maxRows ?? 200_000
  const out: T[] = []
  for (;;) {
    const { data, error } = await page(out.length, out.length + pageSize - 1)
    if (error) throw new Error(`${opts.label ?? 'select'} failed at row ${out.length}: ${error.message ?? String(error)}`)
    const rows = data ?? []
    if (!rows.length) return out
    out.push(...rows)
    // Fail loudly rather than return a silently truncated result.
    if (out.length > maxRows) throw new Error(`${opts.label ?? 'select'}: more than ${maxRows} rows, refusing to aggregate a partial read`)
  }
}
