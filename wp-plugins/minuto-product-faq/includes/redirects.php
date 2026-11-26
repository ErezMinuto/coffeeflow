<?php
/**
 * Minuto Product FAQ — v0.7.0: 301 redirects the SEO agent can set and undo.
 *
 * When two of our pages compete for the same Google search, the owner can
 * approve a merge: the weaker blog post is redirected to the page that should
 * win, and taken offline. CoffeeFlow writes the redirect through its change
 * log (back up, write, log), so every redirect can be undone from the
 * approvals inbox. The redirects live in one option (minuto_redirects), apart
 * from Rank Math's own redirections, which keep working as before.
 *
 *   GET  /wp-json/minuto-faq/v1/redirect?source=<url or path>   → { source, target|null }
 *   POST /wp-json/minuto-faq/v1/redirect   body: { source, target }   target '' removes it
 *
 * Paths are stored decoded, with a leading and trailing slash ("/blog/מה-זה/").
 * Refused: the homepage, WordPress/WooCommerce system paths, targets on another
 * site, a redirect to itself, and chains (a target that is itself redirected,
 * or a source that another redirect points to).
 *
 * A matching request gets a 301 at template_redirect (priority 1, before
 * WordPress guesses a 404's address), keeping the query string (ad tracking).
 * After a write, WP Rocket's copy of the source page is cleared, otherwise the
 * cached page would still be served instead of the redirect.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const MINUTO_REDIRECTS_OPTION = 'minuto_redirects';
const MINUTO_REDIRECTS_MAX    = 500;

/** Pure: a URL or path → "/decoded/path/" ('' when it is not a usable path). */
function minuto_redirect_path( $url ) {
	if ( ! is_string( $url ) ) {
		return '';
	}
	$url = trim( $url );
	if ( '' === $url ) {
		return '';
	}
	$path = parse_url( $url, PHP_URL_PATH );
	if ( ! is_string( $path ) || '' === $path ) {
		$path = '/';
	}
	$path = rawurldecode( $path );
	$path = '/' . trim( preg_replace( '#/+#', '/', $path ), '/' );
	return '/' === $path ? '/' : $path . '/';
}

/** Pure: the host of an absolute URL, lowercased without "www." ('' for a path). */
function minuto_redirect_host( $url ) {
	$h = parse_url( (string) $url, PHP_URL_HOST );
	return is_string( $h ) ? preg_replace( '/^www\./', '', strtolower( $h ) ) : '';
}

/**
 * Pure: checks a write. $target '' = remove. Returns array( 'source', 'target' )
 * (target '' on removal, else the absolute URL to store) or array( 'error' ).
 */
function minuto_redirect_validate( $source, $target, array $store, $home ) {
	$src = minuto_redirect_path( $source );
	if ( '' === $src ) {
		return array( 'error' => 'source must be a path or an address on this site' );
	}
	$home_host = minuto_redirect_host( $home );
	if ( minuto_redirect_host( $source ) && minuto_redirect_host( $source ) !== $home_host ) {
		return array( 'error' => 'source must be on this site' );
	}
	if ( '/' === $src ) {
		return array( 'error' => 'the homepage cannot be redirected' );
	}
	if ( preg_match( '#^/(wp-admin|wp-json|wp-content|wp-includes|wp-login\.php|cart|checkout|my-account|feed)(/|$)#', $src ) ) {
		return array( 'error' => "$src is a system path and cannot be redirected" );
	}
	if ( ! is_string( $target ) ) {
		return array( 'error' => "target must be a string ('' removes the redirect)" );
	}
	$target = trim( $target );
	if ( '' === $target ) {
		return array( 'source' => $src, 'target' => '' );
	}
	if ( ! preg_match( '#^https://#i', $target ) || minuto_redirect_host( $target ) !== $home_host ) {
		return array( 'error' => 'target must be an https address on this site' );
	}
	$dst = minuto_redirect_path( $target );
	if ( $dst === $src ) {
		return array( 'error' => 'a page cannot redirect to itself' );
	}
	if ( isset( $store[ $dst ] ) ) {
		return array( 'error' => "the target $dst is itself redirected (to {$store[ $dst ]}): redirect straight to the final page" );
	}
	foreach ( $store as $from => $to ) {
		if ( $from !== $src && minuto_redirect_path( $to ) === $src ) {
			return array( 'error' => "$from already redirects to $src, so redirecting $src would make a chain" );
		}
	}
	if ( ! isset( $store[ $src ] ) && count( $store ) >= MINUTO_REDIRECTS_MAX ) {
		return array( 'error' => 'too many redirects (' . MINUTO_REDIRECTS_MAX . ')' );
	}
	$query = parse_url( $target, PHP_URL_QUERY );
	return array( 'source' => $src, 'target' => rtrim( home_url( '/' ), '/' ) . implode( '/', array_map( 'rawurlencode', explode( '/', $dst ) ) ) . ( $query ? "?$query" : '' ) );
}

