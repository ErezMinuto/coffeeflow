<?php
/**
 * Plugin Name:       Minuto Product FAQ
 * Description:       Per-product AND per-post FAQ rendering + FAQPage JSON-LD for AI/SEO discoverability.
 * Version:           0.3.0
 * Author:            Minuto Cafe
 * Requires at least: 6.0
 * Requires PHP:      7.4
 *
 * v0.1 scope: render-only + admin meta box.
 *   - Render Hebrew FAQ accordion below product short description.
 *   - Emit FAQPage JSON-LD in <head>.
 *   - Admin meta box on product edit screen (paste/edit JSON).
 *
 * v0.1.2 changes vs 0.1.1: derive product ID from get_queried_object_id()
 * instead of trusting the global $product (which can be a string at wp_head
 * time on some themes — caused a fatal on Storefront).
 *
 * v0.1.3 changes vs 0.1.2: theme-agnostic render. Modern themes (block-based
 * Storefront, TwentyTwentyThree, FSE themes generally) don't fire the classic
 * woocommerce_after_single_product_summary hook. Added the_content filter as
 * a fallback render path; double-render guard prevents both paths firing on
 * a single page.
 *
 * v0.1.4 changes vs 0.1.3: live radicle theme renders product description via
 * raw $post->post_content access — neither the classic action hook nor the
 * the_content filter fires. Added: relaxed the_content guards (drop in_the_loop
 * + is_main_query checks); woocommerce_single_product_summary hook as another
 * attempt; wp_footer last-resort fallback to guarantee SOME render occurs
 * (placement at page bottom but content visible).
 *
 * v0.1.5 changes vs 0.1.4: JS-based DOM move. When the wp_footer fallback
 * fires (radicle), inject a small script that relocates the accordion to a
 * sensible anchor: tries .product-tabs first (radicle's tab container), then
 * .related (WC related products), then nothing (leaves it at page bottom).
 * Idempotent + null-safe: no-op if anchors aren't found.
 *
 * v0.1.6 changes vs 0.1.5: fix horizontal page overflow caused by the inline
 * styles on the fallback aside (max-width:1200px + padding:0 1rem on a non-
 * border-box element = 100%+2rem wide → page-wide horizontal scroll). Moved
 * all styles into the <style> block; added box-sizing:border-box + max-width
 * :100% defensively across all .minuto-faq descendants.
 *
 * v0.1.7 changes vs 0.1.6: still seeing horizontal scroll on iOS Safari.
 * Removed all width / max-width / padding from the fallback aside (was
 * causing parent-relative overflow on narrow viewports). Padding moved into
 * the inner .minuto-faq section. Added min-width:0 (allows shrinking inside
 * flex parents) and contain:layout (isolates layout calculations).
 *
 * v0.1.8 changes vs 0.1.7: confirmed via plugin-toggle test that horizontal
 * scroll IS coming from the plugin's output. Removed contain:layout (suspect
 * iOS quirk); added overflow-x:clip (stronger than hidden — disallows
 * programmatic scroll too); applied overflow:clip at every nesting level
 * (.minuto-faq-fallback, .minuto-faq, .minuto-faq__list, .minuto-faq__item,
 * .minuto-faq__answer); added position:relative + isolation:isolate to the
 * fallback to create a new stacking context that fully contains its layout.
 *
 * v0.1.9 changes vs 0.1.8: dramatic CSS simplification. Hypothesis: the
 * defensive overrides (max-width:100%, min-width:0, overflow:clip with
 * !important) were CAUSING iOS Safari to misbehave, not preventing it.
 * Stripped to bare essentials. If THIS doesn't fix it, the bug isn't from
 * our CSS at all — it's from the JS DOM-move placing the aside in a parent
 * that already has overflow issues, and we need to investigate the parent.
 *
 * v0.2.0 changes vs 0.1.9: bug came back, so v0.1.9 hypothesis was wrong.
 * Going minimal-but-targeted: apply containment to the .minuto-faq section
 * itself (always present in every render path) — no universal selectors, no
 * !important, no descendant cascade. The previous over-broad defensive
 * cascade in v0.1.6-0.1.8 may have caused iOS issues; the v0.1.9 strip was
 * too aggressive. v0.2.0 is the narrowest possible intervention on the
 * section: width:100%, max-width:100%, box-sizing:border-box, overflow-x
 * :clip, overflow-wrap:anywhere. Also moved the <style> block OUT of the
 * section (was nested inside <section>, which is non-standard HTML and may
 * interact with browser layout). Now emitted once per request in <head> via
 * a wp_head action, gated by is_product().
 *
 * v0.2.1 changes vs 0.2.0: v0.2.0's containment on .minuto-faq alone wasn't
 * enough — scroll persisted after a verified cache clear. Two additions:
 *   (1) Same containment now applies to .minuto-faq-fallback (the wrapping
 *       aside) too, in case the aside itself is the element exceeding parent
 *       width (overflow:clip on a child can't help if the parent is the one
 *       overflowing the grandparent).
 *   (2) Diagnostic JS, gated by ?minuto-faq-debug=1 query param. When
 *       activated, it walks the DOM after load, finds any element wider than
 *       the viewport, and logs the offenders to the browser console. This
 *       turns the "guess at the cause" loop into a "look at the cause" loop
 *       — next iteration is data-driven instead of speculative.
 *
 * v0.2.2 changes vs 0.2.1: console.table wasn't expandable for the user,
 * so they couldn't share the data. Diagnostic now sorts offenders by width
 * (widest first) and renders a fixed black panel at the top of the page
 * showing the top 12 — visible without devtools.
 *
 * v0.2.3 changes vs 0.2.2: ROOT CAUSE FOUND via the v0.2.2 visible-panel
 * diagnostic. The horizontal scroll was NEVER from the FAQ plugin — it was
 * from third-party widgets (CheckoutWC side-cart, Tidio chat) rendered at
 * negative-x positions with desktop widths (~1720px) that exceed the mobile
 * viewport. They're always present, but the FAQ plugin's added page height
 * appears to alter the layout calculation enough that the off-screen widgets
 * begin contributing to document.scrollWidth.
 *
 * Fix: emit `html, body { overflow-x: clip; }` from the plugin (only on
 * product pages, only when this plugin is active). This is a standard
 * defense against off-screen-positioned third-party widgets. Eventually it
 * should live in the theme — but shipping it from the plugin avoids a
 * separate theme deploy.
 *
 * Diagnostic JS removed in v0.2.3 (work is done, no need to ship it
 * permanently). To re-enable for future debugging, restore from v0.2.2.
 *
 * v0.2.4 changes vs 0.2.3: v0.2.3's `overflow-x: clip` didn't fix it on the
 * user's browser. Two likely causes addressed:
 *   (1) `overflow: clip` requires Safari 16+ / Chromium 90+. Older mobile
 *       Safari falls through. Added `overflow-x: hidden` as the cascading
 *       fallback (declared first; clip wins in browsers that support it).
 *   (2) Theme/utility CSS (Tailwind) may override with same-specificity
 *       selectors loaded later. Added `!important` to win the cascade —
 *       acceptable because hiding horizontal scroll is THE intent here.
 *
 * v0.2.5 changes vs 0.2.4: REGRESSION — v0.2.4's `overflow-x: hidden` broke
 * the theme's sticky top navigation menu (made it disappear). This is a
 * documented side-effect: `overflow: hidden` on body breaks `position
 * :sticky` on its descendants. `overflow: clip` exists specifically to avoid
 * this trade-off (it's the modern replacement) but isn't supported on
 * Safari < 16. v0.2.5 drops the `hidden` fallback entirely — only `clip`
 * remains. Trade-off: older iOS WebKit (Safari 15 and below, ~3+ years old)
 * will still experience horizontal scroll. Modern devices get both the menu
 * and the scroll fix. The robust solution is to fix the actual culprits
 * (CheckoutWC side-cart + Tidio chat off-screen positioning) at the theme
 * or widget-config level — see memory: wp_overflow_x_iphone.md.
 *
 * v0.2.6 changes vs 0.2.5: v0.2.5 fixed the menu (good) but the horizontal
 * scroll returned. v0.2.5 also dropped `!important` (with the `hidden` rule),
 * meaning theme/utility CSS may have overridden `overflow-x: clip` with same-
 * specificity later-loaded rules. v0.2.6 adds `!important` back ONLY on the
 * `clip` value — `!important` on `clip` is sticky-safe (the sticky-breaking
 * was specifically the `hidden` value, not `!important`). If scroll still
 * persists, the user is on Safari < 16 and the theme-level CheckoutWC/Tidio
 * fix is the only path forward.
 *
 * v0.2.7 changes vs 0.2.6: added uninstall.php so deleting the plugin from
 * WP Admin (full delete, not just deactivate) cleans up all FAQ post_meta
 * rows. Use this when you want to fully remove the plugin without leaving
 * `_minuto_faq_published` rows behind. Backup first if you want to restore
 * later (faq-backups/ folder in the CoffeeFlow repo).
 *
 * v0.3.0 changes vs 0.2.7: BLOG POST SUPPORT. The plugin now renders FAQ +
 * emits FAQPage JSON-LD on standard blog posts (post_type='post'), not just
 * WooCommerce products. Drives the technical-SEO experiment of adding FAQ
 * schema to ranking articles (e.g. the "מטחנת קפה" grinder posts).
 *   - Storage is unchanged: same `_minuto_faq_published` post_meta key, same
 *     {q,a}[] JSON shape. Product FAQs are untouched.
 *   - New `minuto_faq_resolve_faq_post_id()` resolves the queried object for
 *     EITHER a product or a post (supported types listed in
 *     minuto_faq_supported_post_types()).
 *   - JSON-LD + styles now fire on single posts as well as products. The
 *     JSON-LD path runs in wp_head via get_queried_object_id() so the SEO
 *     signal is theme-independent — it does NOT depend on the_content firing.
 *   - Visible accordion on posts renders via the_content (posts render
 *     through standard content filters reliably; no WooCommerce-hook gymnastics
 *     needed). A guard (get_the_ID() === queried id) prevents appending the
 *     main post's FAQ to related-post widgets that also run the_content.
 *   - Meta box now registers on `post` too (via the generic add_meta_boxes +
 *     save_post hooks), so FAQs can be authored on articles from the editor —
 *     or written programmatically via post_meta (the set-post-faq function).
 *   - Product render paths (WooCommerce hooks + footer DOM-move fallback) are
 *     untouched — they stay product-only via minuto_faq_resolve_product_id().
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! defined( 'MINUTO_FAQ_META_KEY' ) ) {
	define( 'MINUTO_FAQ_META_KEY', '_minuto_faq_published' );
}
if ( ! defined( 'MINUTO_FAQ_NONCE' ) ) {
	define( 'MINUTO_FAQ_NONCE', 'minuto_faq_meta_nonce' );
}

// ---------------------------------------------------------------------------
// Read + validate
// ---------------------------------------------------------------------------

function minuto_faq_get_published( $product_id ) {
	$raw = get_post_meta( (int) $product_id, MINUTO_FAQ_META_KEY, true );
	if ( empty( $raw ) ) {
		return array();
	}
	$decoded = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
	if ( ! is_array( $decoded ) ) {
		return array();
	}
	$valid = array();
	foreach ( $decoded as $item ) {
		if ( ! is_array( $item ) ) {
			continue;
		}
		$q = isset( $item['q'] ) ? trim( (string) $item['q'] ) : '';
		$a = isset( $item['a'] ) ? trim( (string) $item['a'] ) : '';
		if ( $q === '' || $a === '' ) {
			continue;
		}
		$valid[] = array( 'q' => $q, 'a' => $a );
	}
	return $valid;
}

// ---------------------------------------------------------------------------
// Front-end render
// ---------------------------------------------------------------------------

function minuto_faq_resolve_product_id() {
	// Don't trust global $product — it can be a string at wp_head time on
	// some themes (Storefront, e.g.). Use the queried object instead.
	if ( ! function_exists( 'is_product' ) || ! is_product() ) {
		return 0;
	}
	$post_id = (int) get_queried_object_id();
	if ( ! $post_id || get_post_type( $post_id ) !== 'product' ) {
		return 0;
	}
	return $post_id;
}

/**
 * Post types that can carry a Minuto FAQ. Products (WooCommerce) and standard
 * blog posts. Centralized so the render/JSON-LD/meta-box/save paths agree.
 */
