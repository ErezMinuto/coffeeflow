// Drop the dependents of plan tasks that a queue-time gate refused.
//
// The cannibalization, story-lock and brand gates convert a refused task IN
// PLACE into a dynamic_experiment proposal. Its dependents were left alone,
// so a blog_banner whose article was refused still shipped, pointing at a
// parent that never becomes an article: approving the proposal only flips it
// to 'completed', and nothing ever writes a post. seo-worker-visual deferred
// those banners for weeks waiting on the 'pending' proposal. 2026-08-26 →
// 09-16, ten of them also carried Veneto Delux as bag_hero (the planner chose
// it before the 09-23 catalog filter). All ten failed at once on the brand
// guard on 09-23, and every one of them was an orphan with no post.
//
// Pure, so the orchestrator stays the only place that touches the DB.

export interface CascadeTask {
  task_type: string
  parent_task_index?: number
  depends_on_index?: number
}

export interface CascadeResult<T> {
  /** Surviving tasks, with parent/depends indexes remapped to the new positions. */
  kept: T[]
  /** Removed dependents. `refusedIndex` is the ORIGINAL index of the refused ancestor. */
  dropped: Array<{ task: T; originalIndex: number; refusedIndex: number }>
}

// `refused` holds ORIGINAL indexes of tasks a gate converted. Refused tasks
// themselves are kept (they are proposals the admin sees); anything that
// points at one, directly or through another dropped task, is removed.
export function dropDependentsOfRefused<T extends CascadeTask>(
  tasks: T[],
  refused: Set<number>,
): CascadeResult<T> {
  // rootOf[i] = the refused ancestor that dooms task i, or -1.
  const rootOf = new Array<number>(tasks.length).fill(-1)
  const resolve = (i: number, seen: Set<number>): number => {
    if (rootOf[i] !== -1) return rootOf[i]
    if (seen.has(i)) return -1                        // a cycle in the plan, not ours to judge
    seen.add(i)
    for (const ref of [tasks[i].parent_task_index, tasks[i].depends_on_index]) {
      if (typeof ref !== 'number' || ref < 0 || ref >= tasks.length || ref === i) continue
      if (refused.has(ref)) return (rootOf[i] = ref)
      const up = resolve(ref, seen)
      if (up !== -1) return (rootOf[i] = up)
    }
    return -1
  }
  for (let i = 0; i < tasks.length; i++) if (!refused.has(i)) resolve(i, new Set())

  const newIndex = new Map<number, number>()
  const keptOld: number[] = []
  const dropped: CascadeResult<T>['dropped'] = []
  tasks.forEach((t, i) => {
    if (!refused.has(i) && rootOf[i] !== -1) {
      dropped.push({ task: t, originalIndex: i, refusedIndex: rootOf[i] })
    } else {
      newIndex.set(i, keptOld.length)
      keptOld.push(i)
    }
  })

  const remap = (ref: number | undefined) =>
    typeof ref === 'number' ? newIndex.get(ref) : undefined
  const kept = keptOld.map(i => {
    const t = { ...tasks[i] }
    const p = remap(t.parent_task_index)
    const d = remap(t.depends_on_index)
    if (p === undefined) delete t.parent_task_index; else t.parent_task_index = p
    if (d === undefined) delete t.depends_on_index;  else t.depends_on_index  = d
    return t
  })
  return { kept, dropped }
}
