<?php
/**
 * Minuto Category Pagination — pure helpers (no WordPress calls), so they can
 * be unit-tested with plain PHP: php tests/core_test.php
 */

if ( ! defined( 'MCP_PER_PAGE' ) ) {
	// Matches the theme's products-grid component (perPage: 12, posts_per_page: 12).
	define( 'MCP_PER_PAGE', 12 );
}

/**
 * Query-string keys the theme's grid uses for filters and sorting. When any is
 * present the page shows a filtered list, so the plugin leaves it alone
 * (Rank Math's default canonical to the category is right for those).
 */
function mcp_filter_keys() {
	return array( 'price_min', 'price_max', 'selected_brand', 'selected_type', 'selected_size', 'selected_strong', 'selected_taste', 'selected_match', 'selected_roast', 'sort', 'show_categories', 's' );
}

/** The ?page=N the visitor asked for (1 when missing, not a number, or below 1). */
function mcp_requested_page( array $get ) {
	if ( ! isset( $get['page'] ) || ! is_scalar( $get['page'] ) || ! preg_match( '/^\d{1,5}$/', (string) $get['page'] ) ) {
		return 1;
	}
	return max( 1, (int) $get['page'] );
}

/** True when the request carries a grid filter or sort (see mcp_filter_keys). */
function mcp_has_filters( array $get ) {
	foreach ( mcp_filter_keys() as $k ) {
		if ( isset( $get[ $k ] ) && '' !== $get[ $k ] && array() !== $get[ $k ] ) {
			return true;
		}
	}
	return false;
}

/** Number of listing pages for a product count (at least 1). */
function mcp_total_pages( $found, $per_page = MCP_PER_PAGE ) {
	$found    = max( 0, (int) $found );
	$per_page = max( 1, (int) $per_page );
	return max( 1, (int) ceil( $found / $per_page ) );
}

/** URL of listing page $n of a category: page 1 is the category itself, others ?page=N. */
function mcp_page_url( $term_url, $n ) {
	$n    = (int) $n;
	$base = strtok( $term_url, '?#' );
	return $n <= 1 ? $base : $base . '?page=' . $n;
}

/**
 * Parse a legacy /product-category/<path>/page/<N>/ request path.
 * Returns array( 'path' => 'a/b', 'page' => N ) or null. The path keeps its
 * URL encoding; the last segment is the category slug.
 */
function mcp_parse_legacy_path( $request_path ) {
	$path = strtok( (string) $request_path, '?#' );
	if ( ! preg_match( '#^/product-category/(.+?)/page/(\d{1,5})/?$#', $path, $m ) ) {
		return null;
	}
	return array( 'path' => $m[1], 'page' => max( 1, (int) $m[2] ) );
}

/** The category slug from a parsed legacy path (last segment, URL-decoded). */
function mcp_slug_from_path( $path ) {
	$parts = array_values( array_filter( explode( '/', (string) $path ), 'strlen' ) );
	return $parts ? rawurldecode( end( $parts ) ) : '';
}

/**
 * Page numbers to show: always 1 and the last, plus a window around the
 * current page; null marks a gap ("…").
 */
function mcp_page_numbers( $current, $total, $window = 2 ) {
	$current = max( 1, min( (int) $current, (int) $total ) );
	$total   = max( 1, (int) $total );
	$out     = array();
	$prev    = 0;
	for ( $i = 1; $i <= $total; $i++ ) {
		if ( 1 === $i || $total === $i || abs( $i - $current ) <= $window ) {
			if ( $prev && $i - $prev > 1 ) {
				$out[] = null;
			}
			$out[] = $i;
			$prev  = $i;
		}
	}
	return $out;
}

/** HTML for the page links (empty string when there is only one page). */
function mcp_nav_html( $term_url, $current, $total ) {
	$total = max( 1, (int) $total );
	if ( $total <= 1 ) {
		return '';
	}
	$esc   = function ( $s ) {
		return htmlspecialchars( (string) $s, ENT_QUOTES, 'UTF-8' );
	};
	$items = array();
	foreach ( mcp_page_numbers( $current, $total ) as $n ) {
		if ( null === $n ) {
			$items[] = '<span class="mcp-gap" aria-hidden="true">…</span>';
		} elseif ( $n === (int) $current ) {
			$items[] = '<span class="mcp-current" aria-current="page">' . $n . '</span>';
		} else {
			$items[] = '<a href="' . $esc( mcp_page_url( $term_url, $n ) ) . '">' . $n . '</a>';
		}
	}
	return '<nav class="mcp-pagination" aria-label="עמודי הקטגוריה" dir="rtl"><span class="mcp-label">עמודים:</span> ' . implode( ' ', $items ) . '</nav>';
}

/** <link rel="prev|next"> tags for page $current of $total (each only where it exists). */
function mcp_rel_links( $term_url, $current, $total ) {
	$esc = function ( $s ) {
		return htmlspecialchars( (string) $s, ENT_QUOTES, 'UTF-8' );
	};
	$out = array( 'prev' => '', 'next' => '' );
	if ( $current > 1 ) {
		$out['prev'] = '<link rel="prev" href="' . $esc( mcp_page_url( $term_url, $current - 1 ) ) . '" />';
	}
	if ( $current < $total ) {
		$out['next'] = '<link rel="next" href="' . $esc( mcp_page_url( $term_url, $current + 1 ) ) . '" />';
	}
	return $out;
}

/** Is the plugin active for this category? $mode: off | test | on. */
function mcp_enabled_for( $mode, array $test_term_ids, $term_id ) {
	if ( 'on' === $mode ) {
		return true;
	}
	if ( 'test' === $mode ) {
		return in_array( (int) $term_id, array_map( 'intval', $test_term_ids ), true );
	}
	return false;
}
