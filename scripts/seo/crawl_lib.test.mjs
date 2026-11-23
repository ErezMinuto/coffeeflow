// node --test   (from scripts/seo)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPage, internalPath, isSitemapIndex, mapLimit, pageType, robotsSitemaps, schemaTypes, sitemapLocs } from './crawl_lib.mjs'

const HOST = 'www.minuto.co.il'

test('sitemap parsing', () => {
  const idx = '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.minuto.co.il/post-sitemap.xml</loc></sitemap></sitemapindex>'
  assert.equal(isSitemapIndex(idx), true)
  assert.deepEqual(sitemapLocs(idx), ['https://www.minuto.co.il/post-sitemap.xml'])
  const set = '<urlset><url><loc> https://www.minuto.co.il/a/?x=1&amp;y=2 </loc></url></urlset>'
  assert.equal(isSitemapIndex(set), false)
  assert.deepEqual(sitemapLocs(set), ['https://www.minuto.co.il/a/?x=1&y=2'])
})

test('robots.txt sitemap lines', () => {
  assert.deepEqual(robotsSitemaps('User-agent: *\nSitemap: https://www.minuto.co.il/sitemap_index.xml\n'), ['https://www.minuto.co.il/sitemap_index.xml'])
})

test('page types', () => {
  assert.equal(pageType('https://www.minuto.co.il/'), 'home')
  assert.equal(pageType('https://www.minuto.co.il/product/x/'), 'product')
  assert.equal(pageType('https://www.minuto.co.il/product-category/beans/'), 'category')
  assert.equal(pageType('https://www.minuto.co.il/blog/x/'), 'post')
  assert.equal(pageType('https://www.minuto.co.il/about/', 'https://www.minuto.co.il/page-sitemap.xml'), 'page')
  assert.equal(pageType('https://www.minuto.co.il/x/', 'https://www.minuto.co.il/product_cat-sitemap.xml'), 'category')
})

test('schema types include @graph and arrays; bad JSON skipped', () => {
  const t = schemaTypes(['{"@graph":[{"@type":"Organization"},{"@type":["Product","Thing"],"offers":{"@type":"Offer"}}]}', '{not json'])
  assert.deepEqual(t, ['Offer', 'Organization', 'Product', 'Thing'])
})

test('internal vs external links', () => {
  assert.equal(internalPath('/product/a/?ref=1#x', 'https://www.minuto.co.il/', HOST), '/product/a/')
  assert.equal(internalPath('https://minuto.co.il/b/', 'https://www.minuto.co.il/', HOST), '/b/')
  assert.equal(internalPath('https://facebook.com/x', 'https://www.minuto.co.il/', HOST), null)
  assert.equal(internalPath('mailto:a@b.c', 'https://www.minuto.co.il/', HOST), undefined)
  assert.equal(internalPath('#top', 'https://www.minuto.co.il/', HOST), undefined)
})

test('extractPage reads the SEO fields', () => {
  const html = `<!doctype html><html lang="he-IL"><head>
    <title> פולי קפה | מינוטו </title>
    <meta name="description" content="תיאור קצר">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="https://www.minuto.co.il/x/">
    <script type="application/ld+json">{"@type":"Product"}</script>
  </head><body>
    <header><a href="/menu/">תפריט</a> מילים בכותרת</header>
    <main><h1>כותרת ראשית</h1><p>שלוש מילים כאן</p><h1>עוד</h1>
      <a href="/product/a/">a</a><a href="/product/a/">a again</a><a href="https://instagram.com/x">ig</a>
      <img src="a.jpg" alt="קפה"><img src="b.jpg"><img src="c.jpg" alt=" ">
      <script>var hidden = "not words"</script>
    </main>
    <footer>זכויות</footer></body></html>`
  const p = extractPage(html, 'https://www.minuto.co.il/x/', HOST)
  assert.equal(p.title, 'פולי קפה | מינוטו')
  assert.equal(p.meta_description, 'תיאור קצר')
  assert.equal(p.robots_meta, 'index, follow')
  assert.equal(p.canonical, 'https://www.minuto.co.il/x/')
  assert.equal(p.lang, 'he-IL')
  assert.equal(p.h1, 'כותרת ראשית')
  assert.equal(p.h1_count, 2)
  assert.deepEqual(p.schema_types, ['Product'])
  assert.deepEqual(p.internal_links, ['/menu/', '/product/a/'])
  assert.equal(p.external_links, 1)
  assert.equal(p.images, 3)
  assert.equal(p.images_missing_alt, 2)
  // main only: "כותרת ראשית" (2) + "שלוש מילים כאן" (3) + "עוד" (1) + link texts "a" "a again" "ig" (4) = 10; script excluded
  assert.equal(p.word_count, 10)
})

test('mapLimit keeps order and limits concurrency', async () => {
  let inFlight = 0, peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
    return x * 10
  })
  assert.deepEqual(out, [10, 20, 30, 40, 50])
  assert.equal(peak, 2)
})

import { CRAWL_ROW_COLUMNS, toCrawlRow } from './crawl_lib.mjs'
test('every crawl row has the same keys, failed pages included', () => {
  const ok = toCrawlRow({ crawl_id: 'c', url: 'a', status: 200, title: 't', schema_types: ['X'], internal_links: ['/b/'] })
  const failed = toCrawlRow({ crawl_id: 'c', url: 'b', status: 0, error: 'timeout' })
  assert.deepEqual(Object.keys(ok), CRAWL_ROW_COLUMNS)
  assert.deepEqual(Object.keys(failed), CRAWL_ROW_COLUMNS)
  assert.equal(failed.title, null)
  assert.equal(failed.redirects, 0)
  assert.equal(toCrawlRow({ url: 'x', extra: 1 }).extra, undefined)
})
