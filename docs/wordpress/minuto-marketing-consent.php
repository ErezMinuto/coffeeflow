<?php
/**
 * Minuto: marketing-consent checkbox at checkout (unticked, optional).
 *
 * INSTALL (WordPress admin):
 *   Code Snippets (WPCode Lite) → Add Snippet → "Add Your Custom Code"
 *   → Code type: PHP Snippet → paste everything BELOW the opening <?php line
 *   → Insertion: Auto Insert, Location: Run Everywhere → Save → Activate.
 *   Then place a test order with the box ticked and one without.
 *
 * What it stores on every new order (CoffeeFlow's woo-orders-sync reads it):
 *   _minuto_marketing_consent   "yes" | "no"
 *   _minuto_consent_version     wording version below (proves WHICH text was shown)
 *   _minuto_consent_at          ISO time of the order
 * The customer's IP is already on the order (WooCommerce stores it).
 *
 * Why the WooCommerce field API and not a template hook: the checkout is
 * rendered by CheckoutWC, which draws WooCommerce's registered fields but
 * not every classic checkout hook.
 *
 * Wording: draft, the lawyer confirms before go-live. If the text changes,
 * bump MINUTO_CONSENT_VERSION so each order records which wording it saw.
 * Not a condition of purchase (Israeli Communications Law §30A): never
 * pre-ticked, never required.
 */

if (!defined('ABSPATH')) exit;

define('MINUTO_CONSENT_VERSION', '2026-10-a');
define('MINUTO_CONSENT_TEXT', 'אני מאשר/ת למינוטו קפה בע״מ לשלוח לי דברי פרסומת, מבצעים, הטבות ותזכורות להזמנה חוזרת בדוא״ל. ניתן להסיר בכל עת.');

// 1. The checkbox, last in the billing section, unticked by default.
add_filter('woocommerce_checkout_fields', function ($fields) {
    $fields['billing']['minuto_marketing_consent'] = [
        'type'     => 'checkbox',
        'label'    => MINUTO_CONSENT_TEXT,
        'required' => false,
        'default'  => 0,
        'class'    => ['form-row-wide'],
        'priority' => 999,
    ];
    return $fields;
});

// 2. Record the answer on the order, ticked or not, with the wording version.
add_action('woocommerce_checkout_create_order', function ($order, $data) {
    $ticked = !empty($_POST['minuto_marketing_consent']);
    $order->update_meta_data('_minuto_marketing_consent', $ticked ? 'yes' : 'no');
    $order->update_meta_data('_minuto_consent_version', MINUTO_CONSENT_VERSION);
    $order->update_meta_data('_minuto_consent_at', gmdate('c'));
}, 10, 2);

// 3. WooCommerce would also save the raw field as billing meta; it is
//    redundant with the keys above, so keep it off the order.
add_filter('woocommerce_checkout_posted_data', function ($data) {
    unset($data['minuto_marketing_consent']);
    return $data;
});
