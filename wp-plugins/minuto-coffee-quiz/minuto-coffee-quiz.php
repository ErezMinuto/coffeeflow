<?php
/**
 * Plugin Name: Minuto Coffee Quiz
 * Description: "איזה קפה מתאים לי?" quiz. Place [minuto_coffee_quiz] on a page.
 * Version: 1.0.0
 * Author: Minuto
 * Requires Plugins: woocommerce
 *
 * The rules live in assets/engine.js (tested by engine_test.ts). This file
 * serves the catalog: which coffees are in stock, with photo, price and link.
 * Stock comes through a short-cached REST route rather than the page HTML,
 * because WP Rocket caches the page itself.
 */

if (!defined('ABSPATH')) exit;

define('MINUTO_QUIZ_VERSION', '1.0.0');
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
    if (!$taxonomy) return [];
    return wc_get_products([
        'status'    => 'publish',
        'limit'     => 50,
        'return'    => 'ids',
        'tax_query' => [[
            'taxonomy' => $taxonomy,
            'field'    => 'name',
            'terms'    => [MINUTO_QUIZ_LIGHT_TERM],
        ]],
    ]);
}

function minuto_quiz_item(string $key, WC_Product $p, string $name, string $why, bool $is_light): ?array {
    if (!$p->is_in_stock() || $p->get_status() !== 'publish') return null;
    $image = wp_get_attachment_image_url($p->get_image_id(), 'woocommerce_thumbnail');
    return [
        'key'   => $key,
        'name'  => $name,
        'why'   => $why,
        'light' => $is_light,
        'url'   => $p->get_permalink(),
        'image' => $image ?: '',
        'price' => wp_strip_all_tags(wc_price((float) $p->get_price())),
        // Simple products go straight to the cart; others need a grind choice.
        'cart'  => $p->is_type('simple') ? $p->add_to_cart_url() : '',
    ];
}

function minuto_quiz_catalog(): array {
    $cached = get_transient('minuto_quiz_catalog');
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
        $item = minuto_quiz_item('light_' . $id, $p, $p->get_name(), wp_strip_all_tags($p->get_short_description()), true);
        if ($item) $items[] = $item;
    }
    set_transient('minuto_quiz_catalog', $items, 15 * MINUTE_IN_SECONDS);
    return $items;
}

add_action('rest_api_init', function () {
    register_rest_route('minuto-quiz/v1', '/catalog', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',   // public catalog data, read-only
        'callback'            => fn() => rest_ensure_response(minuto_quiz_catalog()),
    ]);
});

add_shortcode('minuto_coffee_quiz', function () {
    $base = plugin_dir_url(__FILE__) . 'assets/';
    wp_enqueue_style('minuto-quiz', $base . 'quiz.css', [], MINUTO_QUIZ_VERSION);
    wp_enqueue_script('minuto-quiz-engine', $base . 'engine.js', [], MINUTO_QUIZ_VERSION, true);
    wp_enqueue_script('minuto-quiz', $base . 'quiz.js', ['minuto-quiz-engine'], MINUTO_QUIZ_VERSION, true);
    return '<div id="minuto-coffee-quiz" dir="rtl" data-catalog="' . esc_url(rest_url('minuto-quiz/v1/catalog')) . '"></div>';
});
