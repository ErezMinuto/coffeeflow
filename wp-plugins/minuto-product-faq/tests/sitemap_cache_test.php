<?php
// php wp-plugins/minuto-product-faq/tests/sitemap_cache_test.php — when Rank Math is asked to rebuild its sitemap.
namespace RankMath\Sitemap {
	class Cache { public static $calls = 0; public static function invalidate_storage( $type = null ) { self::$calls++; } }
}
namespace {
	define( 'ABSPATH', __DIR__ );
	$GLOBALS['hooks'] = array(); $GLOBALS['opts'] = array();
	function add_action( $h, $cb ) { $GLOBALS['hooks'][ $h ][] = $cb; }
	function get_option( $k, $d = false ) { return isset( $GLOBALS['opts'][ $k ] ) ? $GLOBALS['opts'][ $k ] : $d; }
	function update_option( $k, $v ) { $GLOBALS['opts'][ $k ] = $v; return true; }
	require __DIR__ . '/../includes/sitemap-cache.php';
	$f = 0;
	function check( $n, $ok, $d = '' ) { global $f; echo ( $ok ? 'ok   ' : 'FAIL ' ) . $n . ( $ok || '' === $d ? '' : " — $d" ) . "\n"; if ( ! $ok ) $f++; }
	function shutdown_runs() { foreach ( $GLOBALS['hooks']['shutdown'] ?? array() as $cb ) { $cb(); } $GLOBALS['hooks']['shutdown'] = array(); }
	$C = '\RankMath\Sitemap\Cache';

	check( 'publish → draft changes the sitemap', minuto_sitemap_status_changes( 'draft', 'publish' ) );
	check( 'draft → publish changes the sitemap', minuto_sitemap_status_changes( 'publish', 'draft' ) );
	check( 'publish → publish (an edit) does not', ! minuto_sitemap_status_changes( 'publish', 'publish' ) );
	check( 'draft → pending does not', ! minuto_sitemap_status_changes( 'pending', 'draft' ) );

	$post = (object) array( 'post_type' => 'post' );
	minuto_sitemap_on_status( 'draft', 'publish', $post );
	minuto_sitemap_on_status( 'draft', 'publish', (object) array( 'post_type' => 'page' ) );
	check( 'not rebuilt mid-request (queued for shutdown)', 0 === $C::$calls );
	shutdown_runs();
	check( 'a post going offline → ONE rebuild at shutdown, even for two changes', 1 === $C::$calls, (string) $C::$calls );
	minuto_sitemap_on_status( 'draft', 'publish', (object) array( 'post_type' => 'attachment' ) );
	shutdown_runs();
	check( 'other post types are ignored', 1 === $C::$calls );

	foreach ( $GLOBALS['hooks']['init'] as $cb ) { $cb(); }
	check( 'once after the update: rebuilt and remembered', 2 === $C::$calls && '0.7.1' === get_option( 'minuto_faq_sitemap_flushed_version' ) );
	foreach ( $GLOBALS['hooks']['init'] as $cb ) { $cb(); }
	check( 'not again on later requests', 2 === $C::$calls );
	check( 'hooked on transition_post_status', isset( $GLOBALS['hooks']['transition_post_status'] ) );
	echo $f ? "\n$f FAILED\n" : "\nall passed\n"; exit( $f ? 1 : 0 );
}
