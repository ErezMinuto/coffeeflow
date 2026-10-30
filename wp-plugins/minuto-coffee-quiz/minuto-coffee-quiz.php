<?php
/**
 * Plugin Name: Minuto Coffee Quiz
 * Description: "איזה קפה מתאים לי?" quiz. Place [minuto_coffee_quiz] on a page.
 * Version: 1.0.1
 * Author: Minuto
 * Requires Plugins: woocommerce
 *
 * The rules live in assets/engine.js (tested by engine_test.ts). This file
 * serves the catalog: which coffees are in stock, with photo, price and link.
 * Stock comes through a short-cached REST route rather than the page HTML,
 * because WP Rocket caches the page itself.
 */

if (!defined('ABSPATH')) exit;

define('MINUTO_QUIZ_VERSION', '1.0.1');
define('MINUTO_QUIZ_CACHE_KEY', 'minuto_quiz_catalog');
define('MINUTO_QUIZ_ROAST_ATTRIBUTE_ID', 20);   // רמת קלייה
define('MINUTO_QUIZ_LIGHT_TERM', 'בהירה');

/** Quiz key → WooCommerce product, display name, one line on why. */
function minuto_quiz_coffees(): array {
    return [
        'aristo'      => [64702, 'אריסטו', 'שוקולד מריר ואגוזים קלויים, גוף חלק וקרמה עבה.'],
        'dark'        => [64860, 'Dark Chocolate', 'שוקולד ואגוזים, גוף מלא וחמיצות נמוכה.'],
        'sertao'      => [65175, 'Fazenda Sertão', 'דבש פירותי עם רמיזות שוקולד, גוף בינוני.'],
        'jungle'      => [65431, 'Jungle Java', 'גוף מלא, חמיצות עדינה וסיומת שוקולדית.'],
        'velvet'      => [64855, 'Velvet Star', 'פרחוני עם רמיזות של שוקולד מריר, גוף חלק.'],
        'antigua'     => [65179, 'Antigua גואטמלה', 'אגוז לוז ורמיזות שוקולד, גוף בינוני.'],
        'bensa_m'     => [65180, 'Daye Bensa', 'חלק, פירותי ומתוק, עם רמיזות של וניל ולבנדר.'],
        'bensa_l'     => [78450, 'Daye Bensa בקלייה בהירה', 'פירותי ומתוק, עם חמיצות לימונית ווניל.'],
        'kenya_m'     => [65135, 'Kenya AA+', 'חמיצות נוצצת ומתיקות עדינה.'],
        'kenya_l'     => [65463, 'Kenya AA+ בקלייה בהירה', 'פירות יער והדרים, גוף בינוני וסיומת נקייה.'],
        'guji'        => [65169, 'Guji אתיופיה', 'פירותי והדרי, עם סיומת מתוקה וניחוח דבש.'],
        'aji'         => [82540, 'Aji Bourbon Anaerobic', 'פירות טרופיים ומנגו, וסיומת ארוכה עם רמז לדבש.'],
        'leona'       => [80501, 'Sweet Leona', 'פרחים, תאנים וקני סוכר מקורמל.'],
        'yirgacheffe' => [65384, 'Yirgacheffe', 'הדרים ויסמין, ארומה פרחונית ורעננה.'],
        'intenso'     => [65204, 'אינטנסו', 'תערובת עוצמתית עם גוף מלא וקרמה עשירה.'],
        'trieste'     => [65189, 'טריאסט', 'קפה עז ואינטנסיבי עם רמיזות שוקולד מריר.'],
        'prestige'    => [65196, 'פרסטיז׳', 'שוקולד מריר, גוף מלא וקרמה עשירה.'],
        'decaf'       => [64734, 'נטול קפאין', 'עדין, קרמי ומתקתק, נטול בשיטת Water Process.'],
    ];
}

/** Every published coffee tagged light, so a new light roast joins by itself. */
function minuto_quiz_light_product_ids(): array {
    $taxonomy = wc_attribute_taxonomy_name_by_id(MINUTO_QUIZ_ROAST_ATTRIBUTE_ID);
    if (!$taxonomy || !taxonomy_exists($taxonomy)) return [];
    return array_map('intval', get_posts([
        'post_type'        => 'product',
        'post_status'      => 'publish',
        'numberposts'      => 50,
        'fields'           => 'ids',
        'suppress_filters' => false,
        'tax_query'        => [[
            'taxonomy' => $taxonomy,
            'field'    => 'name',
            'terms'    => [MINUTO_QUIZ_LIGHT_TERM],
        ]],
    ]));
}

