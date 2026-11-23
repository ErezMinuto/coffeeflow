// deno run -A supabase/functions/strategist-brain/tools_schema_test.ts
//
// The strategist runs on Gemini in production (MODEL_STRATEGIST secret), and
// Gemini rejects some JSON-schema forms Claude accepts. On 2026-11-23 a
// `type: ['number', 'null']` in conclude_brief made every step fail with a 400
// before the model ran. This walks every tool schema for forms Gemini refuses.
import { BRAIN_TOOLS } from './tools.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const problems: string[] = []
function walk(node: unknown, path: string) {
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return }
  if (!node || typeof node !== 'object') return
  const o = node as Record<string, unknown>
  if (Array.isArray(o.type)) problems.push(`${path}.type is a union ${JSON.stringify(o.type)}`)
  for (const k of ['oneOf', 'anyOf', 'allOf', '$ref', 'const', 'patternProperties']) if (k in o) problems.push(`${path} uses ${k}`)
  if (o.type === 'array' && !o.items) problems.push(`${path} is an array without items`)
  if (o.enum && (!Array.isArray(o.enum) || o.enum.some((v) => typeof v !== 'string'))) problems.push(`${path}.enum must be strings`)
  for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, `${path}.${k}`)
}
for (const t of BRAIN_TOOLS) walk(t.input_schema, t.name)

check('every strategist tool schema is Gemini-compatible', problems.length === 0, problems.join('; '))
check('tool names are unique', new Set(BRAIN_TOOLS.map((t) => t.name)).size === BRAIN_TOOLS.length)
check('the SEO audit tools are registered', ['get_seo_audit_overview', 'get_seo_issue_pages', 'get_search_page_map', 'get_page_report'].every((n) => BRAIN_TOOLS.some((t) => t.name === n)))

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
