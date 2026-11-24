<?php
// php wp-plugins/minuto-category-pagination/tests/core_test.php
require __DIR__ . '/../includes/core.php';

$failures = 0;
function check( $name, $ok, $detail = '' ) {
	global $failures;
	echo ( $ok ? 'ok   ' : 'FAIL ' ) . $name . ( $ok || '' === $detail ? '' : " — $detail" ) . "\n";
	if ( ! $ok ) {
		$failures++;
	}
}

$cat = 'https://www.minuto.co.il/product-category/%d7%90%d7%91%d7%99%d7%96%d7%a8%d7%99-%d7%a7%d7%a4%d7%94/%d7%97%d7%95%d7%9e%d7%a8%d7%99-%d7%a0%d7%99%d7%a7%d7%95%d7%99/';

// requested page
check( 'no page → 1', 1 === mcp_requested_page( array() ) );
check( '?page=4 → 4', 4 === mcp_requested_page( array( 'page' => '4' ) ) );
check( 'junk, zero, negative, array → 1', 1 === mcp_requested_page( array( 'page' => 'x' ) ) && 1 === mcp_requested_page( array( 'page' => '0' ) ) && 1 === mcp_requested_page( array( 'page' => '-2' ) ) && 1 === mcp_requested_page( array( 'page' => array( 2 ) ) ) );

// filters
check( 'no filters', ! mcp_has_filters( array( 'page' => '2' ) ) );
check( 'a price filter counts', mcp_has_filters( array( 'price_min' => '50' ) ) );
check( 'a sort counts', mcp_has_filters( array( 'sort' => 'price' ) ) );
check( 'an empty filter does not count', ! mcp_has_filters( array( 'selected_brand' => '' ) ) );

// totals
check( '78 products / 12 = 7 pages', 7 === mcp_total_pages( 78 ) );
check( '12 products = 1 page', 1 === mcp_total_pages( 12 ) );
check( '13 products = 2 pages', 2 === mcp_total_pages( 13 ) );
check( '0 products = 1 page', 1 === mcp_total_pages( 0 ) );

// URLs
check( 'page 1 is the category itself', $cat === mcp_page_url( $cat, 1 ) );
check( 'page 4 is ?page=4', $cat . '?page=4' === mcp_page_url( $cat, 4 ) );
check( 'an existing query string is replaced', $cat . '?page=2' === mcp_page_url( $cat . '?page=7', 2 ) );

// legacy paths
$p = mcp_parse_legacy_path( '/product-category/%d7%90%d7%91%d7%99%d7%96%d7%a8%d7%99-%d7%a7%d7%a4%d7%94/%d7%97%d7%95%d7%9e%d7%a8%d7%99-%d7%a0%d7%99%d7%a7%d7%95%d7%99/page/3/' );
check( 'legacy /page/3/ parsed', $p && 3 === $p['page'], json_encode( $p ) );
check( 'slug is the last segment, decoded', $p && 'חומרי-ניקוי' === mcp_slug_from_path( $p['path'] ), $p ? mcp_slug_from_path( $p['path'] ) : '' );
check( 'without trailing slash and with a query', null !== mcp_parse_legacy_path( '/product-category/a/page/2?x=1' ) );
check( 'a plain category is not legacy', null === mcp_parse_legacy_path( '/product-category/a/b/' ) );
check( 'a product page is not legacy', null === mcp_parse_legacy_path( '/product/x/page/2/' ) );
check( 'the blog is not touched', null === mcp_parse_legacy_path( '/blog/page/2/' ) );

// page numbers
check( 'all pages when few', array( 1, 2, 3, 4 ) === mcp_page_numbers( 1, 4 ) );
check( 'gaps when many', array( 1, null, 8, 9, 10, 11, 12, null, 40 ) === mcp_page_numbers( 10, 40 ), json_encode( mcp_page_numbers( 10, 40 ) ) );
$nums = mcp_page_numbers( 99, 5 );
check( 'current clamped to the last page', 5 === end( $nums ) );

// nav html
$nav = mcp_nav_html( $cat, 4, 7 );
check( 'one page → no nav', '' === mcp_nav_html( $cat, 1, 1 ) );
check( 'nav links page 1 to the category itself', false !== strpos( $nav, 'href="' . $cat . '"' ) );
check( 'nav links page 7 as ?page=7', false !== strpos( $nav, 'href="' . $cat . '?page=7"' ) );
check( 'current page is not a link', false !== strpos( $nav, 'aria-current="page">4<' ) && false === strpos( $nav, '?page=4"' ) );
check( 'URLs are escaped', false !== strpos( mcp_nav_html( 'https://x/"><script>/', 1, 2 ), '&quot;&gt;&lt;script&gt;' ) );

// rel links
$r = mcp_rel_links( $cat, 1, 7 );
check( 'page 1: next only', '' === $r['prev'] && false !== strpos( $r['next'], '?page=2' ) );
$r = mcp_rel_links( $cat, 7, 7 );
check( 'last page: prev only', '' === $r['next'] && false !== strpos( $r['prev'], '?page=6' ) );
$r = mcp_rel_links( $cat, 2, 7 );
check( 'page 2: prev is the category itself', false !== strpos( $r['prev'], 'href="' . $cat . '"' ) );

// modes
check( 'off: nothing', ! mcp_enabled_for( 'off', array( 402 ), 402 ) );
check( 'test: only listed', mcp_enabled_for( 'test', array( 402 ), 402 ) && ! mcp_enabled_for( 'test', array( 402 ), 77 ) );
check( 'on: everything', mcp_enabled_for( 'on', array(), 77 ) );
check( 'unknown mode: nothing', ! mcp_enabled_for( 'yes', array( 402 ), 402 ) );

echo $failures ? "\n$failures FAILED\n" : "\nall passed\n";
exit( $failures ? 1 : 0 );
