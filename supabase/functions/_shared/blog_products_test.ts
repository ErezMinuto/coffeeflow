// Tests for the Brain's blog-product catalog check.
//
//   deno run --allow-read supabase/functions/_shared/blog_products_test.ts

import { checkBlogProducts } from './blog_products.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const LINEUP = ['אתיופיה יירגשה', 'קולומביה הואילה', 'Aristo Blend']

{
  const r = checkBlogProducts(['אתיופיה יירגשה', ' Aristo  Blend '], LINEUP)
  check('exact names (whitespace-normalised) pass as catalog spelling', r.ok && r.products.join('|') === 'אתיופיה יירגשה|Aristo Blend')
}
check('missing products refused', !checkBlogProducts(undefined, LINEUP).ok)
check('empty products refused', !checkBlogProducts([], LINEUP).ok)
{
  const r = checkBlogProducts(['קפה אתיופיה', 'Aristo Blend'], LINEUP)
  check('an invented name is refused and named', !r.ok && r.error.includes('קפה אתיופיה') && !r.error.includes('"Aristo Blend"'))
}
check('non-string refused', !checkBlogProducts([42], LINEUP).ok)
{
  const r = checkBlogProducts(['Aristo Blend', 'Aristo Blend'], LINEUP)
  check('duplicates collapse', r.ok && r.products.length === 1)
}

// The Brain's schema asks for products and conclude_brief / the executor enforce them.
{
  const tools = await Deno.readTextFile(new URL('../strategist-brain/tools.ts', import.meta.url))
  check('content_blog schema lists products[]', /content_blog: \{[^}]*products\[\]/.test(tools))
  const concl = tools.slice(tools.indexOf('async function handleConcludeBrief'))
  check('conclude_brief checks blog products before inserting the brief',
    concl.indexOf('checkBlogProducts(') > 0 && concl.indexOf('checkBlogProducts(') < concl.indexOf(".from('strategic_briefs')"))
  const exec = await Deno.readTextFile(new URL('../strategist-executor/index.ts', import.meta.url))
  const draft = exec.slice(exec.indexOf('async function draftBlog'))
  check('executor checks blog products before queuing the task',
    draft.indexOf('checkBlogProducts(') > 0 && draft.indexOf('checkBlogProducts(') < draft.indexOf('insertTasks('))
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1) }
console.log('\nall checks passed')
