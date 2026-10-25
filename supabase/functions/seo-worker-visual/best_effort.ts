// Pick the banner to attach when the QA loop and every brief regen failed.
//
// The parent post is a WordPress DRAFT that a human reviews before publishing,
// so leaving it with no featured image helps nobody: the reviewer then has to
// dig the attempts out of the queue and attach one by hand (2026-10-25: both
// revived drafts, 82934 and 82937, needed exactly that). Attaching the least-bad
// attempt gives the reviewer something to approve or swap. The task stays
// review_required, so it still shows in the admin queue.
//
// Attempts with a packaging_violation are never picked. Of the rest,
// least bad = fewest subjects missing from the brief, then fewest blocking
// issues. Ties go to the later attempt, since later attempts ran on briefs
// already corrected by earlier critiques.

export interface BestEffortCandidate {
  image_url: string
  critique: { missing: string[]; issues: string[]; packaging_violation?: boolean; _eval_error?: string }
}

export function pickBestEffortAttempt<T extends BestEffortCandidate>(attempts: T[]): T | null {
  let best: T | null = null
  for (const a of attempts) {
    if (!a.image_url) continue
    // An open bag or a special edition in a bag is off-brand, not merely
    // flawed (Erez rejected both on 2026-10-25). Never attach one.
    if (a.critique.packaging_violation) continue
    if (!best || score(a) <= score(best)) best = a
  }
  return best
}

// missing outranks issues: a banner without the brief's subject is further
// from what the writer asked for than one with a flaw in it.
function score(a: BestEffortCandidate): number {
  return a.critique.missing.length * 100 + a.critique.issues.length
}

// WordPress statuses a reviewer still has to act on before the post goes live.
// Anything else (publish, future, private) means a best-effort image would go
// straight onto a live or scheduled post, so it is never attached there.
export const BEST_EFFORT_POST_STATUSES = new Set(['draft', 'pending'])
