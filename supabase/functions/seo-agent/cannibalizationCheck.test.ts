// Run with: deno test --allow-env --allow-read supabase/functions/seo-agent/cannibalizationCheck.test.ts
// (--allow-env because the module reads WP creds at load; --allow-read for the fixture.)
//
// Replays the blog's real history. The fixture is every published post on
// minuto.co.il as of 2026-10-12. Each case scores an article the agent
// actually wrote against only the posts that existed BEFORE it, the same
// view the gate would have had when the article was queued.
//
// The 'dup' cases all went live as duplicates under the old gate (WP
// `?search=` + exact tokens), which caught none of them. The 'clean' cases
// are distinct topics that must keep passing, including the template trap
// (Clever Dripper vs AeroPress share a title template, not a topic).

import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { findConflicts, type IndexedPost } from './cannibalizationCheck.ts'

type FixturePost = { id: number; date: string; title: string; slug: string }
const fixture = JSON.parse(
  Deno.readTextFileSync(new URL('./testdata/blog_posts_2026-10-12.json', import.meta.url)),
) as FixturePost[]

function before(date: string): IndexedPost[] {
  return fixture
    .filter(p => p.date < date)
    .map(p => ({ id: p.id, title: p.title, slug: p.slug, status: 'publish', link: '' }))
}

const THRESHOLD = 0.6

// [keyword, intended title, date queued, ids it duplicates]
const DUPLICATES: [string, string, string, number[]][] = [
  ['פולי קפה למכונת אספרסו ביתית', 'איזה פולי קפה מתאימים למכונת אספרסו ביתית, המדריך לפי סוג מכונה וטעם', '2026-07-22', [80764]],
  ['כיוון טחינה לפי שיטת חליטה', 'כיוון טחינה לפי שיטת חליטה: המדריך המעשי לאספרסו, פילטר, פרנץ\' פרס וקולד ברו', '2026-07-29', [80740]],
  ['מטחנת קפה לשיטות חליטה', 'איזו מטחנת קפה מתאימה לשיטת החליטה שלכם? מדריך מקיף לאספרסו, פילטר ועוד', '2026-08-27', [80740, 82032]],
  ['קפה פרמנטציה טבעית', 'פרמנטציה טבעית בקפה ספיישלטי: איך תהליך העיבוד משנה את הטעם שבכוס', '2026-08-05', [80771, 81493]],
  ['מטחנת קפה ידנית מומלצת', 'מטחנת קפה ידנית: המדריך המלא לבחירה שתשדרג לכם/ן את חווית הקפה', '2026-10-04', [80740]],
  ['פולי קפה ברזיל', 'פולי קפה ברזיל: שוקולד, אגוז ומתיקות טבעית, למה ברזיל היא הבסיס של הספיישלטי', '2026-06-02', [79901]],
  ['משקל לקפה מומלץ', 'שדרגו את הקפה שלכם: איך משקל דיגיטלי הופך כל חליטה למושלמת', '2026-09-23', [82368]],
  ['קפה מקוסטה ריקה', 'קפה מקוסטה ריקה: מה מייחד את הפולים ואיך מכינים מהם כוס טובה', '2026-09-02', [81636]],
  ['קפה נטול קפאין', 'קפה נטול קפאין ספיישלטי: למה הדקאף השתנה לחלוטין', '2026-08-02', [80788]],
  ['פולי קפה לאספרסו', 'פולי קפה לאספרסו: איך בוחרים את הפולים הנכונים למכונה שלך', '2026-07-05', [80764]],
]

