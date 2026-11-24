<?php
/**
 * Minuto Product FAQ — v0.6.0: Rank Math SEO fields over REST.
 *
 * The SEO agent (through CoffeeFlow's change log: back up, write, log) reads
 * and writes the Rank Math title, description and focus keyword of a post,
 * product or product category. Rank Math keeps them in post/term meta that
 * the core REST API does not expose, so this adds two authenticated routes:
 *
 *   GET  /wp-json/minuto-faq/v1/seo/<type>/<id>
 *   POST /wp-json/minuto-faq/v1/seo/<type>/<id>   body: { title?, description?, focus_keyword? }
 *
 *   <type> = post (any post, page or product: they share one id space) | product_cat
 *
 * A key left out of the body is left alone; an empty string deletes the
 * field, so Rank Math falls back to its template (this is how an undo
 * restores a page that had no custom value). Both routes need an
 * authenticated user who may edit that very post or term (WP Application
 * Password, like the FAQ routes). After a write the page's WP Rocket cache
 * is cleared, otherwise visitors and Google keep the old version.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Field name in the API → Rank Math meta key, with the longest value accepted. */
function minuto_seo_fields() {
	return array(
		'title'         => array( 'key' => 'rank_math_title', 'max' => 200 ),
		'description'   => array( 'key' => 'rank_math_description', 'max' => 500 ),
		'focus_keyword' => array( 'key' => 'rank_math_focus_keyword', 'max' => 200 ),
	);
}

/**
 * Pure: the writes a request body asks for. Returns array( field => string )
 * ('' = delete), or WP_Error-like array( 'error' => message ). Unknown keys are
 * refused so a typo cannot silently do nothing.
 */
function minuto_seo_parse_body( $body ) {
	if ( ! is_array( $body ) ) {
		return array( 'error' => 'body must be a JSON object' );
	}
	$fields = minuto_seo_fields();
	$out    = array();
	foreach ( $body as $k => $v ) {
		if ( ! isset( $fields[ $k ] ) ) {
			return array( 'error' => "unknown field: $k (allowed: title, description, focus_keyword)" );
		}
		if ( ! is_string( $v ) ) {
			return array( 'error' => "$k must be a string ('' removes it)" );
		}
		$clean = trim( preg_replace( '/\s+/u', ' ', wp_strip_all_tags( $v ) ) );
		if ( function_exists( 'mb_strlen' ) ? mb_strlen( $clean ) > $fields[ $k ]['max'] : strlen( $clean ) > $fields[ $k ]['max'] ) {
			return array( 'error' => "$k is longer than {$fields[ $k ]['max']} characters" );
		}
		$out[ $k ] = $clean;
	}
	if ( ! $out ) {
		return array( 'error' => 'nothing to write: send title, description and/or focus_keyword' );
	}
	return $out;
}

/** The object a route names: array( 'kind' => post|term, 'id', 'url', 'name' ), or WP_Error. */
function minuto_seo_target( $type, $id ) {
	$id = (int) $id;
	if ( 'product_cat' === $type ) {
		$term = get_term( $id, 'product_cat' );
		if ( ! $term || is_wp_error( $term ) ) {
			return new WP_Error( 'minuto_seo_not_found', 'Category not found', array( 'status' => 404 ) );
		}
		if ( ! current_user_can( 'edit_term', $id ) ) {
			return new WP_Error( 'minuto_seo_forbidden', 'Insufficient permission to edit this category', array( 'status' => 403 ) );
		}
		$url = get_term_link( $term );
		return array( 'kind' => 'term', 'id' => $id, 'url' => is_wp_error( $url ) ? '' : $url, 'name' => $term->name );
	}
	$post = get_post( $id );
	if ( ! $post || ! in_array( get_post_type( $id ), array( 'post', 'page', 'product' ), true ) ) {
		return new WP_Error( 'minuto_seo_not_found', "No post, page or product with id $id", array( 'status' => 404 ) );
	}
	if ( ! current_user_can( 'edit_post', $id ) ) {
		return new WP_Error( 'minuto_seo_forbidden', 'Insufficient permission to edit this item', array( 'status' => 403 ) );
	}
	return array( 'kind' => 'post', 'id' => $id, 'url' => (string) get_permalink( $id ), 'name' => get_the_title( $id ) );
}

/** The stored values (raw, as Rank Math keeps them; '' = no custom value). */
function minuto_seo_read( $t ) {
	$out = array();
	foreach ( minuto_seo_fields() as $field => $def ) {
		$v             = 'term' === $t['kind'] ? get_term_meta( $t['id'], $def['key'], true ) : get_post_meta( $t['id'], $def['key'], true );
		$out[ $field ] = is_string( $v ) ? $v : '';
	}
	return $out;
}

function minuto_seo_response( $type, $t ) {
	return rest_ensure_response( array(
		'success' => true,
		'type'    => $type,
		'id'      => $t['id'],
		'name'    => $t['name'],
		'url'     => $t['url'],
		'meta'    => minuto_seo_read( $t ),
	) );
}

function minuto_seo_register_routes() {
	$args = array(
		'type' => array( 'validate_callback' => function ( $p ) { return in_array( $p, array( 'post', 'product_cat' ), true ); } ),
		'id'   => array( 'validate_callback' => function ( $p ) { return is_numeric( $p ); } ),
	);
	register_rest_route( 'minuto-faq/v1', '/seo/(?P<type>post|product_cat)/(?P<id>\d+)', array(
		array(
			'methods'             => 'GET',
			// Base gate; the per-object check runs once the id is known.
			'permission_callback' => function () { return current_user_can( 'edit_posts' ); },
			'args'                => $args,
			'callback'            => 'minuto_seo_rest_get',
		),
		array(
			'methods'             => 'POST',
			'permission_callback' => function () { return current_user_can( 'edit_posts' ); },
			'args'                => $args,
			'callback'            => 'minuto_seo_rest_set',
		),
	) );
}
add_action( 'rest_api_init', 'minuto_seo_register_routes' );

function minuto_seo_rest_get( WP_REST_Request $request ) {
	$t = minuto_seo_target( $request['type'], $request['id'] );
	return is_wp_error( $t ) ? $t : minuto_seo_response( $request['type'], $t );
}

function minuto_seo_rest_set( WP_REST_Request $request ) {
	$t = minuto_seo_target( $request['type'], $request['id'] );
	if ( is_wp_error( $t ) ) {
		return $t;
	}
	$writes = minuto_seo_parse_body( $request->get_json_params() );
	if ( isset( $writes['error'] ) ) {
		return new WP_Error( 'minuto_seo_invalid', $writes['error'], array( 'status' => 422 ) );
	}
	$fields = minuto_seo_fields();
	foreach ( $writes as $field => $value ) {
		$key = $fields[ $field ]['key'];
		if ( 'term' === $t['kind'] ) {
			'' === $value ? delete_term_meta( $t['id'], $key ) : update_term_meta( $t['id'], $key, wp_slash( $value ) );
		} else {
			'' === $value ? delete_post_meta( $t['id'], $key ) : update_post_meta( $t['id'], $key, wp_slash( $value ) );
		}
	}
	// Visitors and Google get the cached page until WP Rocket's copy is cleared.
	if ( 'term' === $t['kind'] && function_exists( 'rocket_clean_term' ) ) {
		rocket_clean_term( $t['id'], 'product_cat' );
	} elseif ( 'post' === $t['kind'] && function_exists( 'rocket_clean_post' ) ) {
		rocket_clean_post( $t['id'] );
	}
	return minuto_seo_response( $request['type'], $t );
}
