// qa-model-backtest.ts — validate switching the visual QA model (Sonnet -> Haiku)
// before flipping the live gate in seo-worker-visual/evaluateVisual().
//
// READ-ONLY: only SELECTs from seo_tasks and calls the Anthropic API. Writes
// nothing, deploys nothing, touches no live function.
//
// What it does: pulls the most recent completed visual_generation tasks, takes
// each rendered image + the brief that produced it, and runs the SAME QA prompt
// production uses against BOTH models. Reports pass/fail agreement so you can
// decide whether Haiku is a safe, cheaper judge.
//
// Run (Deno):
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... ANTHROPIC_API_KEY=sk-ant-... \
//     deno run --allow-net --allow-env scripts/qa-model-backtest.ts [limit]
//
// Optional env: SUPABASE_URL (defaults to prod), QA_BASELINE_MODEL, QA_CANDIDATE_MODEL.

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? 'https://ytydgldyeygpzmlxvpvb.supabase.co'
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const BASELINE  = Deno.env.get('QA_BASELINE_MODEL')  ?? 'claude-sonnet-4-6'  // current prod
const CANDIDATE = Deno.env.get('QA_CANDIDATE_MODEL') ?? 'claude-haiku-4-5'   // proposed
const LIMIT = Number(Deno.args[0] ?? '40')

if (!SERVICE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY and/or ANTHROPIC_API_KEY in env.')
  Deno.exit(1)
}

// Exact production QA prompt — keep in sync with seo-worker-visual VISUAL_EVAL_SYSTEM_PROMPT.
const VISUAL_EVAL_SYSTEM_PROMPT = `You are a strict visual QA agent for Minuto's blog banner pipeline. Given a rendered image and the photographer's brief that produced it, decide whether the image satisfies the brief.

You are STRICT on subject completeness. If the brief named multiple concrete subjects (e.g. "espresso machine" AND "coffee bag"), all of them must appear in frame. Missing a named subject is a hard FAIL even if the image is otherwise beautiful.

You are LENIENT on stylistic interpretation. The brief specifies a mood / palette / composition; minor reinterpretation is fine.

Output STRICT JSON (no markdown fences, no preamble):
{
  "passes": true | false,
  "missing": ["concrete subject from the brief that didn't appear", "..."],
  "issues": ["other quality problems — gibberish text, wrong product, weird artifacts, etc.", "..."],
  "suggested_adjustment": "one sentence telling the next render exactly what to include / fix"
}

If passes=true, missing and issues should both be empty arrays and suggested_adjustment should be an empty string.`

interface EvalItem { taskId: string; imageUrl: string; sceneBrief: string; renderMode: string; productName?: string; kind: 'single' | 'slide' }

function extractJson(text: string): { passes?: unknown } {
  const cleaned = text.replace(/```json\n?|```\n?/g, '').trim()
  const m = cleaned.match(/\{[\s\S]*\}/)
  try { return m ? JSON.parse(m[0]) : {} } catch { return {} }
}

