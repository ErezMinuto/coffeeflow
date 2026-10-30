<?php
/**
 * Plugin Name: Minuto Coffee Quiz
 * Description: "איזה קפה מתאים לי?" quiz. Place [minuto_coffee_quiz] on a page.
 * Version: 1.1.3
 * Author: Minuto
 * Requires Plugins: woocommerce
 *
 * The rules live in assets/engine.js (tested by engine_test.ts). This file
 * serves the catalog: which coffees are in stock, with photo, price and link.
 * Stock comes through a short-cached REST route rather than the page HTML,
 * because WP Rocket caches the page itself.
 */

if (!defined('ABSPATH')) exit;

define('MINUTO_QUIZ_VERSION', '1.1.3');
define('MINUTO_QUIZ_CACHE_KEY', 'minuto_quiz_catalog');
define('MINUTO_QUIZ_ROAST_ATTRIBUTE_ID', 20);   // רמת קלייה
define('MINUTO_QUIZ_MACHINES_CATEGORY_ID', 394);  // מכונות קפה, including its subcategories
define('MINUTO_QUIZ_GRINDERS_CATEGORY_ID', 387);  // מטחנות קפה: never gets the link
define('MINUTO_QUIZ_PAGE_PATH', '/coffee-quiz/');
define('MINUTO_QUIZ_FRESH_COFFEE_CATEGORY_ID', 380);  // פולי קפה טרי: what may be recommended
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
        'kenya_m'     => [65135, 'Kenya AA+‎', 'חמיצות נוצצת ומתיקות עדינה.'],
        'kenya_l'     => [65463, 'Kenya AA+‎ בקלייה בהירה', 'פירות יער והדרים, גוף בינוני וסיומת נקייה.'],
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

/** The Quiz box on a product, or null when it hasn't been filled in. */
function minuto_quiz_box(WC_Product $p): ?array {
    // get_post_meta, not the WC_Product object: the box saves with
    // update_post_meta, which that object's cache doesn't see until it expires.
    $id = $p->get_id();
    $flavor = (string) get_post_meta($id, '_mq_flavor', true);
    if (!in_array($flavor, ['chocolate', 'fruity', 'floral'], true)) return null;
    $brews = get_post_meta($id, '_mq_brews', true);
    return [
        'flavor'  => $flavor,
        'milk'    => get_post_meta($id, '_mq_milk', true) === 'yes',
        'brews'   => is_array($brews) ? array_values(array_intersect($brews, ['espresso', 'moka', 'filter'])) : [],
        'limited' => get_post_meta($id, '_mq_limited', true) === 'yes',
    ];
}

/** Every in-stock candidate in the fresh-coffee category, children included. */
function minuto_quiz_fresh_product_ids(): array {
    return array_map('intval', get_posts([
        'post_type'        => 'product',
        'post_status'      => 'publish',
        'numberposts'      => 100,
        'fields'           => 'ids',
        'suppress_filters' => false,
        'tax_query'        => [[
            'taxonomy'         => 'product_cat',
            'field'            => 'term_id',
            'terms'            => [MINUTO_QUIZ_FRESH_COFFEE_CATEGORY_ID],
            'include_children' => true,
        ]],
    ]));
}

