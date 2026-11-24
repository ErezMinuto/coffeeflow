// node --test   (from scripts/seo)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPage, internalPath, isSitemapIndex, listingIssue, listingPageNumber, mapLimit, pageType, robotsSitemaps, schemaTypes, sitemapLocs } from './crawl_lib.mjs'

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

test('listing page links of the same category', () => {
  const cat = 'https://www.minuto.co.il/product-category/%d7%90/%d7%91/'
  assert.equal(listingPageNumber('?page=4', cat, HOST), 4)
  assert.equal(listingPageNumber(cat + '?page=2', cat, HOST), 2)
  assert.equal(listingPageNumber('https://www.minuto.co.il/product-category/א/ב/?page=3', cat, HOST), 3)   // decoded form of the same path
  assert.equal(listingPageNumber(cat + 'page/5/', cat, HOST), 5)
  assert.equal(listingPageNumber('https://www.minuto.co.il/product-category/other/?page=2', cat, HOST), null)  // another category
  assert.equal(listingPageNumber('https://example.com/product-category/%d7%90/%d7%91/?page=2', cat, HOST), null)
  assert.equal(listingPageNumber('?page=x', cat, HOST), null)
  assert.equal(listingPageNumber(cat, cat, HOST), null)
  // from page 3 itself, links to page 1 and 4 of the same category still count
  assert.equal(listingPageNumber(cat + '?page=4', cat + '?page=3', HOST), 4)
})

test('extractPage collects listing pages, rel=next and product paths', () => {
  const cat = 'https://www.minuto.co.il/product-category/beans/'
  const html = `<html><head><link rel="next" href="${cat}?page=2" /></head><body><main>
    <a href="/product/a/">A</a><a href="/product/b/">B</a>
    <nav class="mcp-pagination"><a href="${cat}" data-page="1">1</a><a href="${cat}?page=2">2</a><a href="${cat}?page=3">3</a><a href="${cat}?page=2">2</a></nav>
    <a href="/product-category/other/?page=2">other</a></main></body></html>`
  const p = extractPage(html, cat, HOST)
  assert.deepEqual(p.listing_page_urls, [cat + '?page=2', cat + '?page=3'])
  assert.equal(p.rel_next, cat + '?page=2')
  assert.deepEqual(p.product_paths, ['/product/a/', '/product/b/'])
  assert.ok(!p.internal_links.some((l) => l.includes('?')), 'stored internal links keep no query strings')
})

test('listing issues', () => {
  const ok = { rel_next: 'x?page=2', listing_page_urls: ['x?page=2'], product_paths: ['/product/a/'] }
  assert.equal(listingIssue({ rel_next: null, listing_page_urls: [], product_paths: [] }, null), null, 'one-page category')
  assert.equal(listingIssue(ok, ['/product/b/']), null, 'real links, page 2 differs')
  // The site before the pagination plugin: rel=next to /page/2/, only a JavaScript button.
  assert.equal(listingIssue({ rel_next: 'x/page/2/', listing_page_urls: [], product_paths: ['/product/a/'] }, ['/product/a/']), 'no_page_links')
  assert.equal(listingIssue(ok, ['/product/a/']), 'next_repeats_first')
  assert.equal(listingIssue(ok, null), null, 'next page not fetched: no claim')
})

test('crawl rows carry the listing columns, not the helper fields', () => {
  assert.ok(CRAWL_ROW_COLUMNS.includes('listing_pages') && CRAWL_ROW_COLUMNS.includes('listing_issue'))
  const row = toCrawlRow({ url: 'u', listing_page_urls: ['a'], rel_next: 'b', product_paths: ['c'], listing_pages: 3 })
  assert.equal(row.listing_pages, 3)
  assert.equal(row.listing_issue, null)
  assert.ok(!('listing_page_urls' in row) && !('rel_next' in row) && !('product_paths' in row))
})

test('an unparseable rel=next does not break the page', () => {
  const p = extractPage('<html><head><link rel="next" href="http://[bad" /></head><body><main><a href="/product/a/">A</a></main></body></html>', 'https://www.minuto.co.il/product-category/x/', HOST)
  assert.equal(p.rel_next, null)
  assert.deepEqual(p.product_paths, ['/product/a/'])
})

test('blog listings are not posts', () => {
  assert.equal(pageType('https://www.minuto.co.il/blog/'), 'listing')
  assert.equal(pageType('https://www.minuto.co.il/blog/category/%D7%9E%D7%9B%D7%95%D7%A0%D7%95%D7%AA/'), 'listing')
  assert.equal(pageType('https://www.minuto.co.il/blog/tag/x/'), 'listing')
  assert.equal(pageType('https://www.minuto.co.il/blog/some-post/'), 'post')
  assert.equal(pageType('https://www.minuto.co.il/blog/category-guide-to-beans/'), 'post', 'a post whose slug starts with "category" is still a post')
})

test('blog /page/N/ links count as listing pages of the blog', () => {
  assert.equal(listingPageNumber('https://www.minuto.co.il/blog/page/3/', 'https://www.minuto.co.il/blog/', HOST), 3)
  assert.equal(listingPageNumber('https://www.minuto.co.il/blog/page/4/', 'https://www.minuto.co.il/blog/page/3/', HOST), 4)
  assert.equal(listingPageNumber('https://www.minuto.co.il/blog/some-post/', 'https://www.minuto.co.il/blog/', HOST), null)
})
