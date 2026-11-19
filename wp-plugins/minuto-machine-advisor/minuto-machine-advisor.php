<?php
/**
 * Plugin Name: Minuto Machine Advisor
 * Description: "איזו מכונה מתאימה לי?" advisor. Place [minuto_machine_advisor] on a page.
 * Version: 1.0.0
 * Author: Minuto
 * Requires Plugins: woocommerce
 *
 * The rules live in assets/engine.js (tested by engine_test.ts); the machines
 * it knows are in machines.php. This file serves the catalog: which of those
 * machines are on sale right now, with photo, price and link. It comes through
 * a short-cached REST route rather than the page HTML, because WP Rocket
 * caches the page itself. Only machines that are published, in stock and
 * visible in the shop are served (owner, 2026-11-18).
 *
 * Each result also names a coffee, using the coffee quiz's own rules and live
 * stock (the minuto-coffee-quiz plugin). Without that plugin the machines
 * still show, just without the coffee line.
 */

if (!defined('ABSPATH')) exit;

define('MINUTO_ADVISOR_VERSION', '1.0.0');
define('MINUTO_ADVISOR_CACHE_KEY', 'minuto_advisor_catalog');
define('MINUTO_ADVISOR_WHATSAPP', '972544490486');   // the number on the site
define('MINUTO_ADVISOR_QUIZ_PATH', '/coffee-quiz/');
define('MINUTO_ADVISOR_MACHINES_CATEGORY_ID', 394);  // מכונות קפה

function minuto_advisor_machines(): array {
    static $machines = null;
    if ($machines === null) $machines = require __DIR__ . '/machines.php';
    return $machines;
}

/** Plain text for the browser, which renders it with textContent. */
function minuto_advisor_text(string $html): string {
    return trim(html_entity_decode(wp_strip_all_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

/** On sale and findable in the shop. Search-only and hidden don't count. */
function minuto_advisor_on_sale(WC_Product $p): bool {
    return $p->get_status() === 'publish'
        && $p->is_in_stock()
        && in_array($p->get_catalog_visibility(), ['visible', 'catalog'], true)
        && (float) $p->get_price() > 0;
}

function minuto_advisor_catalog(): array {
    $cached = get_transient(MINUTO_ADVISOR_CACHE_KEY);
    if (is_array($cached)) return $cached;

    $items = [];
    foreach (minuto_advisor_machines() as $key => $m) {
        // A model in several colours shows once, as its cheapest one on sale.
        $best = null;
        foreach ($m['ids'] as $id) {
            $p = wc_get_product((int) $id);
            if (!$p || !minuto_advisor_on_sale($p)) continue;
            if (!$best || (float) $p->get_price() < (float) $best->get_price()) $best = $p;
        }
        if (!$best) continue;
        $image = wp_get_attachment_image_url($best->get_image_id(), 'woocommerce_thumbnail') ?: wc_placeholder_img_src('woocommerce_thumbnail');
        $items[] = [
            'key'     => $key,
            'brand'   => $m['brand'],
            'kind'    => $m['kind'],
            'milk'    => $m['milk'] ?? null,
            'boiler'  => $m['boiler'] ?? null,
            'grinder' => !empty($m['grinder']),
            'plumb'   => !empty($m['plumb']),
            'takes'   => $m['takes'] ?? [],
            'name'    => minuto_advisor_text($best->get_name()),
            'url'     => esc_url_raw($best->get_permalink()),
            'image'   => $image ? esc_url_raw($image) : '',
            'price'   => (float) $best->get_price(),
            'price_text' => minuto_advisor_text(wc_price((float) $best->get_price())),
        ];
    }
    // An empty catalog means something is wrong: don't pin it for 15 minutes.
    if ($items) set_transient(MINUTO_ADVISOR_CACHE_KEY, $items, 15 * MINUTE_IN_SECONDS);
    return $items;
}

// Stock and visibility must not lag: refresh as soon as a product changes.
function minuto_advisor_flush_catalog(): void {
    delete_transient(MINUTO_ADVISOR_CACHE_KEY);
}
add_action('woocommerce_product_set_stock_status', 'minuto_advisor_flush_catalog');
add_action('woocommerce_variation_set_stock_status', 'minuto_advisor_flush_catalog');
add_action('woocommerce_update_product', 'minuto_advisor_flush_catalog');
register_deactivation_hook(__FILE__, 'minuto_advisor_flush_catalog');

// WP Rocket's "Delay JS" would hold the advisor back until the visitor
// interacts, and its minified copy can outlive a plugin update.
add_filter('rocket_delay_js_exclusions', function ($excluded) {
    $excluded[] = 'minuto-machine-advisor/assets/';
    return $excluded;
});
add_filter('rocket_exclude_js', function ($excluded) {
    $excluded[] = wp_make_link_relative(plugins_url('assets/', __FILE__)) . '(.*).js';
    return $excluded;
});

add_action('rest_api_init', function () {
    if (!class_exists('WooCommerce')) return;
    register_rest_route('minuto-advisor/v1', '/catalog', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',   // public catalog data, read-only
        'callback'            => fn() => rest_ensure_response(minuto_advisor_catalog()),
    ]);
});

add_shortcode('minuto_machine_advisor', function () {
    if (!class_exists('WooCommerce')) return '';
    $base = plugin_dir_url(__FILE__) . 'assets/';
    wp_enqueue_style('minuto-advisor', $base . 'advisor.css', [], MINUTO_ADVISOR_VERSION);
    wp_enqueue_script('minuto-advisor-engine', $base . 'engine.js', [], MINUTO_ADVISOR_VERSION, true);
    $deps = ['minuto-advisor-engine'];

    // The coffee quiz's rules pick the coffee for each machine.
    $quiz_catalog = '';
    if (function_exists('minuto_quiz_catalog') && defined('MINUTO_QUIZ_VERSION')) {
        $quiz_engine = WP_PLUGIN_DIR . '/minuto-coffee-quiz/assets/engine.js';
        if (is_readable($quiz_engine)) {
            wp_enqueue_script('minuto-quiz-engine', plugins_url('minuto-coffee-quiz/assets/engine.js'), [], MINUTO_QUIZ_VERSION, true);
            $deps[] = 'minuto-quiz-engine';
            $quiz_catalog = rest_url('minuto-quiz/v1/catalog');
        }
    }
    wp_enqueue_script('minuto-advisor', $base . 'advisor.js', $deps, MINUTO_ADVISOR_VERSION, true);

    $link = get_term_link(MINUTO_ADVISOR_MACHINES_CATEGORY_ID, 'product_cat');
    $machines = esc_url(is_wp_error($link) ? wc_get_page_permalink('shop') : $link);
    return '<div id="minuto-machine-advisor" dir="rtl" aria-live="polite"'
        . ' data-catalog="' . esc_url(rest_url('minuto-advisor/v1/catalog')) . '"'
        . ' data-coffee="' . esc_url($quiz_catalog) . '"'
        . ' data-quiz="' . esc_url(home_url(MINUTO_ADVISOR_QUIZ_PATH)) . '"'
        . ' data-whatsapp="' . esc_attr(MINUTO_ADVISOR_WHATSAPP) . '"'
        . ' data-machines="' . $machines . '">'
        . '<noscript><a href="' . $machines . '">לכל מכונות הקפה</a></noscript></div>';
});