/** Plain text for the browser, which renders it with textContent. */
function minuto_quiz_text(string $html): string {
    return trim(html_entity_decode(wp_strip_all_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

function minuto_quiz_item(string $key, WC_Product $p, string $name, string $why, bool $is_light): ?array {
    if (!$p->is_in_stock() || $p->get_status() !== 'publish') return null;
    $image = wp_get_attachment_image_url($p->get_image_id(), 'woocommerce_thumbnail');
    // Not $p->add_to_cart_url(): it builds on the current request, which here
    // is this REST route rather than a page of the store.
    $cart = $p->is_type('simple') && $p->is_purchasable()
        ? add_query_arg('add-to-cart', $p->get_id(), wc_get_cart_url())
        : '';
    return [
        'key'   => $key,
        'name'  => minuto_quiz_text($name),
        'why'   => minuto_quiz_text($why),
        'light' => $is_light,
        'url'   => esc_url_raw($p->get_permalink()),
        'image' => $image ? esc_url_raw($image) : '',
        'price' => minuto_quiz_text(wc_price((float) $p->get_price())),
        'cart'  => $cart ? esc_url_raw($cart) : '',   // others need a grind choice
    ];
}

function minuto_quiz_catalog(): array {
    $cached = get_transient(MINUTO_QUIZ_CACHE_KEY);
    if (is_array($cached)) return $cached;

    $light_ids = minuto_quiz_light_product_ids();
    $items = [];
    $known = [];
    foreach (minuto_quiz_coffees() as $key => [$id, $name, $why]) {
        $known[] = $id;
        $p = wc_get_product($id);
        if (!$p) continue;
        $item = minuto_quiz_item($key, $p, $name, $why, in_array($id, $light_ids, true));
        if ($item) $items[] = $item;
    }
    // A light roast added later: same rule, shown under its own product name.
    foreach (array_diff($light_ids, $known) as $id) {
        $p = wc_get_product($id);
        if (!$p || preg_match('/veneto|ירוק|green/iu', $p->get_name())) continue;
        $why = wp_trim_words(minuto_quiz_text($p->get_short_description()), 16);
        $item = minuto_quiz_item('light_' . $id, $p, $p->get_name(), $why, true);
        if ($item) $items[] = $item;
    }
    // An empty catalog means something is wrong: don't pin it for 15 minutes.
    if ($items) set_transient(MINUTO_QUIZ_CACHE_KEY, $items, 15 * MINUTE_IN_SECONDS);
    return $items;
}

// Stock is the one thing that must not lag: refresh as soon as it changes.
function minuto_quiz_flush_catalog(): void {
    delete_transient(MINUTO_QUIZ_CACHE_KEY);
}
add_action('woocommerce_product_set_stock_status', 'minuto_quiz_flush_catalog');
add_action('woocommerce_variation_set_stock_status', 'minuto_quiz_flush_catalog');
add_action('woocommerce_update_product', 'minuto_quiz_flush_catalog');
register_deactivation_hook(__FILE__, 'minuto_quiz_flush_catalog');

// WP Rocket's "Delay JS" would hold the quiz back until the visitor interacts.
add_filter('rocket_delay_js_exclusions', function ($excluded) {
    $excluded[] = 'minuto-coffee-quiz/assets/';
    return $excluded;
});

add_action('rest_api_init', function () {
    if (!class_exists('WooCommerce')) return;
    register_rest_route('minuto-quiz/v1', '/catalog', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',   // public catalog data, read-only
        'callback'            => fn() => rest_ensure_response(minuto_quiz_catalog()),
    ]);
});

add_shortcode('minuto_coffee_quiz', function () {
    if (!class_exists('WooCommerce')) return '';
    $base = plugin_dir_url(__FILE__) . 'assets/';
    wp_enqueue_style('minuto-quiz', $base . 'quiz.css', [], MINUTO_QUIZ_VERSION);
    wp_enqueue_script('minuto-quiz-engine', $base . 'engine.js', [], MINUTO_QUIZ_VERSION, true);
    wp_enqueue_script('minuto-quiz', $base . 'quiz.js', ['minuto-quiz-engine'], MINUTO_QUIZ_VERSION, true);
    $shop = esc_url(wc_get_page_permalink('shop'));
    return '<div id="minuto-coffee-quiz" dir="rtl" aria-live="polite"'
        . ' data-catalog="' . esc_url(rest_url('minuto-quiz/v1/catalog')) . '" data-shop="' . $shop . '">'
        . '<noscript><a href="' . $shop . '">לכל הקפה בחנות</a></noscript></div>';
});
