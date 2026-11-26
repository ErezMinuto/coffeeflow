// One render, one post. Whether a completed IG visual may still parent a new
// instagram_post.
//
// Every instagram_post spends its visual, WHATEVER its status. The checks
// used to skip failed posts, but a post the owner cancels in chat ("Already
// published manually") or rejects is marked failed too. So the cancelled
// visual looked unused again and the mission re-posted the same image:
// visual cbfb53e2 (rendered 2026-11-23) went out as the story on 11-23, 11-25
// and 11-26.
//
// A visual also goes stale. Orphan recovery only offers today's renders, so
// anything older than MAX_VISUAL_AGE_HOURS is yesterday's image and must not
// become today's post.

export const MAX_VISUAL_AGE_HOURS = 24

export interface PriorPost { id: string; status: string; media_type: string | null }

/** Why this visual can't parent another instagram_post, or null when it can. */
export function visualReuseReason(
  priorPosts: PriorPost[],
  visualCreatedAt: string | null,
  now: Date = new Date(),
): string | null {
  const prior = priorPosts[0]
  if (prior) {
    const how = prior.status === 'failed' ? ' (cancelled or failed; the image was still used)' : ''
    return `already has an instagram_post (${prior.media_type ?? 'post'}, ${prior.id}${how})`
  }
  if (visualCreatedAt) {
    const ageH = (now.getTime() - new Date(visualCreatedAt).getTime()) / 3_600_000
    if (Number.isFinite(ageH) && ageH > MAX_VISUAL_AGE_HOURS) {
      return `was rendered ${Math.round(ageH)}h ago (${visualCreatedAt.slice(0, 10)}); a post uses a render from the last ${MAX_VISUAL_AGE_HOURS}h`
    }
  }
  return null
}