/** Pure: where a request should go, or null. Keeps the request's query string. */
function minuto_redirect_match( $request_uri, array $store ) {
	$path = minuto_redirect_path( (string) $request_uri );
	if ( '' === $path || ! isset( $store[ $path ] ) ) {
		return null;
	}
	$to    = $store[ $path ];
	$query = parse_url( (string) $request_uri, PHP_URL_QUERY );
	if ( $query && false === strpos( $to, '?' ) ) {
		$to .= "?$query";
	}
	return $to;
}

function minuto_redirects_store() {
	$s = get_option( MINUTO_REDIRECTS_OPTION, array() );
	return is_array( $s ) ? $s : array();
}

function minuto_redirects_template_redirect() {
	if ( is_admin() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
		return;
	}
	$store = minuto_redirects_store();
	if ( ! $store ) {
		return;
	}
	$to = minuto_redirect_match( isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '', $store );
	if ( $to ) {
		wp_safe_redirect( $to, 301, 'Minuto SEO' );
		exit;
	}
}
add_action( 'template_redirect', 'minuto_redirects_template_redirect', 1 );

function minuto_redirects_register_routes() {
	$perm = function () { return current_user_can( 'edit_others_posts' ); };
	register_rest_route( 'minuto-faq/v1', '/redirect', array(
		array( 'methods' => 'GET', 'permission_callback' => $perm, 'callback' => 'minuto_redirects_rest_get' ),
		array( 'methods' => 'POST', 'permission_callback' => $perm, 'callback' => 'minuto_redirects_rest_set' ),
	) );
}
add_action( 'rest_api_init', 'minuto_redirects_register_routes' );

function minuto_redirects_response( $src ) {
	$store = minuto_redirects_store();
	return rest_ensure_response( array( 'success' => true, 'source' => $src, 'target' => isset( $store[ $src ] ) ? $store[ $src ] : null, 'count' => count( $store ) ) );
}

function minuto_redirects_rest_get( WP_REST_Request $request ) {
	$src = minuto_redirect_path( (string) $request->get_param( 'source' ) );
	if ( '' === $src ) {
		return new WP_Error( 'minuto_redirect_invalid', 'source is required', array( 'status' => 422 ) );
	}
	return minuto_redirects_response( $src );
}

function minuto_redirects_rest_set( WP_REST_Request $request ) {
	$body  = $request->get_json_params();
	$store = minuto_redirects_store();
	$v     = minuto_redirect_validate( isset( $body['source'] ) ? $body['source'] : '', isset( $body['target'] ) ? $body['target'] : null, $store, home_url( '/' ) );
	if ( isset( $v['error'] ) ) {
		return new WP_Error( 'minuto_redirect_invalid', $v['error'], array( 'status' => 422 ) );
	}
	if ( '' === $v['target'] ) {
		unset( $store[ $v['source'] ] );
	} else {
		$store[ $v['source'] ] = $v['target'];
	}
	update_option( MINUTO_REDIRECTS_OPTION, $store, true );
	// The cached copy of the source page would hide the redirect (or its removal).
	$url = home_url( implode( '/', array_map( 'rawurlencode', explode( '/', $v['source'] ) ) ) );
	if ( function_exists( 'rocket_clean_files' ) ) {
		rocket_clean_files( array( $url ) );
	}
	$post_id = url_to_postid( $url );
	if ( $post_id && function_exists( 'rocket_clean_post' ) ) {
		rocket_clean_post( $post_id );
	}
	// The sitemap must drop (or regain) the page too (includes/sitemap-cache.php).
	if ( function_exists( 'minuto_sitemap_invalidate' ) ) {
		minuto_sitemap_invalidate();
	}
	return minuto_redirects_response( $v['source'] );
}