const DISTINCT: [string, string, string][] = [
  ['פולי קפה קניה', 'קפה קניה AA+: חמיצות פירות יער, גוף עשיר ואיך להכין אותו נכון בבית', '2026-06-24'],
  ['clever dripper קפה', 'Clever Dripper: איזה פולי קפה יעשו לך את הכוס הכי טובה, ומדריך הכנה מהיר', '2026-07-15'],
  ['aeropress', 'AeroPress: איזה פולי קפה יעשו לך את השוט הכי טוב, ומדריך הכנה מהיר', '2026-06-03'],
  ['שדרוג ציוד קפה', 'מה לשדרג קודם בציוד הקפה שלכם: מטחנה, מכונה, או פולים?', '2026-08-16'],
  ['פולי קפה חד זני', 'פולי קפה חד זני: מה זה אומר, למה זה חשוב, ואיזה פול כדאי לנסות קודם', '2026-08-12'],
  ['לחץ אספרסו אופטימלי', 'הסוד לאספרסו מושלם בבית: איך להגיע ללחץ הנכון שישנה את כל חווית הקפה שלכם', '2026-09-13'],
  ['סדנת קפה', 'סדנת קפה ספיישלטי: המדריך המלא לבחירת הסדנה הנכונה לכם', '2026-06-14'],
  ['קפה גוג\'י', 'גוג\'י אתיופי: למה הפרמנטציה הטבעית הופכת את הקפה הזה לחוויה אחרת לגמרי', '2026-06-10'],
  ['קפה ירגשף', 'קפה ירגשף: למה האזור הזה באתיופיה מייצר את הקפה הכי פרחוני בעולם', '2026-07-01'],
  ['קפה אנאירובי', 'קפה אנאירובי: פסיפלורה, ויסקי וסיומת ארוכה, איך תסיסה ללא חמצן משנה את הטעם', '2026-08-26'],
  ['קפה קולומביה', 'קפה קולומביה: מדריך למקור, אזורים וטעמים', '2026-05-31'],
  ['קפה רובוסטה ושינויי אקלים', 'האמת מאחורי רובוסטה: האם היא באמת התשובה לשינויי אקלים?', '2026-09-20'],
]

for (const [kw, title, date, dupIds] of DUPLICATES) {
  Deno.test(`catches duplicate: ${kw}`, () => {
    const hits = findConflicts(kw, title, before(date), { threshold: THRESHOLD })
    assert(
      hits.some(h => dupIds.includes(h.id)),
      `expected one of ${dupIds} — got ${JSON.stringify(hits.map(h => [h.id, h.score]))}`,
    )
  })
}

for (const [kw, title, date] of DISTINCT) {
  Deno.test(`passes distinct topic: ${kw}`, () => {
    const hits = findConflicts(kw, title, before(date), { threshold: THRESHOLD })
    assert(hits.length === 0, `false positive — ${JSON.stringify(hits.map(h => [h.id, h.title, h.score]))}`)
  })
}

Deno.test('Hebrew prefixes and inflections match', () => {
  const posts: IndexedPost[] = [
    { id: 1, title: 'פולי קפה מברזיל: כל מה שצריך לדעת', slug: 'x', status: 'publish', link: '' },
    { id: 2, title: 'סקירת מכונת אספרסו', slug: 'y', status: 'publish', link: '' },
    { id: 3, title: 'קפה קולומביה', slug: 'z', status: 'publish', link: '' },
  ]
  assert(findConflicts('פולי קפה ברזיל', '', posts, { threshold: THRESHOLD }).some(h => h.id === 1))
})

Deno.test('excludeIds lets a rewrite ignore the post it replaces', () => {
  const posts = before('2026-07-22')
  const kw = 'פולי קפה למכונת אספרסו ביתית'
  assert(findConflicts(kw, '', posts, { threshold: THRESHOLD }).some(h => h.id === 80764))
  assert(!findConflicts(kw, '', posts, { threshold: THRESHOLD, excludeIds: [80764] }).some(h => h.id === 80764))
})

Deno.test('percent-encoded Hebrew slugs are decoded and matched', () => {
  const posts: IndexedPost[] = [
    { id: 9, title: 'כותרת אחרת לגמרי', slug: encodeURIComponent('משקל-לקפה').toLowerCase(), status: 'draft', link: '' },
  ]
  assert(findConflicts('משקל לקפה', '', posts, { threshold: THRESHOLD }).some(h => h.id === 9))
})