function minuto_faq_supported_post_types() {
	return array( 'product', 'post' );
}

/**
 * Resolve the queried single-page object id IF it's a FAQ-eligible type
 * (product or post). Used by the type-agnostic paths: styles + JSON-LD.
 * Returns 0 on archives, non-eligible types, or no queried object.
 */
function minuto_faq_resolve_faq_post_id() {
	if ( ! is_singular( minuto_faq_supported_post_types() ) ) {
		return 0;
	}
	$post_id = (int) get_queried_object_id();
	if ( ! $post_id ) {
		return 0;
	}
	if ( ! in_array( get_post_type( $post_id ), minuto_faq_supported_post_types(), true ) ) {
		return 0;
	}
	return $post_id;
}

/**
 * Build the FAQ HTML block as a string. Used by all render paths so output
 * is identical. Note: <style> is emitted once per request via wp_head (see
 * minuto_faq_emit_styles below) — NOT inline here, since nesting <style>
 * inside <section> is non-standard and may cause layout quirks.
 */
function minuto_faq_build_html( $faq ) {
	if ( empty( $faq ) ) {
		return '';
	}
	ob_start();
	?>
	<section class="minuto-faq" dir="rtl" aria-labelledby="minuto-faq-heading">
		<h2 id="minuto-faq-heading" class="minuto-faq__heading">שאלות נפוצות</h2>
		<div class="minuto-faq__list">
			<?php foreach ( $faq as $item ) : ?>
				<details class="minuto-faq__item">
					<summary class="minuto-faq__question"><?php echo esc_html( $item['q'] ); ?></summary>
					<div class="minuto-faq__answer"><?php echo wp_kses_post( wpautop( $item['a'] ) ); ?></div>
				</details>
			<?php endforeach; ?>
		</div>
	</section>
	<?php
	return (string) ob_get_clean();
}

