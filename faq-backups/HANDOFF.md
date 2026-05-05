# Minuto FAQ Rollout — Handoff Brief

> Read this in addition to `/CLAUDE.md` (project root). This file is FAQ-specific
> context that doesn't belong in CLAUDE.md but a future session needs to know.

## Last update
**2026-05-05.** Plugin currently uninstalled (see "Why plugin is off" below).

## What this work is about

Adding per-product FAQ accordions + FAQPage JSON-LD to minuto.co.il (specialty coffee roastery in Israel) for AI/SEO discoverability. AI assistants (ChatGPT, Claude, Gemini, Perplexity) parse FAQPage schema when answering coffee questions, so structured FAQ on bean + machine pages is intentional.

Hebrew-only output, gender-inclusive, brand-voice-aware. The model writes the FAQ; the human approves before publishing.

## State (2026-05-05)

| Category | Total | FAQ written | Pending |
|---|---|---|---|
| Specialty bean SKUs | 23 | 23 | 0 |
| Linea Micra (color variants) | 6 | 6 | 0 |
| Linea Mini (color variants) | 7 | 7 | 0 |
| GS3 AV | 1 | 1 | 0 |
| **GS3 MP** | 1 | 0 | 1 |
| **Linea PB** | 1 | 0 | 1 |
| **KB90** | 1 | 0 | 1 |
| **Strada X** | 1 | 0 | 1 |
| **Linea Classic S** | 1 | 0 | 1 |
| Grinders (mid-priority) | ~70 | 0 | ~70 |
| Other categories | many | 0 | TBD |

**5 La Marzocco machines + the entire grinders category remain.**

Spec-section corrections are also live on all 13 Linea Mini + Micra SKUs (separate from FAQ — these are corrections to the WC product description text itself).

## Why the plugin is currently uninstalled

User reported an intermittent bug: on iOS, after navigating between products via the browser back button, the radicle theme's mobile menu disappears AND a ~10,000px horizontal scroll appears. Diagnostic showed the cause is third-party widgets (CheckoutWC side-cart + Tidio chat) rendering at off-screen positions with desktop widths — sitewide, pre-existing, not from this plugin.

The user disabled this plugin to remove it as a suspect before handing off to the site dev. Reproduction recipe was sent to the dev, mentioning bfcache + `pageshow` event handlers as the likely root cause.

**FAQ data state:** Cleanly removed via v0.2.7's `uninstall.php` (deletes all `_minuto_faq_published` post_meta rows). Backup at `faq-backups/faq-backup-20260503.json` (88 KB, 37 products).

## When the dev confirms the bug is fixed

1. Re-upload `wp-plugins/minuto-product-faq-0.2.7.zip` → Activate
2. Run the restore from backup:
   ```python
   import json, requests
   backup = json.load(open('faq-backups/faq-backup-20260503.json'))
   url = 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/set-product-faq'
   for pid, data in backup.items():
       r = requests.post(url, json={'product_id': data['product_id'], 'faq': data['faq']})
       print(pid, r.status_code, r.json().get('success'))
   ```
3. Spot-check 3-5 products to confirm accordion + JSON-LD are back

## Edge functions

All deployed to Supabase project `ytydgldyeygpzmlxvpvb`, all `--no-verify-jwt`.

| Function | Purpose | Body |
|---|---|---|
| `generate-product-faq` | AI-generate FAQ from product description | `{product_id, dry_run?}` |
| `set-product-faq` | Write FAQ to WC product meta | `{product_id, faq: [{q,a},...]}` |
| `update-product-description` | Find/replace patches to WC product description | `{product_id, replacements: [{find,replace},...], dry_run?}` |

`generate-product-faq` uses Claude Sonnet 4.6 (was Haiku, switched after Hebrew gender errors). Prompt has category-aware structure (beans / grinder / espresso_machine / brewer / other) and ~80 lines of Hebrew quality rules.

## Workflow per product/model

1. **Dry-run** — `POST /generate-product-faq` with `dry_run: true`
2. **Audit output** — check for the rules below; verify any specific facts (boiler size, port count, specific accessory list) against WC source description
3. **Hand-edit if needed** — fix any small issues directly rather than re-prompting
4. **Approve with user** — paste audit + wait for explicit yes
5. **Write live** — `POST /set-product-faq` with the final FAQ (or replicated to all color-variant SKUs)

For models with color variants (Mini, Micra), generate ONE FAQ from a representative SKU and write the same FAQ to all variants. Don't regenerate per color — the description is identical, and you'd just get slightly-different output each time.

## Hebrew quality rules (baked into the prompt)

These rules came from real user corrections. The prompt enforces them, but verify in audit since the model still occasionally slips:

