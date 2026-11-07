// Time budget for one handleShot run.
//
// History: on the Supabase Free plan the edge runtime killed this worker at
// 150 s with no chance to write anything (HTTP 546; 150.1 s on all three runs
// of task e86b966e, 2026-10-30), so the deadline was 135 s. The org moved to
// Pro after that (wall clock 400 s). What bounds a run now is the cron call:
// pg_net waits 240 s (20260527_seo_worker_visual_cron.sql), so the deadline
// is 220 s, keeping 20 s back for boot, the claim and writing the result.
export const SHOT_DEADLINE_MS = 220_000

// Every plan still has a 150 s request idle timeout: a call that gets no
// response in 150 s ends in a 504. One visual-test call (a single render) must
// answer inside it, whatever is left of the run's budget.
export const HTTP_HOP_MS = 148_000

export function shotBudget(deadlineMs = SHOT_DEADLINE_MS, now: () => number = Date.now) {
  const start = now()
  const remainingMs = () => Math.max(1, deadlineMs - (now() - start))
  return {
    remainingMs,
    // Timeout for one synchronous call to another function.
    hopMs: () => Math.min(HTTP_HOP_MS, remainingMs()),
    // Will one more attempt, about as long as the last one, fit? Measured, not
    // fixed: a published photo takes ~40 s, a generated render ~90 s when the
    // isolate is cold and has to caption the library.
    fits: (lastAttemptMs: number) => lastAttemptMs < remainingMs(),
  }
}
