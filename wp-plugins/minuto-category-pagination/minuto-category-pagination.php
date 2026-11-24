<?php
/**
 * Plugin Name:       Minuto Category Pagination
 * Description:       Lets Google reach every product in a category: real page links (?page=N), a canonical per page, and redirects from the broken /page/N/ addresses.
 * Version:           0.1.0
 * Author:            Minuto Cafe
 * Requires at least: 6.0
 * Requires PHP:      7.4
 *
 * Why: the theme's products-grid (Livewire) pages with a "next" button that
 * loads products by JavaScript. Google follows links, not buttons, so it saw
 * only the first 12 products of each category. ?page=N already renders the
 * right products on the server, but (1) nothing links to it, (2) Rank Math's
 * canonical on ?page=N points to page 1, and (3) rel=next points to
 * /page/N/, which repeats page 1 (page 3+ redirect to the home page).
 *
 * Safety: Settings → Minuto pagination. Mode "test" (the default) changes only
 * the categories listed there; "on" changes every product category; "off" or
 * deactivating the plugin removes every change at once. Nothing is written to
 * products or categories. Filtered or sorted listings are left alone.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/includes/core.php';

const MCP_OPT_MODE  = 'mcp_mode';        // off | test | on
const MCP_OPT_TERMS = 'mcp_test_terms';  // comma-separated product_cat ids used in test mode

/** Default test category: אביזרי קפה › חומרי ניקוי ותחזוקה לקפה (id 402). */
function mcp_mode() {
	$m = get_option( MCP_OPT_MODE, 'test' );
	return in_array( $m, array( 'off', 'test', 'on' ), true ) ? $m : 'off';
}
function mcp_test_terms() {
	$raw = (string) get_option( MCP_OPT_TERMS, '402' );
	return array_values( array_filter( array_map( 'intval', preg_split( '/[\s,]+/', $raw ) ) ) );
}

/** Number of products the theme's grid lists for a category (same query it uses). */
function mcp_found_products( $term_id ) {
	$key   = 'mcp_found_' . (int) $term_id;
	$found = wp_cache_get( $key, 'mcp' );
	if ( false !== $found ) {
		return (int) $found;
	}
	$q     = new WP_Query(
		array(
			'post_type'      => 'product',
			'post_status'    => 'publish',
			'posts_per_page' => 1,
			'fields'         => 'ids',
			'no_found_rows'  => false,
			'tax_query'      => array(
				'relation' => 'AND',
				array( 'taxonomy' => 'product_visibility', 'field' => 'name', 'terms' => 'exclude-from-catalog', 'operator' => 'NOT IN' ),
				array( 'taxonomy' => 'product_visibility', 'field' => 'name', 'terms' => 'exclude-from-search', 'operator' => 'NOT IN' ),
				array( 'taxonomy' => 'product_cat', 'field' => 'id', 'terms' => (int) $term_id ),
			),
		)
	);
	$found = (int) $q->found_posts;
	wp_cache_set( $key, $found, 'mcp', 300 );
	return $found;
}

/**
 * The current category listing, when the plugin applies to it:
 * array( term_id, url, current, total ), or null.
 */
function mcp_context() {
	static $ctx = false;
	if ( false !== $ctx ) {
		return $ctx;
	}
	$ctx = null;
	if ( is_admin() || ! function_exists( 'is_product_category' ) || ! is_product_category() ) {
		return $ctx;
	}
	$term = get_queried_object();
	if ( ! $term || empty( $term->term_id ) || ! mcp_enabled_for( mcp_mode(), mcp_test_terms(), $term->term_id ) ) {
		return $ctx;
	}
	if ( mcp_has_filters( $_GET ) ) { // phpcs:ignore WordPress.Security.NonceVerification -- read-only
		return $ctx;
	}
	$url = get_term_link( $term );
	if ( is_wp_error( $url ) ) {
		return $ctx;
	}
	$total   = mcp_total_pages( mcp_found_products( $term->term_id ) );
	$current = mcp_requested_page( $_GET ); // phpcs:ignore WordPress.Security.NonceVerification -- read-only
	if ( $current > $total ) {
		return $ctx; // past the last page: leave the theme's behaviour as it is
	}
	$ctx = array( 'term_id' => (int) $term->term_id, 'url' => $url, 'current' => $current, 'total' => $total );
	return $ctx;
}

// ── 1. Canonical and prev/next (Rank Math) ──────────────────────────────────
add_filter(
	'rank_math/frontend/canonical',
	function ( $canonical ) {
		$c = mcp_context();
		return ( $c && $c['current'] > 1 ) ? mcp_page_url( $c['url'], $c['current'] ) : $canonical;
	},
	20
);
add_filter(
	'rank_math/frontend/next_rel_link',
	function ( $link ) {
		$c = mcp_context();
		return $c ? mcp_rel_links( $c['url'], $c['current'], $c['total'] )['next'] : $link;
	},
	20
);
add_filter(
	'rank_math/frontend/prev_rel_link',
	function ( $link ) {
		$c = mcp_context();
		return $c ? mcp_rel_links( $c['url'], $c['current'], $c['total'] )['prev'] : $link;
	},
	20
);

