// deno run -A supabase/functions/strategist-brain/seo_site_logic_test.ts
import { appendSection, carryOverSection, mergeEvidence, WIDE_DASH, PRICE_IN_TEXT, hasWideDash, faqProblems, numbersNotInCatalog, classifyUrl, cleanCategoryText, escAttr, insertLink, isSiteLink, proposalReason, seoProblems, visibleWords } from './seo_site_logic.ts'

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

// ── product FAQ and facts ──
const goodFaq = [
  { q: 'האם טריאסט מתאים לקפה עם חלב?', a: 'כן. התערובת עשירה בקרמה ובעלת גוף מלא, ולכן מתאימה במיוחד לקפוצ׳ינו ולמשקאות אספרסו עם חלב.' },
  { q: 'מה ההרכב של התערובת?', a: 'התערובת מורכבת מ-80% ערביקה ו-20% רובוסטה, מפולים מדרום אמריקה והודו.' },
  { q: 'אפשר לקנות את הקפה טחון?', a: 'כן. אפשר לבחור פולים שלמים או טחינה לאספרסו, לקפה שחור, למקינטה, לפילטר או לפרנץ׳ פרס.' },
]
check('a good 3-question FAQ passes', faqProblems(goodFaq).length === 0, faqProblems(goodFaq).join('; '))
check('too few questions refused', faqProblems(goodFaq.slice(0, 2)).some((p) => p.includes('give 3')))
check('a question without "?" refused', faqProblems([...goodFaq.slice(0, 2), { q: 'ספרו על התערובת', a: goodFaq[2].a }]).some((p) => p.includes('end with')))
check('a one-line answer refused', faqProblems([...goodFaq.slice(0, 2), { q: 'זה טרי?', a: 'כן.' }]).some((p) => p.includes('answer 3')))
check('a wide dash in an answer refused', faqProblems([...goodFaq.slice(0, 2), { q: 'זה טרי?', a: 'כן – נקלה במקום ונארז מיד לשמירה על טריות.' }]).some((p) => p.includes('wide dashes')))
check('a repeated question refused', faqProblems([goodFaq[0], goodFaq[1], goodFaq[0]]).some((p) => p.includes('repeats')))
check('not a list refused', faqProblems('x').length === 1)
const catalog = 'פולי קפה מדרום אמריקה והודו, 80% ערביקה ו-20% רובוסטה. 330 גר. מחיר ל-100 גר׳: 17.88 ₪'
check('catalog numbers are allowed', numbersNotInCatalog('<p>80% ערביקה, 20% רובוסטה, שקית 330 גרם</p>', catalog).length === 0)
check('an invented number is caught', numbersNotInCatalog('<p>נקלה לפני 48 שעות, טרי ל-6 שבועות</p>', catalog).join(',') === '48,6')
check('17.88 and 17,88 both match the catalog', numbersNotInCatalog('17,88 ₪ ל-100 גרם', catalog).length === 0)

check('price per 100 g line is a price', PRICE_IN_TEXT.test('<p>שקית 330 גרם. מחיר ל-100 גר׳: 17.88 ₪</p>'))
check('a shekel amount in a FAQ answer refused', faqProblems([...goodFaq.slice(0, 2), { q: 'כמה זה עולה?', a: 'השקית עולה 59 ש"ח, ומשלוח חינם מעל סכום מסוים.' }]).some((p) => p.includes('no prices')))
check('"משקל" (weight) is not a price', !PRICE_IN_TEXT.test('<p>משקל השקית 330 גרם</p>') && PRICE_IN_TEXT.test('<p>עולה 59 שקלים</p>') && PRICE_IN_TEXT.test('<p>רק שקל לגרם</p>'))
check('plain text with numbers but no price is fine', !PRICE_IN_TEXT.test('<p>80% ערביקה, שקית 330 גרם, גובה 1700 מטר</p>'))

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

// ── merges ──
{
  const key = (u: string) => decodeURIComponent(new URL(u).pathname).toLowerCase()
  const H = 'https://www.minuto.co.il'
  const A = H + '/blog/%D7%90/', B = H + '/blog/%D7%91/'
  const rows = [
    { page: A, clicks: 0, impressions: 1506, position: 11.5 },
    { page: B, clicks: 0, impressions: 570, position: 10.9 },
    { page: H + '/', clicks: 0, impressions: 19, position: 30 },
  ]
  const ok = mergeEvidence(rows, key(B), key(A), key)
  check('merge evidence: two posts split the search (macchiato case)', !('error' in ok) && ok.total === 2095 && ok.loser.impressions === 570 && ok.winner.position === 11.5, JSON.stringify(ok))
  check('merge evidence: page URL case does not matter (GSC upper-cases %XX)', !('error' in mergeEvidence(rows, key(B.toLowerCase()), key(A), key)))
  const thin = mergeEvidence([{ page: A, clicks: 0, impressions: 60, position: 9 }, { page: B, clicks: 0, impressions: 30, position: 9 }], key(B), key(A), key)
  check('merge evidence: under 100 impressions refused', 'error' in thin && /100/.test(thin.error))
  const share = mergeEvidence([{ page: A, clicks: 5, impressions: 950, position: 4 }, { page: B, clicks: 0, impressions: 50, position: 20 }], key(B), key(A), key)
  check('merge evidence: a page under 10% does not split the search', 'error' in share && /10%/.test(share.error))
  const wrong = mergeEvidence([{ page: A, clicks: 1, impressions: 500, position: 12 }, { page: B, clicks: 9, impressions: 400, position: 6 }], key(B), key(A), key)
  check('merge evidence: refuses retiring the stronger page', 'error' in wrong && /stronger/.test(wrong.error))
  const missing = mergeEvidence(rows, key(H + '/blog/other/'), key(A), key)
  check('merge evidence: a page with no rows for the search is refused', 'error' in missing)
}
{
  const body = 'מקיאטו הוא אספרסו עם כתם קטן של קצף חלב. '.repeat(6)
  const sec = carryOverSection(`<h2>ההבדל בין מקיאטו לקורטדו</h2><p>${body}</p><script>x</script>`)
  check('carry-over: cleaned, starts with h2, script removed', !('error' in sec) && sec.html.startsWith('<h2>') && !sec.html.includes('script'), JSON.stringify(sec))
  check('carry-over: needs an h2 heading', 'error' in carryOverSection(`<p>${body}</p>`))
  check('carry-over: too short refused', 'error' in carryOverSection('<h2>כותרת</h2><p>קצר מדי</p>'))
  check('carry-over: wide dash refused', 'error' in carryOverSection(`<h2>כותרת</h2><p>${body} — סוף</p>`))
  check('carry-over: price refused', 'error' in carryOverSection(`<h2>כותרת</h2><p>${body} רק 30 ₪</p>`))
  check('append: section added at the end, rest unchanged', appendSection('<p>a</p>\n\n', '<h2>b</h2>') === '<p>a</p>\n\n<h2>b</h2>\n')
}

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
