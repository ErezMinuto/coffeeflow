<?php
/**
 * Minuto Product FAQ — uninstall handler.
 *
 * WordPress runs this file when the plugin is DELETED from WP Admin → Plugins
 * (not on deactivate). Since v0.5.1 it KEEPS all FAQ data by default.
 *
 * Why: up to v0.5.0 this file deleted every `_minuto_faq_published` post_meta
 * row. On 2026-11-23 the plugin was updated by deleting the old version and
 * uploading the new one. The delete ran this file and erased every FAQ on
 * every product and blog post; they had to be restored by hand from backups.
 * Deleting a plugin is the normal way people "update" it, so this file must
 * never destroy content as a side effect.
 *
 * To update the plugin: Plugins → Add New → Upload Plugin → choose the zip →
 * "Replace current with uploaded". Never delete and re-upload.
 *
 * To really remove all FAQ data (rarely wanted), add this line to
 * wp-config.php first, then delete the plugin, then remove the line again:
 *
 *     define( 'MINUTO_FAQ_DELETE_DATA_ON_UNINSTALL', true );
 */

// Guard: WordPress sets WP_UNINSTALL_PLUGIN before including this file.
// Refuse to run if someone calls it directly.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

// Default: keep the FAQ data. Only an explicit opt-in deletes it.
if ( ! defined( 'MINUTO_FAQ_DELETE_DATA_ON_UNINSTALL' ) || true !== MINUTO_FAQ_DELETE_DATA_ON_UNINSTALL ) {
	return;
}

global $wpdb;

// Explicit opt-in: delete every `_minuto_faq_published` row in one statement.
$wpdb->delete(
	$wpdb->postmeta,
	array( 'meta_key' => '_minuto_faq_published' ),
	array( '%s' )
);
