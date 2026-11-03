// One-run-at-a-time leases for background jobs (job_leases table, migration
// 20261024c_job_leases). A lease survives across the many requests of a
// background cycle, unlike an advisory lock, and a hard-killed run loses it when
// it expires. Service role only.

type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }

export type LeaseResult = { held: true } | { held: false; error?: string }

export async function acquireLease(supabase: RpcClient, name: string, holder: string, ttlSeconds: number): Promise<LeaseResult> {
  const { data, error } = await supabase.rpc('acquire_job_lease', { p_name: name, p_holder: holder, p_ttl_seconds: ttlSeconds })
  if (error) return { held: false, error: error.message }
  return data === true ? { held: true } : { held: false }
}

export async function releaseLease(supabase: RpcClient, name: string, holder: string): Promise<void> {
  const { error } = await supabase.rpc('release_job_lease', { p_name: name, p_holder: holder })
  // Not fatal: the lease expires on its own.
  if (error) console.warn(`[job_lease] release ${name} by ${holder} failed (expires on its own): ${error.message}`)
}