function minuto_quiz_item(string $key, WC_Product $p, string $name, string $why, bool $is_light): ?array {
    if (!$p->is_in_stock() || $p->get_status() !== 'publish') return null;
    $image = wp_get_attachment_image_url($p->get_image_id(), 'woocommerce_thumbnail') ?: wc_placeholder_img_src('woocommerce_thumbnail');
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
        if (!$item) continue;
        // A named coffee can be a limited edition too, such as Aji Bourbon.
        $box = minuto_quiz_box($p);
        $items[] = $box && $box['limited'] ? array_merge($item, $box) : $item;
    }
    // New coffees and jars join through the Quiz box on their product page.
    foreach (array_diff(minuto_quiz_fresh_product_ids(), $known) as $id) {
        $p = wc_get_product($id);
        if (!$p || preg_match('/veneto|ירוק|green/iu', $p->get_name())) continue;
        $box = minuto_quiz_box($p);
        if (!$box) continue;   // the product page shows a reminder
        $custom = trim((string) get_post_meta($id, '_mq_why', true));
        $why = $custom !== '' ? $custom : wp_trim_words(minuto_quiz_text($p->get_short_description()), 16);
        $item = minuto_quiz_item('extra_' . $id, $p, $p->get_name(), $why, in_array($id, $light_ids, true));
        if ($item) $items[] = array_merge($item, $box, ['extra' => true]);
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

/** Small link on machine pages. Hooked below the add-to-cart form. */
function minuto_quiz_machine_link(): void {
    global $product;
    if (!$product instanceof WC_Product) return;
    $terms = wp_get_post_terms($product->get_id(), 'product_cat', ['fields' => 'ids']);
    if (is_wp_error($terms) || !$terms) return;
    $tree = function (int $root): array {
        $children = get_term_children($root, 'product_cat');
        return is_wp_error($children) ? [$root] : array_merge([$root], array_map('intval', $children));
    };
    $terms = array_map('intval', $terms);
    if (!array_intersect($terms, $tree(MINUTO_QUIZ_MACHINES_CATEGORY_ID))) return;
    if (array_intersect($terms, $tree(MINUTO_QUIZ_GRINDERS_CATEGORY_ID))) return;

    printf(
        '<p class="mq-machine-link" style="margin:12px 0 0;font-size:14px;"><a href="%s" style="color:#3C4A2C;text-decoration:underline;">%s</a></p>',
        esc_url(home_url(MINUTO_QUIZ_PAGE_PATH)),
        esc_html('איזה קפה מתאים למכונה הזו?')
    );
}
add_action('woocommerce_after_add_to_cart_form', 'minuto_quiz_machine_link');

// ── Quiz box on the product edit page ─────────────────────────────────────

add_action('add_meta_boxes_product', function () {
    add_meta_box('minuto-quiz-box', 'שאלון קפה', 'minuto_quiz_render_box', 'product', 'side');
});

function minuto_quiz_render_box(WP_Post $post): void {
    wp_nonce_field('minuto_quiz_box', 'minuto_quiz_nonce');
    $flavor = (string) get_post_meta($post->ID, '_mq_flavor', true);
    $brews  = (array) get_post_meta($post->ID, '_mq_brews', true);
    $flavors = ['' => 'לא בשאלון', 'chocolate' => 'שוקולד ואגוזים', 'fruity' => 'פירותי', 'floral' => 'פרחוני'];
    $methods = ['espresso' => 'אספרסו', 'moka' => 'מקינטה', 'filter' => 'פילטר'];

    echo '<p><label for="mq_flavor"><strong>טעם</strong></label><br><select id="mq_flavor" name="mq_flavor">';
    foreach ($flavors as $value => $label) {
        printf('<option value="%s"%s>%s</option>', esc_attr($value), selected($flavor, $value, false), esc_html($label));
    }
    echo '</select></p><p><strong>שיטות חליטה</strong><br>';
    foreach ($methods as $value => $label) {
        printf(
            '<label><input type="checkbox" name="mq_brews[]" value="%s"%s> %s</label><br>',
            esc_attr($value), checked(in_array($value, $brews, true), true, false), esc_html($label)
        );
    }
    printf(
        '</p><p><label><input type="checkbox" name="mq_milk" value="yes"%s> מתאים לחלב</label><br>'
        . '<label><input type="checkbox" name="mq_limited" value="yes"%s> מהדורה מוגבלת</label></p>',
        checked(get_post_meta($post->ID, '_mq_milk', true), 'yes', false),
        checked(get_post_meta($post->ID, '_mq_limited', true), 'yes', false)
    );
    printf(
        '<p><label for="mq_why"><strong>שורה קצרה (לא חובה)</strong></label><br>'
        . '<input type="text" id="mq_why" name="mq_why" class="widefat" maxlength="120" value="%s"></p>',
        esc_attr((string) get_post_meta($post->ID, '_mq_why', true))
    );
}

add_action('save_post_product', function (int $post_id) {
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;
    if (wp_is_post_revision($post_id)) return;
    $nonce = isset($_POST['minuto_quiz_nonce']) ? sanitize_text_field(wp_unslash($_POST['minuto_quiz_nonce'])) : '';
    if (!$nonce || !wp_verify_nonce($nonce, 'minuto_quiz_box')) return;
    if (!current_user_can('edit_post', $post_id)) return;

    $flavor = isset($_POST['mq_flavor']) ? sanitize_key(wp_unslash($_POST['mq_flavor'])) : '';
    update_post_meta($post_id, '_mq_flavor', in_array($flavor, ['chocolate', 'fruity', 'floral'], true) ? $flavor : '');
    $brews = isset($_POST['mq_brews']) ? array_map('sanitize_key', (array) wp_unslash($_POST['mq_brews'])) : [];
    update_post_meta($post_id, '_mq_brews', array_values(array_intersect($brews, ['espresso', 'moka', 'filter'])));
    update_post_meta($post_id, '_mq_milk', empty($_POST['mq_milk']) ? 'no' : 'yes');
    update_post_meta($post_id, '_mq_limited', empty($_POST['mq_limited']) ? 'no' : 'yes');
    $why = isset($_POST['mq_why']) ? sanitize_text_field(wp_unslash($_POST['mq_why'])) : '';
    update_post_meta($post_id, '_mq_why', mb_substr($why, 0, 120));
    minuto_quiz_flush_catalog();
});

// Reminder on a fresh coffee that isn't in the quiz yet.
add_action('admin_notices', function () {
    $screen = get_current_screen();
    if (!$screen || $screen->id !== 'product' || $screen->base !== 'post') return;
    $id = get_the_ID();
    if (!$id || get_post_status($id) !== 'publish') return;
    if (in_array($id, array_column(minuto_quiz_coffees(), 0), true)) return;
    if (!in_array($id, minuto_quiz_fresh_product_ids(), true)) return;
    if (in_array((string) get_post_meta($id, '_mq_flavor', true), ['chocolate', 'fruity', 'floral'], true)) return;
    echo '<div class="notice notice-warning"><p>' . esc_html('הקפה הזה עדיין לא בשאלון. ממלאים את התיבה "שאלון קפה" בצד העמוד.') . '</p></div>';
});
