<?php
// php wp-plugins/minuto-product-faq/tests/seo_meta_test.php — the pure request parser, with WordPress stubs.
define( 'ABSPATH', __DIR__ );
function add_action() {}
function wp_strip_all_tags( $s ) { return strip_tags( $s ); }
require __DIR__ . '/../includes/seo-meta.php';
$f = 0;
function check( $n, $ok, $d = '' ) { global $f; echo ( $ok ? 'ok   ' : 'FAIL ' ) . $n . ( $ok || '' === $d ? '' : " — $d" ) . "\n"; if ( ! $ok ) $f++; }
$r = minuto_seo_parse_body( array( 'title' => '  פולי קפה טריים  |  מינוטו ', 'description' => 'טקסט' ) );
check( 'title and description accepted, spaces tidied', ! isset( $r['error'] ) && 'פולי קפה טריים | מינוטו' === $r['title'] && 'טקסט' === $r['description'], json_encode( $r, JSON_UNESCAPED_UNICODE ) );
check( 'a field left out is not touched', ! isset( $r['focus_keyword'] ) );
check( "'' means remove the custom value", array( 'title' => '' ) === minuto_seo_parse_body( array( 'title' => '' ) ) );
check( 'HTML is stripped', 'bold' === minuto_seo_parse_body( array( 'title' => '<b>bold</b>' ) )['title'] );
check( 'unknown field refused', isset( minuto_seo_parse_body( array( 'titel' => 'x' ) )['error'] ) );
check( 'non-string refused', isset( minuto_seo_parse_body( array( 'title' => 5 ) )['error'] ) );
check( 'empty body refused', isset( minuto_seo_parse_body( array() )['error'] ) );
check( 'not an object refused', isset( minuto_seo_parse_body( 'x' )['error'] ) );
check( 'title over 200 characters refused (counted in characters, not bytes)', isset( minuto_seo_parse_body( array( 'title' => str_repeat( 'א', 201 ) ) )['error'] ) && ! isset( minuto_seo_parse_body( array( 'title' => str_repeat( 'א', 200 ) ) )['error'] ) );
check( 'description up to 500 characters', ! isset( minuto_seo_parse_body( array( 'description' => str_repeat( 'א', 500 ) ) )['error'] ) );
check( 'fields map to Rank Math meta keys', 'rank_math_title' === minuto_seo_fields()['title']['key'] && 'rank_math_description' === minuto_seo_fields()['description']['key'] && 'rank_math_focus_keyword' === minuto_seo_fields()['focus_keyword']['key'] );
echo $f ? "\n$f FAILED\n" : "\nall passed\n"; exit( $f ? 1 : 0 );
