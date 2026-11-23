// Banner for a blog post exported by the strategist review loop.
//
// The organic-orchestrator path pairs every article with a blog_banner
// visual task when it plans it. The strategist loop (content_blog → writer →
// critic → exportBlog) never did, so every loop article reached WordPress
// with no featured image (83074 on 2026-11-04; the 2026-11-23 matcha drafts).
//
// The banner is queued at export, not at draft time: the critic can send an
// article back two or three times, each a new writer task, and only the
// exported one becomes a post. At export the writer task already carries
// wp_post_id, so seo-worker-visual attaches the image the usual way.

import type { VisualGenerationBrief } from '../seo-agent/types.ts'

export interface BannerSource {
  title:      string
  body:       string
  keyword?:   string
}

export const BANNER_SYSTEM =
  'You write the scene brief for the featured photograph of a blog post by Minuto, ' +
  'an Israeli specialty-coffee roastery. Reply with strict JSON only: {"scene_brief": string}.'

export function bannerPrompt(src: BannerSource): string {
  return [
    `Article title: ${src.title}`,
    src.keyword ? `Target keyword: ${src.keyword}` : '',
    'Article (start):',
    String(src.body ?? '').slice(0, 2500),
    '',
    'Write scene_brief: 4-6 English sentences describing one photograph that illustrates what this article is about, ' +
    'written for a photographer. The render shows no product, so no coffee bags or packaging and no text or logos in frame.',
  ].filter(Boolean).join('\n')
}

/** The scene brief from the model's reply, or null if it is unusable. */
export function parseBannerReply(parsed: unknown): string | null {
  const s = (parsed as { scene_brief?: unknown } | null)?.scene_brief
  if (typeof s !== 'string') return null
  const t = s.trim()
  return t.length >= 40 ? t : null
}

/** Used when the model call fails: the article still gets an image. */
export function fallbackSceneBrief(src: BannerSource): string {
  return `Editorial specialty-coffee photograph illustrating a blog article titled "${src.title}"` +
    (src.keyword ? ` (topic: ${src.keyword})` : '') +
    '. One clear subject, warm natural light, shallow depth of field. No coffee bags, packaging, text or logos in frame.'
}

export function bannerBrief(sceneBrief: string): VisualGenerationBrief {
  return {
    scene_brief: sceneBrief,
    aspect:      'feed_square',
    render_mode: 'no_bag',
    destination: 'blog_banner',
  }
}
