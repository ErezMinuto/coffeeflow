// Time budget for one handleShot run. The edge runtime kills this worker at
// 150 s with no chance to write anything (HTTP 546; 150.1 s on all three runs
// of task e86b966e, 2026-10-30). The row then looks like a crash, and an image
// that was already rendered is lost. 15 s of the limit is kept back for boot,
// the claim, and writing the result.
export const SHOT_DEADLINE_MS = 135_000

export function shotBudget(deadlineMs = SHOT_DEADLINE_MS, now: () => number = Date.now) {
  const start = now()
  const remainingMs = () => Math.max(1, deadlineMs - (now() - start))
  return {
    remainingMs,
    // Will one more attempt, about as long as the last one, fit? Measured, not
    // fixed: a published photo takes ~40 s, a generated render ~90 s when the
    // isolate is cold and has to caption the library.
    fits: (lastAttemptMs: number) => lastAttemptMs < remainingMs(),
  }
}
