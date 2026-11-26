<?php
/**
 * Minuto Product FAQ — v0.7.1: keep Rank Math's sitemap in step with merges.
 *
 * Rank Math stores each generated sitemap as a FILE (uploads/rank-math/…) plus
 * transients. When a merge takes a blog post offline through the REST API, the
 * stored post sitemap kept listing it ("Remove Transients" deletes only the
 * transients, not the files). This asks Rank Math to rebuild — its own
 * \RankMath\Sitemap\Cache::invalidate_storage(), which deletes both — when:
 *   - a post, page or product goes from published to anything else, or back;
 *   - a redirect is set or removed (includes/redirects.php);
 *   - once after this version is installed (clears what an earlier merge left).
 * At most once per request, at shutdown. Does nothing without Rank Math.
 * The once-after-update marker is autoloaded: no extra query per request.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const MINUTO_SITEMAP_FLUSHED_OPTION = 'minuto_faq_sitemap_flushed_version';
const MINUTO_SITEMAP_FLUSH_VERSION  = '0.7.1';

/** Pure: does this status change add a page to the sitemap or remove one? */
function minuto_sitemap_status_changes( $new_status, $old_status ) {
	return $new_status !== $old_status && ( 'publish' === $new_status || 'publish' === $old_status );
}

/** Rank Math rebuilds its sitemap on the next request. Returns whether Rank Math was there to ask. */
function minuto_sitemap_invalidate_now() {
	if ( class_exists( '\RankMath\Sitemap\Cache' ) && method_exists( '\RankMath\Sitemap\Cache', 'invalidate_storage' ) ) {
		\RankMath\Sitemap\Cache::invalidate_storage();
		return true;
	}
	return false;
}

/** Queue one rebuild for the end of this request (several changes → one rebuild). */
function minuto_sitemap_invalidate() {
	static $queued = false;
	if ( $queued ) {
		return;
	}
	$queued = true;
	add_action( 'shutdown', 'minuto_sitemap_invalidate_now' );
}

function minuto_sitemap_on_status( $new_status, $old_status, $post ) {
	if ( ! $post || ! in_array( $post->post_type, array( 'post', 'page', 'product' ), true ) ) {
		return;
	}
	if ( minuto_sitemap_status_changes( $new_status, $old_status ) ) {
		minuto_sitemap_invalidate();
	}
}
add_action( 'transition_post_status', 'minuto_sitemap_on_status', 20, 3 );

/** Once per plugin version: clears a stale sitemap left before this version existed. */
function minuto_sitemap_once_after_update() {
	// Autoloaded option: an in-memory check, no query, on every later request.
	if ( MINUTO_SITEMAP_FLUSH_VERSION === get_option( MINUTO_SITEMAP_FLUSHED_OPTION ) ) {
		return;
	}
	minuto_sitemap_invalidate_now(); // does nothing without Rank Math
	// Saved either way, so this runs once per plugin version, never on every request.
	update_option( MINUTO_SITEMAP_FLUSHED_OPTION, MINUTO_SITEMAP_FLUSH_VERSION, true );
}
add_action( 'init', 'minuto_sitemap_once_after_update', 99 );