/**
 * Emit the FAQ stylesheet once per request, in <head>. Targeted defensive
 * CSS on .minuto-faq (the always-rendered section) — no universal selectors,
 * no !important. The section is present in every render path (footer fallback
 * + classic hook + the_content), so isolating overflow at that level prevents
 * page-wide horizontal scroll regardless of which path fired or where the JS
 * DOM-move landed the wrapper aside.
 */
function minuto_faq_emit_styles() {
	// Scope carefully to avoid touching pages we don't own:
	//   • Products  → emit the FULL block (incl. the html,body overflow-x
	//     fix) on EVERY product page, exactly as v0.2.x did. The overflow
	//     band-aid must stay on all product pages regardless of FAQ
	//     presence (see memory: wp_overflow_x_iphone.md) — don't regress it.
	//   • Posts     → emit ONLY the .minuto-faq component styles, and ONLY
	//     when the post actually has FAQ content. We deliberately do NOT
	//     ship the global html,body rule on posts — that was a product-page
	//     fix and shouldn't alter blog-wide layout. FAQ-less posts emit
	//     nothing, so existing articles are completely unaffected.
	$is_product_page = ( function_exists( 'is_product' ) && is_product() );

	$is_post_with_faq = false;
	if ( ! $is_product_page && is_singular( 'post' ) ) {
		$pid = (int) get_queried_object_id();
		$is_post_with_faq = ( $pid && ! empty( minuto_faq_get_published( $pid ) ) );
	}

	if ( ! $is_product_page && ! $is_post_with_faq ) {
		return;
	}
	?>
	<style id="minuto-faq-styles">
		<?php if ( $is_product_page ) : ?>
		/* v0.2.6 — `overflow-x: clip !important`. `!important` only fights the
		 * cascade; `clip` (unlike `hidden`) is sticky-safe regardless. Older
		 * iOS WebKit (Safari < 16) ignores `clip` entirely → scroll persists
		 * there. Theme-level fix on the actual offending widgets is the only
		 * cross-browser path. See memory: wp_overflow_x_iphone.md.
		 * PRODUCT PAGES ONLY — not emitted on posts (would alter blog layout). */
		html, body { overflow-x: clip !important; }
		<?php endif; ?>
		.minuto-faq-fallback,
		.minuto-faq {
			display: block;
			width: 100%;
			max-width: 100%;
			box-sizing: border-box;
			overflow-x: clip;
			overflow-wrap: anywhere;
		}
		.minuto-faq {
			margin-top: 2rem;
			padding: 1rem 0 0;
			border-top: 1px solid #e5e5e5;
		}
		.minuto-faq__heading { font-size: 1.4rem; margin: 0 0 1rem; font-weight: 600; }
		.minuto-faq__item { border-bottom: 1px solid #eee; }
		.minuto-faq__question { cursor: pointer; font-weight: 600; padding: 0.85rem 0; }
		.minuto-faq__question::-webkit-details-marker { display: none; }
		.minuto-faq__answer { padding: 0 0 1rem; line-height: 1.65; color: #333; }
	</style>
	<?php
}
add_action( 'wp_head', 'minuto_faq_emit_styles', 20 );


/**
 * Track whether we already rendered for the current request so we don't
 * double-output if both the action hook AND the_content filter fire.
 */
function minuto_faq_already_rendered( $product_id, $set = false ) {
	static $rendered = array();
	if ( $set ) {
		$rendered[ $product_id ] = true;
		return true;
	}
	return ! empty( $rendered[ $product_id ] );
}

/**
 * Primary render path: classic WooCommerce theme hook.
 * Fires on Storefront <2024, custom classic themes (radicle, etc.).
 */
function minuto_faq_render_html() {
	$product_id = minuto_faq_resolve_product_id();
	if ( ! $product_id || minuto_faq_already_rendered( $product_id ) ) {
		return;
	}
	$faq = minuto_faq_get_published( $product_id );
	$html = minuto_faq_build_html( $faq );
	if ( $html === '' ) {
		return;
	}
	echo $html; // already escaped inside minuto_faq_build_html
	minuto_faq_already_rendered( $product_id, true );
}
add_action( 'woocommerce_after_single_product_summary', 'minuto_faq_render_html', 25 );

/**
 * Secondary render path: woocommerce_single_product_summary hook (priority 60
 * places it after the default summary contents). Fires on more themes than
 * the "after_single_product_summary" hook above.
 */
add_action( 'woocommerce_single_product_summary', 'minuto_faq_render_html', 60 );

/**
 * Tertiary render path: the_content filter. Fires on themes that render
 * product description through standard content filters. Guards relaxed in
 * v0.1.4 — block themes often render outside the loop, so in_the_loop()
 * was blocking us.
 */
function minuto_faq_render_via_content( $content ) {
	// ── Blog posts: PRIMARY (and only) render path. Posts render through
	// standard content filters reliably, so we don't need the WooCommerce
	// hook gymnastics or the footer fallback that products require.
	if ( is_singular( 'post' ) ) {
		$post_id = (int) get_queried_object_id();
		if ( ! $post_id || minuto_faq_already_rendered( $post_id ) ) {
			return $content;
		}
		// Guard: the_content can fire for OTHER posts on the same page
		// (related-posts widgets, etc.). Only append to the main post's
		// content. get_the_ID() falsy (FSE outside-loop) → fall through
		// and trust the queried id.
		$loop_id = get_the_ID();
		if ( $loop_id && (int) $loop_id !== $post_id ) {
			return $content;
		}
		$faq  = minuto_faq_get_published( $post_id );
		$html = minuto_faq_build_html( $faq );
		if ( $html === '' ) {
			return $content;
		}
		minuto_faq_already_rendered( $post_id, true );
		return $content . $html;
	}

	// ── Products: tertiary fallback (existing v0.2.x behavior).
	if ( ! is_singular( 'product' ) ) {
		return $content;
	}
	$product_id = minuto_faq_resolve_product_id();
	if ( ! $product_id || minuto_faq_already_rendered( $product_id ) ) {
		return $content;
	}
	$faq = minuto_faq_get_published( $product_id );
	$html = minuto_faq_build_html( $faq );
	if ( $html === '' ) {
		return $content;
	}
	minuto_faq_already_rendered( $product_id, true );
	return $content . $html;
}
add_filter( 'the_content', 'minuto_faq_render_via_content', 999 );

/**
 * Last-resort render path: wp_footer. Always fires on every page. If none
 * of the earlier hooks managed to render the accordion, this guarantees the
 * content is visible (at the bottom of the page, before </body>). Visually
 * suboptimal but ensures human visitors and JS-based AI crawlers see it.
 *
 * Wrapped in a clearly-separate <aside> so it's identifiable as a fallback.
 */
function minuto_faq_render_via_footer() {
	$product_id = minuto_faq_resolve_product_id();
	if ( ! $product_id || minuto_faq_already_rendered( $product_id ) ) {
		return;
	}
	$faq = minuto_faq_get_published( $product_id );
	$html = minuto_faq_build_html( $faq );
	if ( $html === '' ) {
		return;
	}
	minuto_faq_already_rendered( $product_id, true );
	echo '<aside class="minuto-faq-fallback" data-render="footer-fallback">';
	echo $html; // already escaped inside minuto_faq_build_html
	echo '</aside>';
	// JS-based DOM move: relocate the fallback aside into a sensible anchor
	// in the product layout. Tries multiple selectors; gracefully no-ops if
	// none are present. Idempotent (data-minuto-moved guards re-runs).
	?>
	<script>
	(function () {
		if (typeof document === 'undefined') return;
		var run = function () {
			var fallback = document.querySelector('.minuto-faq-fallback:not([data-minuto-moved])');
			if (!fallback) return;
			// Anchor selectors in priority order. First match wins.
			var anchorSelectors = [
				'.product-tabs',                      // radicle: description tabs container
				'.woocommerce-tabs',                  // classic WC
				'.wc-tabs-wrapper',                   // some WC themes
				'.related.products',                  // WC related-products section
				'.related',                           // generic related
				'.up-sells',                          // upsells section
			];
			var anchor = null;
			for (var i = 0; i < anchorSelectors.length; i++) {
				anchor = document.querySelector(anchorSelectors[i]);
				if (anchor) break;
			}
			if (!anchor) return; // leave at page bottom
			// Mark as anchored so CSS can drop the wrapper padding/max-width.
			fallback.classList.add('minuto-faq--anchored');
			// Insert AFTER the anchor (so accordion appears below tabs,
			// above related products if anchor is the tab container).
			anchor.parentNode.insertBefore(fallback, anchor.nextSibling);
			fallback.setAttribute('data-minuto-moved', '1');
		};
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', run);
		} else {
			run();
		}
	})();
	</script>
	<?php
}
add_action( 'wp_footer', 'minuto_faq_render_via_footer', 5 );

function minuto_faq_emit_jsonld() {
	// Type-agnostic: fires on products AND posts. Runs in wp_head off the
	// queried object id, so the FAQPage signal is emitted regardless of
	// whether the theme renders the visible accordion via the_content.
	$faq_post_id = minuto_faq_resolve_faq_post_id();
	if ( ! $faq_post_id ) {
		return;
	}
	$faq = minuto_faq_get_published( $faq_post_id );
	if ( empty( $faq ) ) {
		return;
	}
	$entities = array();
	foreach ( $faq as $item ) {
		$entities[] = array(
			'@type'          => 'Question',
			'name'           => $item['q'],
			'acceptedAnswer' => array(
				'@type' => 'Answer',
				'text'  => wp_strip_all_tags( $item['a'] ),
			),
		);
	}
	$jsonld = array(
		'@context'   => 'https://schema.org',
		'@type'      => 'FAQPage',
		'mainEntity' => $entities,
	);
	echo "\n" . '<script type="application/ld+json" data-source="minuto-product-faq">'
		. wp_json_encode( $jsonld, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES )
		. '</script>' . "\n";
}
add_action( 'wp_head', 'minuto_faq_emit_jsonld', 30 );

// ---------------------------------------------------------------------------
// Admin meta box on product edit screen
// ---------------------------------------------------------------------------

function minuto_faq_register_meta_box() {
	foreach ( minuto_faq_supported_post_types() as $pt ) {
		add_meta_box(
			'minuto_faq_meta',
			'Minuto FAQ',
			'minuto_faq_render_meta_box',
			$pt,
			'normal',
			'default'
		);
	}
}
// Generic add_meta_boxes fires for every post type; the loop above scopes
// registration to product + post only.
add_action( 'add_meta_boxes', 'minuto_faq_register_meta_box' );

function minuto_faq_render_meta_box( $post ) {
	wp_nonce_field( 'minuto_faq_save', MINUTO_FAQ_NONCE );
	$raw     = get_post_meta( $post->ID, MINUTO_FAQ_META_KEY, true );
	$display = '';
	if ( ! empty( $raw ) ) {
		$decoded = json_decode( $raw, true );
		if ( is_array( $decoded ) ) {
			$display = wp_json_encode( $decoded, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		} else {
			$display = $raw;
		}
	}
	$placeholder = '[{"q": "שאלה לדוגמה", "a": "תשובה לדוגמה"}]';
	$is_product  = ( get_post_type( $post ) === 'product' );
	$page_label  = $is_product ? 'המוצר' : 'המאמר';
	?>
	<p style="margin-top:0;">
		<strong>JSON של שאלות ותשובות לעמוד <?php echo esc_html( $page_label ); ?>.</strong>
		מבנה: מערך של אובייקטים, כל אחד עם <code>q</code> (שאלה) ו-<code>a</code> (תשובה).
		השאר ריק כדי לא להציג מקטע FAQ ב<?php echo esc_html( $page_label ); ?>.
	</p>
	<textarea
		name="minuto_faq_json"
		dir="ltr"
		style="width:100%;min-height:280px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;"
		placeholder="<?php echo esc_attr( $placeholder ); ?>"
	><?php echo esc_textarea( $display ); ?></textarea>
	<p class="description">
		ולידציה: ה-JSON חייב להיות מערך תקין. אובייקטים חסרי <code>q</code> או <code>a</code> יוסרו אוטומטית בשמירה.
		אם ה-JSON לא תקין כלל, הערך הקודם יישמר ותוצג הודעת שגיאה.
	</p>
	<?php
}

function minuto_faq_save_meta_box( $post_id ) {
	if ( ! isset( $_POST[ MINUTO_FAQ_NONCE ] ) ) {
		return;
	}
	if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST[ MINUTO_FAQ_NONCE ] ) ), 'minuto_faq_save' ) ) {
		return;
	}
	if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
		return;
	}
	if ( ! current_user_can( 'edit_post', $post_id ) ) {
		return;
	}
	if ( ! in_array( get_post_type( $post_id ), minuto_faq_supported_post_types(), true ) ) {
		return;
	}

	$raw = isset( $_POST['minuto_faq_json'] ) ? wp_unslash( $_POST['minuto_faq_json'] ) : '';
	$raw = trim( (string) $raw );

	if ( $raw === '' ) {
		delete_post_meta( $post_id, MINUTO_FAQ_META_KEY );
		return;
	}

	$decoded = json_decode( $raw, true );
	if ( ! is_array( $decoded ) ) {
		set_transient( 'minuto_faq_error_' . $post_id, 'JSON לא תקין - הערך הקודם נשמר.', 30 );
		return;
	}

	$valid = array();
	foreach ( $decoded as $item ) {
		if ( ! is_array( $item ) ) {
			continue;
		}
		$q = isset( $item['q'] ) ? trim( (string) $item['q'] ) : '';
		$a = isset( $item['a'] ) ? trim( (string) $item['a'] ) : '';
		if ( $q === '' || $a === '' ) {
			continue;
		}
		$valid[] = array( 'q' => $q, 'a' => $a );
	}

	if ( empty( $valid ) ) {
		delete_post_meta( $post_id, MINUTO_FAQ_META_KEY );
		return;
	}

	$json = wp_json_encode( $valid, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
	update_post_meta( $post_id, MINUTO_FAQ_META_KEY, wp_slash( $json ) );
}
// Generic save_post hook fires for all post types; the supported-type check
// inside the handler scopes writes to product + post only.
add_action( 'save_post', 'minuto_faq_save_meta_box' );

function minuto_faq_admin_notices() {
	$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
	if ( ! $screen || $screen->base !== 'post' || ! in_array( $screen->post_type, minuto_faq_supported_post_types(), true ) ) {
		return;
	}
	$post_id = isset( $_GET['post'] ) ? (int) $_GET['post'] : 0;
	if ( ! $post_id ) {
		return;
	}
	$error = get_transient( 'minuto_faq_error_' . $post_id );
	if ( $error ) {
		delete_transient( 'minuto_faq_error_' . $post_id );
		printf(
			'<div class="notice notice-error is-dismissible"><p><strong>Minuto FAQ:</strong> %s</p></div>',
			esc_html( $error )
		);
	}
}
add_action( 'admin_notices', 'minuto_faq_admin_notices' );
