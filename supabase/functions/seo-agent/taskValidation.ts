// Enqueue-time checks for seo_tasks briefs.
//
// Each rule here is one a worker already enforces as a PERMANENT failure once
// it claims the task (seo-worker-visual, seo-worker-writer,
// organic-worker-instagram). Checking at insert time turns "fails minutes later
// in a worker, nobody notices" into "the planner gets a clear error now and can
// fix the brief". In 14 days before this existed, ~22 of 31 failed tasks were
// exactly these cases.
//
// Rules MIRROR the workers, in the same order the workers branch. If a worker
// changes a rule, change it here too: a rule that is stricter here than in the
// worker blocks valid work; one that is looser just lets the worker catch it,
// as before. Workers keep their own checks as the backstop.

import { isShotType } from '../_shared/shot_library.ts'
import type { NewSeoTask } from './types.ts'

export interface TaskValidationOptions {
  // organic-orchestrator inserts in two passes and wires parent_task_id
  // afterwards, so a missing parent at insert time is expected there. It
  // checks parent_task_index itself before inserting.
  parentLinkedLater?: boolean
  // Override for tests; defaults to the same env var seo-worker-visual reads
  // (edge-function secrets are project-wide, so both see the same value).
  shotLibraryEnabled?: boolean
}

const IG_MEDIA_TYPES = new Set(['feed_image', 'story', 'feed_carousel'])

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

/** Problems with one task's brief, or [] when a worker would accept it. */
export function validateNewTask(task: NewSeoTask, opts: TaskValidationOptions = {}): string[] {
  const shotLibraryEnabled = opts.shotLibraryEnabled
    ?? (Deno.env.get('SHOT_LIBRARY_ENABLED') === 'true')
  const brief = asObject((task as { brief_data?: unknown }).brief_data)

  switch (task.task_type) {
    case 'visual_generation': {
      if (!brief) return ['brief_data must be an object']
      // seo-worker-visual: carousel fork, then shot-library fork, then the
      // single-image checks below.
      if (Array.isArray(brief.slides) && brief.slides.length > 0) return []
      const destination = (brief.destination as string | undefined) ?? 'blog_banner'
      if (destination === 'ig_post' && (isShotType(brief.shot_type) || shotLibraryEnabled)) return []

      const problems: string[] = []
      if (!nonEmpty(brief.scene_brief)) problems.push('brief_data.scene_brief is required (non-empty)')
      const renderMode = (brief.render_mode as string | undefined) ?? 'bag_hero'
      if (renderMode !== 'bag_hero' && renderMode !== 'no_bag') {
        problems.push(`unknown render_mode "${renderMode}" (use "bag_hero" or "no_bag")`)
      } else if (renderMode === 'bag_hero' && !nonEmpty(brief.product_name)) {
        problems.push(
          'render_mode "bag_hero" (the default) requires product_name; ' +
          'for a product-free visual set render_mode:"no_bag"',
        )
      }
      // The most common real failure: a product-free IG visual that names a
      // shot_type but forgets destination, so it falls through to this blog
      // banner path and defaults to bag_hero. A hint only, never a rejection
      // of its own: the worker accepts a banner brief that carries a stray
      // shot_type, so this file must too.
      if (problems.length > 0 && isShotType(brief.shot_type) && destination !== 'ig_post') {
        problems.unshift(
          `shot_type "${brief.shot_type}" is only used when destination is "ig_post" ` +
          `(destination is "${destination}"); for an Instagram visual set destination:"ig_post"`,
        )
      }
      return problems
    }

    case 'text_generation': {
      // seo-worker-writer validateBrief
      if (!brief) return ['brief_data must be an object']
      const problems: string[] = []
      if (!nonEmpty(brief.keyword)) problems.push('brief.keyword is required')
      if (!nonEmpty(brief.title)) problems.push('brief.title is required')
      if (!Array.isArray(brief.key_points) || brief.key_points.length === 0) {
        problems.push('brief.key_points must be a non-empty array')
      }
      return problems
    }

    case 'instagram_post': {
      // organic-worker-instagram, in its order
      const problems: string[] = []
      if (!nonEmpty(brief?.caption_he)) problems.push('caption_he is required (non-empty)')
      const mediaType = (brief?.media_type as string | undefined) ?? 'feed_image'
      if (!IG_MEDIA_TYPES.has(mediaType)) {
        problems.push(`media_type "${mediaType}" is not supported (use feed_image, story or feed_carousel)`)
      }
      if (!opts.parentLinkedLater && !nonEmpty(task.parent_task_id)) {
        problems.push('instagram_post requires parent_task_id: the visual_generation task that produces the image')
      }
      return problems
    }

    default:
      return []
  }
}

export class InvalidTaskError extends Error {
  constructor(readonly problems: Array<{ index: number; task_type: string; problems: string[] }>) {
    super(
      'task brief rejected before queueing: ' +
      problems.map((p) => `#${p.index} ${p.task_type}: ${p.problems.join('; ')}`).join(' | '),
    )
    this.name = 'InvalidTaskError'
  }
}