- **No em-dashes** (`—`). Use commas, periods, or semicolons. Em-dash is an AI tell.
- **"אלו ש..."** not "מי ש..." for target-audience phrases
- **Lead with what the customer cares about** (אספרסו, טעם), not the mechanism (טמפרטורה, PID)
- **Gender-inclusive language** — no masculine 2nd-person singular (`תוכל`, `אם אתה רוצה`). Prefer plural "אתם" or neutral "אפשר/ניתן/מומלץ"
- **Brand voice**: ענייני, מדויק, חם — no slang ("ממש צריך", "סחבה"), no superlatives, no marketing puffery
- **No disparaging** other coffee/competitors/customers' existing gear — even by implication
- **No promotional bonuses** in FAQ ("מערכת אוסמוזה הפוכה כמתנה") — promos change, FAQ is permanent
- **Source-grounding** — never invent specs/numbers not in the product description. Verify any specific number, brand name, or technical claim against WC source before approving
- **Gender agreement** — adjectives must agree with their nouns: `מערכת... שמאפשרת` (f+f), `מגש... מואר` (m+m), `פונקציה... מתוכנתת` (f+f)
- **Coffee terminology**:
  - Pre-infusion = "הרטבת עוגיית הקפה" or "הרטבה מקדימה" (NOT "מברטטת" — not a real word)
  - Steam milk = "להקציף חלב" (NOT "לקטור" — not a real verb)
  - Aftertaste = "סיומת" (feminine, "סיומת נקייה ורעננה") — NOT "סיום" (would be gender-mismatched with adjectives)
  - Sweetness = "מתיקות" (noun) — NOT "ממתקת" (which is a verb form)
  - Pump pressure regulation = "ויסות לחץ משאבה" (NOT "כינון לחץ משאבה")
  - Backflush = "פונקציית שטיפה לאחור" (NOT "מערכת ניקוי עצמית" — different concept)
- **Calques to avoid**:
  - ❌ "אמנות חלב" → ✅ "לאטה ארט"
  - ❌ "shot לshot" → ✅ "מנה למנה"
  - ❌ "טכנולוגיית קצה" → ✅ "טכנולוגיה מתקדמת"
- **English-in-Hebrew**: avoid mid-sentence English unless it's a brand/model name (`La Marzocco Linea Mini`) or accepted technical term (`micro foam`, `Brew-by-Weight`)
- **Beans Q1 must be**: `מה טעמו של [name]?` — Minuto convention. NOT "איך טעים" or "איך הקפה הזה"
- **Brand naming**: descriptor is "מינוטו קפה בית קלייה ספיישלטי". NOT "מקלה" (rejected by user)

## Bean Q1 special rule

For beans only, Q1 MUST be phrased: `מה טעמו של [bean name]?` (e.g., `מה טעמו של אתיופיה דיי בנסה?`). If the name is too long, fallback to `מה טעמו של הקפה הזה?`. The prompt enforces this.

## Site quirks (don't relearn the hard way)

- **WP Rocket caches plugin CSS inline.** After ANY plugin update, purge globally (Admin bar → WP Rocket → Remove all cached files), otherwise stale CSS makes "the fix didn't work" diagnosis impossible.
- **WC POST→GET redirect strips body.** Use canonical URL (`https://www.minuto.co.il` with www) + query-string auth + `redirect: 'manual'` + validate response shape. The `set-product-faq` function does this correctly; copy that pattern in any new function.
- **`?p=ID` URLs redirect to homepage** — use the slug-based permalink to fetch product pages.
- **WP Store API doesn't expose private meta** (underscore-prefixed keys). To read FAQ data programmatically, parse the JSON-LD `<script type="application/ld+json" data-source="minuto-product-faq">` block from the page HTML.
- **Hebrew product descriptions sometimes use non-standard spelling** (`דוודים` vs `דודים`). Source-ground but feel free to correct in FAQ output (user prefers correct).
- **The radicle theme uses Alpine.js** for its tabs (`x-data="{activeTab:'description'}"`). The FAQ accordion is inserted as a sibling of `.product-tabs` via the plugin's footer fallback + JS DOM-move.
- **Sitewide horizontal scroll on mobile** — third-party widgets (CheckoutWC + Tidio) render off-screen with desktop widths. The plugin patches it on product pages via `html, body { overflow-x: clip !important }`. Sitewide fix should go in theme.

## How to verify after publishing

1. Visit the product's slug URL (NOT `?p=ID` — that redirects)
2. Confirm `<aside class="minuto-faq-fallback">` is in HTML
3. Confirm `<script type="application/ld+json" data-source="minuto-product-faq">` is in `<head>` with valid FAQPage schema
4. Open in browser, click into the description tab, accordion should appear after the description content

## Quick reference — file paths

| Path | What |
|---|---|
| `wp-plugins/minuto-product-faq/` | Plugin source |
| `wp-plugins/minuto-product-faq-0.2.7.zip` | Latest packaged version |
| `supabase/functions/generate-product-faq/index.ts` | FAQ generator (Sonnet 4.6) |
| `supabase/functions/set-product-faq/index.ts` | FAQ writer |
| `supabase/functions/update-product-description/index.ts` | Description patcher |
| `faq-backups/faq-backup-20260503.json` | Pre-uninstall backup (37 products) |

## Memory directory

Long-running context lives in:
`~/.claude/projects/-Users-erezelbaz-Downloads-CoffeeFlow/memory/`

If moving to a new Mac, copy that directory or the new session won't have any of the prior project context. Or rely on this HANDOFF file + CLAUDE.md as the minimal-but-sufficient brief.
