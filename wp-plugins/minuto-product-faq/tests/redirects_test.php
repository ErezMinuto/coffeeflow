<?php
// php wp-plugins/minuto-product-faq/tests/redirects_test.php — the pure redirect checks, with WordPress stubs.
define( 'ABSPATH', __DIR__ );
function add_action() {}
function home_url( $p = '' ) { return 'https://www.minuto.co.il' . $p; }
require __DIR__ . '/../includes/redirects.php';
$f = 0;
function check( $n, $ok, $d = '' ) { global $f; echo ( $ok ? 'ok   ' : 'FAIL ' ) . $n . ( $ok || '' === $d ? '' : " — $d" ) . "\n"; if ( ! $ok ) $f++; }
$H = 'https://www.minuto.co.il/';
$enc = 'https://www.minuto.co.il/blog/%D7%9E%D7%94-%D7%96%D7%94-%D7%9E%D7%A7%D7%99%D7%90%D7%98%D7%95/';
check( 'path: encoded URL → decoded path with slashes', '/blog/מה-זה-מקיאטו/' === minuto_redirect_path( $enc ), minuto_redirect_path( $enc ) );
check( 'path: no trailing slash, query dropped', '/blog/x/' === minuto_redirect_path( '/blog/x?utm=1' ) );
check( 'path: homepage', '/' === minuto_redirect_path( 'https://www.minuto.co.il' ) );
$ok = minuto_redirect_validate( $enc, 'https://www.minuto.co.il/blog/%D7%9E%D7%A7%D7%99%D7%90%D7%98%D7%95/', array(), $H );
check( 'valid: stored source decoded, target absolute and encoded', '/blog/מה-זה-מקיאטו/' === $ok['source'] && 'https://www.minuto.co.il/blog/%D7%9E%D7%A7%D7%99%D7%90%D7%98%D7%95/' === $ok['target'], json_encode( $ok, JSON_UNESCAPED_UNICODE ) );
check( 'valid: minuto.co.il without www is the same site', ! isset( minuto_redirect_validate( '/blog/a/', 'https://minuto.co.il/blog/b/', array(), $H )['error'] ) );
check( 'remove: target empty', array( 'source' => '/blog/a/', 'target' => '' ) === minuto_redirect_validate( '/blog/a/', '', array(), $H ) );
check( 'refused: homepage', isset( minuto_redirect_validate( $H, $H . 'shop/', array(), $H )['error'] ) );
check( 'refused: system path', isset( minuto_redirect_validate( '/checkout/', $H . 'shop/', array(), $H )['error'] ) && isset( minuto_redirect_validate( '/wp-admin/x', $H . 'shop/', array(), $H )['error'] ) );
check( 'refused: another site', isset( minuto_redirect_validate( '/blog/a/', 'https://evil.example/x/', array(), $H )['error'] ) );
check( 'refused: http target', isset( minuto_redirect_validate( '/blog/a/', 'http://www.minuto.co.il/b/', array(), $H )['error'] ) );
check( 'refused: source on another site', isset( minuto_redirect_validate( 'https://evil.example/blog/a/', $H . 'b/', array(), $H )['error'] ) );
check( 'refused: to itself', isset( minuto_redirect_validate( '/blog/a/', $H . 'blog/a', array(), $H )['error'] ) );
check( 'refused: target is itself redirected (chain)', isset( minuto_redirect_validate( '/blog/a/', $H . 'blog/b/', array( '/blog/b/' => $H . 'blog/c/' ), $H )['error'] ) );
check( 'refused: something already redirects to the source (chain)', isset( minuto_redirect_validate( '/blog/b/', $H . 'blog/c/', array( '/blog/a/' => $H . 'blog/b/' ), $H )['error'] ) );
check( 'allowed: replacing the same source', ! isset( minuto_redirect_validate( '/blog/a/', $H . 'blog/d/', array( '/blog/a/' => $H . 'blog/b/' ), $H )['error'] ) );
check( 'refused: non-string target', isset( minuto_redirect_validate( '/blog/a/', null, array(), $H )['error'] ) );
$store = array( '/blog/מה-זה-מקיאטו/' => 'https://www.minuto.co.il/blog/%D7%9E/' );
check( 'match: encoded request URI', 'https://www.minuto.co.il/blog/%D7%9E/' === minuto_redirect_match( '/blog/%D7%9E%D7%94-%D7%96%D7%94-%D7%9E%D7%A7%D7%99%D7%90%D7%98%D7%95/', $store ) );
check( 'match: keeps the query string', 'https://www.minuto.co.il/blog/%D7%9E/?gclid=1' === minuto_redirect_match( '/blog/%D7%9E%D7%94-%D7%96%D7%94-%D7%9E%D7%A7%D7%99%D7%90%D7%98%D7%95?gclid=1', $store ) );
check( 'no match: other page', null === minuto_redirect_match( '/blog/other/', $store ) );
echo $f ? "\n$f FAILED\n" : "\nall passed\n"; exit( $f ? 1 : 0 );