async function fetchVisualTasks(limit: number): Promise<any[]> {
  const url = `${SUPABASE_URL}/rest/v1/seo_tasks` +
    `?task_type=eq.visual_generation&status=eq.completed` +
    `&select=id,brief_data,result_data,created_at&order=created_at.desc&limit=${limit}`
  const res = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })
  if (!res.ok) throw new Error(`seo_tasks fetch ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return await res.json()
}

// Flatten each task into one-or-many (image, brief) eval items (single image or carousel slides).
function toEvalItems(tasks: any[]): EvalItem[] {
  const items: EvalItem[] = []
  for (const t of tasks) {
    let brief = t.brief_data; if (typeof brief === 'string') { try { brief = JSON.parse(brief) } catch { brief = {} } }
    let result = t.result_data; if (typeof result === 'string') { try { result = JSON.parse(result) } catch { result = {} } }
    const renderMode = brief?.render_mode ?? 'bag_hero'
    const productName = brief?.product_name

    if (Array.isArray(result?.carousel_slides) && result.carousel_slides.length > 0) {
      const slideBriefs = Array.isArray(brief?.slides) ? brief.slides : []
      result.carousel_slides.forEach((s: any, i: number) => {
        const url = s?.image_url ?? s
        const sb = slideBriefs[i]?.scene_brief ?? brief?.scene_brief
        if (typeof url === 'string' && typeof sb === 'string' && sb.trim()) {
          items.push({ taskId: t.id, imageUrl: url, sceneBrief: sb, renderMode, productName, kind: 'slide' })
        }
      })
    } else if (typeof result?.image_url === 'string' && typeof brief?.scene_brief === 'string') {
      items.push({ taskId: t.id, imageUrl: result.image_url, sceneBrief: brief.scene_brief, renderMode, productName, kind: 'single' })
    }
  }
  return items
}

async function qaPasses(model: string, item: EvalItem): Promise<boolean | null> {
  const userText = `BRIEF (render_mode=${item.renderMode}${item.productName ? `, product_name="${item.productName}"` : ''}):\n\n${item.sceneBrief}\n\nEvaluate the attached image against this brief. Output strict JSON only.`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 600, temperature: 0,
      system: VISUAL_EVAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: item.imageUrl } },
        { type: 'text', text: userText },
      ] }],
    }),
  })
  if (!res.ok) { console.warn(`  ! ${model} ${res.status} on ${item.imageUrl.slice(-24)}: ${(await res.text()).slice(0, 120)}`); return null }
  const json = await res.json()
  return extractJson(json.content?.[0]?.text ?? '{}').passes === true
}

// Limited-concurrency map so we don't hammer the rate limit.
async function pmap<T, R>(arr: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(arr.length); let idx = 0
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (idx < arr.length) { const i = idx++; out[i] = await fn(arr[i], i) }
  }))
  return out
}

console.log(`Pulling up to ${LIMIT} completed visual tasks from ${SUPABASE_URL} ...`)
const tasks = await fetchVisualTasks(LIMIT)
const items = toEvalItems(tasks)
console.log(`-> ${tasks.length} tasks, ${items.length} (image, brief) pairs to score on ${BASELINE} vs ${CANDIDATE}\n`)
if (items.length === 0) { console.log('No scorable images found. Nothing to compare.'); Deno.exit(0) }

let agree = 0, baselinePass = 0, candidatePass = 0, errors = 0
const disagreements: Array<{ item: EvalItem; base: boolean | null; cand: boolean | null }> = []

const verdicts = await pmap(items, 4, async (item) => {
  const [base, cand] = await Promise.all([qaPasses(BASELINE, item), qaPasses(CANDIDATE, item)])
  return { item, base, cand }
})

for (const v of verdicts) {
  if (v.base === null || v.cand === null) { errors++; continue }
  if (v.base) baselinePass++
  if (v.cand) candidatePass++
  if (v.base === v.cand) agree++; else disagreements.push(v)
}

const scored = items.length - errors
const agreePct = scored ? ((agree / scored) * 100).toFixed(1) : '0'
console.log('──────────── RESULTS ────────────')
console.log(`scored:                ${scored}/${items.length} (errors: ${errors})`)
console.log(`agreement:             ${agree}/${scored}  (${agreePct}%)`)
console.log(`${BASELINE} pass rate:  ${baselinePass}/${scored}`)
console.log(`${CANDIDATE} pass rate: ${candidatePass}/${scored}`)
console.log(`disagreements:         ${disagreements.length}`)
if (disagreements.length) {
  console.log('\nDisagreements (eyeball these images — which model is right?):')
  for (const d of disagreements) {
    console.log(`  [${d.item.kind}] task ${d.item.taskId.slice(0, 8)} | ${BASELINE}=${d.base ? 'PASS' : 'fail'} ${CANDIDATE}=${d.cand ? 'PASS' : 'fail'}`)
    console.log(`      ${d.item.imageUrl}`)
  }
}
console.log('\n──────────── READ ────────────')
const candRej = scored - candidatePass, baseRej = scored - baselinePass
console.log(`• Want agreement >= ~90%. Got ${agreePct}%.`)
console.log(`• Candidate over-rejecting? ${CANDIDATE} failed ${candRej} vs ${BASELINE} ${baseRej}.` +
  (candRej > baseRej ? `  (+${candRej - baseRej} extra rejects -> would RAISE render cost)` : '  (not over-rejecting)'))
console.log(`• Candidate too lenient? Look at disagreements where ${CANDIDATE}=PASS but ${BASELINE}=fail — those are auto-publish risks.`)