// ── 2. Real page links under the grid ───────────────────────────────────────
// The theme does not fire WooCommerce's loop hooks (see minuto-product-faq
// notes), so the links are printed at wp_footer and a small script moves them
// right after the products-grid component. Without JavaScript they stay at
// the bottom of the page — still real links in the HTML.
add_action(
	'wp_footer',
	function () {
		$c = mcp_context();
		if ( ! $c ) {
			return;
		}
		$html = mcp_nav_html( $c['url'], $c['current'], $c['total'] );
		if ( '' === $html ) {
			return;
		}
		echo '<style>.mcp-pagination{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:center;margin:1.5rem auto;padding:0 1rem;font-size:.95rem;box-sizing:border-box;max-width:100%}.mcp-pagination a,.mcp-pagination .mcp-current{min-width:2.25rem;padding:.35rem .6rem;border:1px solid currentColor;border-radius:.4rem;text-align:center;text-decoration:none;color:inherit}.mcp-pagination .mcp-current{font-weight:700;opacity:.6}.mcp-pagination .mcp-gap{opacity:.6}</style>';
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput -- built and escaped in mcp_nav_html
		echo '<script>(function(){var nav=document.querySelector(".mcp-pagination");if(!nav)return;var els=document.querySelectorAll("[wire\\\\:snapshot]");for(var i=0;i<els.length;i++){var s=els[i].getAttribute("wire:snapshot")||"";if(s.indexOf("\\"name\\":\\"products-grid\\"")!==-1){els[i].insertAdjacentElement("afterend",nav);return;}}})();</script>';
	},
	5
);

// ── 3. Old /page/N/ addresses → ?page=N ──────────────────────────────────────
// Runs at parse_request, before WordPress decides the page is a 404 and Rank
// Math sends page 3+ to the home page.
add_action(
	'parse_request',
	function () {
		if ( is_admin() || empty( $_SERVER['REQUEST_URI'] ) ) {
			return;
		}
		$legacy = mcp_parse_legacy_path( wp_unslash( $_SERVER['REQUEST_URI'] ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput -- matched by a strict pattern
		if ( ! $legacy ) {
			return;
		}
		$term = get_term_by( 'slug', sanitize_title( mcp_slug_from_path( $legacy['path'] ) ), 'product_cat' );
		if ( ! $term || ! mcp_enabled_for( mcp_mode(), mcp_test_terms(), $term->term_id ) ) {
			return;
		}
		$url = get_term_link( $term );
		if ( is_wp_error( $url ) ) {
			return;
		}
		// The path must be this category's own path (a slug can repeat under other parents).
		$own = trim( rawurldecode( (string) wp_parse_url( $url, PHP_URL_PATH ) ), '/' );
		if ( strtolower( $own ) !== strtolower( 'product-category/' . trim( rawurldecode( $legacy['path'] ), '/' ) ) ) {
			return;
		}
		wp_safe_redirect( mcp_page_url( $url, $legacy['page'] ), 301, 'Minuto Category Pagination' );
		exit;
	},
	1
);

// ── Settings → Minuto pagination ────────────────────────────────────────────
add_action(
	'admin_init',
	function () {
		register_setting( 'mcp', MCP_OPT_MODE, array( 'type' => 'string', 'default' => 'test', 'sanitize_callback' => function ( $v ) { return in_array( $v, array( 'off', 'test', 'on' ), true ) ? $v : 'off'; } ) );
		register_setting( 'mcp', MCP_OPT_TERMS, array( 'type' => 'string', 'default' => '402', 'sanitize_callback' => function ( $v ) { return implode( ',', array_filter( array_map( 'intval', preg_split( '/[\s,]+/', (string) $v ) ) ) ); } ) );
	}
);
add_action(
	'admin_menu',
	function () {
		add_options_page(
			'Minuto pagination',
			'Minuto pagination',
			'manage_options',
			'minuto-pagination',
			function () {
				$mode = mcp_mode();
				?>
				<div class="wrap">
					<h1>Minuto category pagination</h1>
					<p>Adds real page links to product categories so Google can reach every product, fixes the canonical of each page, and redirects old <code>/page/N/</code> addresses to <code>?page=N</code>.</p>
					<form method="post" action="options.php">
						<?php settings_fields( 'mcp' ); ?>
						<table class="form-table" role="presentation">
							<tr><th scope="row"><label for="mcp_mode">Mode</label></th><td>
								<select id="mcp_mode" name="<?php echo esc_attr( MCP_OPT_MODE ); ?>">
									<option value="off" <?php selected( $mode, 'off' ); ?>>Off — no changes</option>
									<option value="test" <?php selected( $mode, 'test' ); ?>>Test — only the categories below</option>
									<option value="on" <?php selected( $mode, 'on' ); ?>>On — every product category</option>
								</select></td></tr>
							<tr><th scope="row"><label for="mcp_terms">Test categories (ids)</label></th><td>
								<input id="mcp_terms" type="text" class="regular-text" name="<?php echo esc_attr( MCP_OPT_TERMS ); ?>" value="<?php echo esc_attr( implode( ',', mcp_test_terms() ) ); ?>" />
								<p class="description">Comma-separated. 402 = חומרי ניקוי ותחזוקה לקפה. After saving, clear the WP Rocket cache.</p></td></tr>
						</table>
						<?php submit_button(); ?>
					</form>
				</div>
				<?php
			}
		);
	}
);
