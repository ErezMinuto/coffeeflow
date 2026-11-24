// deno run -A supabase/functions/strategist-brain/seo_site_logic_test.ts
import { WIDE_DASH, hasWideDash, classifyUrl, cleanCategoryText, escAttr, insertLink, isSiteLink, proposalReason, seoProblems, visibleWords } from './seo_site_logic.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ── addresses ──
const cat = classifyUrl('https://www.minuto.co.il/product-category/%D7%A4%D7%95%D7%9C%D7%99-%D7%A7%D7%A4%D7%94/')
check('category address (encoded Hebrew)', cat?.kind === 'category' && cat.slug === 'פולי-קפה' && cat.path === '/product-category/פולי-קפה/', JSON.stringify(cat))
check('sub-category keeps its full path', (classifyUrl('https://www.minuto.co.il/product-category/a/b/') as any)?.path === '/product-category/a/b/')
check('product address', classifyUrl('https://minuto.co.il/product/x-y/')?.kind === 'product')
check('blog post address', classifyUrl('https://www.minuto.co.il/blog/מה-זה-מקיאטו/')?.kind === 'post')
check('blog listing is not a post', classifyUrl('https://www.minuto.co.il/blog/category/x/') === null && classifyUrl('https://www.minuto.co.il/blog/') === null)
check('other sites refused', classifyUrl('https://evil.com/product/x/') === null && classifyUrl('https://minuto.co.il.evil.com/product/x/') === null)
check('home / cart refused', classifyUrl('https://www.minuto.co.il/') === null && classifyUrl('https://www.minuto.co.il/cart/') === null)

// ── SEO fields ──
check('good title + description', seoProblems({ title: 'פולי קפה טריים בקלייה מקומית | מינוטו', description: 'פולי קפה ספשלטי טריים בקלייה מקומית ברחובות: חד-זני מאתיופיה, קניה וקולומביה ותערובות בית. משלוח עד הבית.' }).length === 0)
check('too long title refused', seoProblems({ title: 'א'.repeat(66) }).some((p) => p.includes('title is 66')))
check('Hebrew counted in characters, not bytes', seoProblems({ title: 'א'.repeat(65) }).length === 0)
check('too short description refused', seoProblems({ description: 'קצר מדי' }).length === 1)
check('HTML in a title refused', seoProblems({ title: '<b>פולי קפה טריים מינוטו</b>' }).some((p) => p.includes('plain text')))
check('nothing given refused', seoProblems({}).length === 1)

check('wide dash in a title refused', seoProblems({ title: 'פולי קפה טריים – קלייה מקומית | מינוטו' }).some((p) => p.includes('wide dashes')))
check('em dash in a description refused', seoProblems({ description: 'פולי קפה ספשלטי טריים בקלייה מקומית ברחובות — חד-זני מאתיופיה, קניה וקולומביה ותערובות בית.' }).some((p) => p.includes('wide dashes')))
check('plain hyphen is fine', seoProblems({ title: 'פולי קפה חד-זני טריים | מינוטו' }).length === 0)
check('wide dash written as an HTML entity is caught', hasWideDash('a &ndash; b') && hasWideDash('a &#8212; b') && hasWideDash('a &#x2013; b') && !hasWideDash('a - b &amp; c'))
check('entity dash in a title refused', seoProblems({ title: 'פולי קפה טריים &mdash; קלייה מקומית | מינוטו' }).some((p) => p.includes('wide dashes')))
check('WIDE_DASH matches en and em dash, not hyphen', WIDE_DASH.test('a–b') && WIDE_DASH.test('a—b') && !WIDE_DASH.test('a-b'))

// ── category text ──
const dirty = '<p class="x" onclick="evil()">פולי <strong>קפה</strong></p><script>alert(1)</script><a href="https://evil.com">x</a><a href="/product-category/a/">ok</a><img src=x onerror=1><h2 style="c">כותרת</h2>'
const c = cleanCategoryText(dirty)
check('attributes and scripts removed', !/onclick|script|alert|style|class=/.test(c.html), c.html)
check('outside links dropped (text kept), inside links kept', !c.html.includes('evil.com') && c.html.includes('<a href="/product-category/a/">ok</a>') && c.html.includes('x'), c.html)
check('img removed', !c.html.includes('<img'))
check('formatting kept', c.html.includes('<strong>קפה</strong>') && c.html.includes('<h2>כותרת</h2>'))
check('no stray closing tags left', (c.html.match(/<a /g) ?? []).length === (c.html.match(/<\/a>/g) ?? []).length, c.html)
check('word count of visible text', visibleWords('<p>פולי קפה טריים</p><ul><li>אתיופיה</li></ul>') === 4)

check('protocol-relative and backslash links are not site links', !isSiteLink('//evil.com/x') && !isSiteLink('/\\evil.com') && !isSiteLink('javascript:alert(1)') && !isSiteLink('http://www.minuto.co.il/x') && isSiteLink('/product-category/a/') && isSiteLink('https://minuto.co.il/x'))
const sneaky = cleanCategoryText('<p><a href="//evil.com/x">a</a> <a href="javascript:alert(1)">b</a> <a href="/\\evil.com">c</a></p>')
check('category text drops //, javascript: and backslash links (keeps their words)', !/href/.test(sneaky.html) && sneaky.html.includes('a') && sneaky.html.includes('b'), sneaky.html)
check('& in a link is encoded once', escAttr('/?a=1&b=2') === '/?a=1&amp;b=2' && escAttr('/?a=1&amp;b=2') === '/?a=1&amp;b=2' && escAttr('"x"') === '&quot;x&quot;')
check('category text link with & stays valid', cleanCategoryText('<a href="/?a=1&b=2">x</a>').html === '<a href="/?a=1&amp;b=2">x</a>')

// ── internal links ──
const post = '<h2>מה זה פולי קפה</h2><p>כאן תמצאו <a href="/x/">פולי קפה</a> ועוד מידע על פולי קפה טריים.</p>'
const r = insertLink(post, 'פולי קפה', 'https://www.minuto.co.il/product-category/פולי-קפה/')
check('link goes on the first plain-text occurrence (not the heading, not inside a link)', 'html' in r && r.html.includes('על <a href="https://www.minuto.co.il/product-category/פולי-קפה/">פולי קפה</a> טריים') && r.html.startsWith('<h2>מה זה פולי קפה</h2>'), 'html' in r ? r.html : r.error)
check('rest of the post unchanged', 'html' in r && r.html.replace(/<a href="https:\/\/www\.minuto\.co\.il\/product-category\/פולי-קפה\/">פולי קפה<\/a>/, 'פולי קפה') === post)
check('anchor not in the text → refused', 'error' in insertLink(post, 'מטחנה', '/a/'))
check('already linked to that page → refused', 'error' in insertLink('<p><a href="https://www.minuto.co.il/product-category/%D7%A4%D7%95%D7%9C%D7%99-%D7%A7%D7%A4%D7%94/">x</a> פולי קפה</p>', 'פולי קפה', 'https://www.minuto.co.il/product-category/פולי-קפה/'))

// ── reason ──
const reason = proposalReason({ reason: 'thin text', expected_result: 'top 10 for פולי קפה', check_after_days: 28, today: '2026-11-24' })
check('reason carries why, expected result and a check date', reason === 'Why: thin text\nExpected: top 10 for פולי קפה\nCheck on: 2026-12-22', reason)
check('check date kept between 7 and 90 days', proposalReason({ reason: 'a', expected_result: 'b', check_after_days: 400, today: '2026-11-24' }).endsWith('2027-02-22'))

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
