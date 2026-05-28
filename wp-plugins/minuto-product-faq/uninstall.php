<?php
/**
 * Minuto Product FAQ — uninstall handler.
 *
 * Runs automatically when the plugin is deleted from WP Admin → Plugins
 * (NOT on deactivate — only on full delete). Removes all FAQ data so no
 * traces remain in the database.
 *
 * If the plugin is reactivated later (re-uploaded), the data is gone and
 * must be restored from the backup at faq-backups/ in the CoffeeFlow repo.
 */

// Guard: WordPress sets WP_UNINSTALL_PLUGIN before including this file.
// Refuse to run if someone calls it directly.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

// Delete every row of _minuto_faq_published from the postmeta table.
// One DELETE statement, no per-product loop.
$wpdb->delete(
	$wpdb->postmeta,
	array( 'meta_key' => '_minuto_faq_published' ),
	array( '%s' )
);
