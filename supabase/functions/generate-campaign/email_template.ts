/**
 * Campaign email template: a set of sections (hero, tasting notes, story,
 * brew tip, offer, product grid, closing CTA, legal footer) rendered as
 * table-based, inline-styled HTML that holds up in Gmail, Outlook (desktop
 * and web), Apple Mail and the phone apps.
 *
 * Every section except the body and footer is optional. A caller that only
 * has the old fields (subject / preheader / greeting / body / cta / products /
 * bannerUrl) gets a complete email: the hero falls back to the banner or the
 * first product photo, and the headline to the subject.
 *
 * Pure: no network, no env. index.ts owns UTM placeholders, the unsubscribe
 * placeholder and the " | פרסומת" subject suffix.
 */

export type EmailStyle = "house" | "editorial" | "bold";

export interface EmailProduct {
  woo_id?: number | string;
  name: string;
  display_name?: string;   // short name for the card; derived from name when absent
  note?: string;           // one short line, e.g. tasting notes
  price?: string;
  regular_price?: string;
  sale_price?: string;
  short_description?: string;
  image_url?: string;
  permalink?: string;
}

export interface EmailFact { label: string; value: string }

export interface EmailOffer {
  title: string;
  text?: string;
  code?: string;
  ctaText?: string;
  ctaUrl?: string;
}

export interface EmailParams {
  subject: string;
  preheader: string;
  greeting?: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  bannerUrl?: string | null;
  products: EmailProduct[];
  unsubscribeUrl: string;
  promoDeadline?: string | null;

  // Sections (all optional)
  style?: EmailStyle;
  kicker?: string;              // small label above the headline
  headline?: string;            // defaults to the subject without the legal suffix
  heroProductId?: number | string | null;  // product shown in the hero; it leaves the grid
  notes?: string[];             // tasting-note chips
  facts?: EmailFact[];          // origin / altitude / roast ... (max 4)
  tip?: { title: string; text: string } | null;
  offer?: EmailOffer | null;
  gridTitle?: string;
  closingText?: string;         // one line above the last button
  sceneBrief?: string;          // the scene the hero image was asked for (stored, not rendered)
}

// Design C, approved by Erez on 2026-11-05 after a dark-mode check in the
// Gmail iPhone app.
export const DEFAULT_STYLE: EmailStyle = "bold";

const LOGO_URL = "https://minuto.co.il/content/uploads/2025/03/Frame-14.png";
const SITE_URL = "https://minuto.co.il";
const BODY_FONT = "'Heebo', Arial, Helvetica, sans-serif";
const SERIF_FONT = "'Frank Ruhl Libre', 'David Libre', Georgia, 'Times New Roman', serif";

interface Theme {
  page: string; card: string; ink: string; muted: string; line: string;
  accent: string; accentInk: string; panel: string; chipBg: string; chipInk: string;
  kicker: string; headFont: string;
  heroBg: string; heroInk: string; heroMuted: string; heroBtn: string; heroBtnInk: string;
  offerBg: string; offerInk: string;
}

const THEMES: Record<EmailStyle, Theme> = {
  // The approved house look (2026-10-25) with real sections on top of it.
  house: {
    page: "#F7F7F7", card: "#FFFFFF", ink: "#333333", muted: "#666666", line: "#E6E6E6",
    accent: "#3C4A2C", accentInk: "#FFFFFF", panel: "#F3F1EC", chipBg: "#EEF1E6", chipInk: "#3C4A2C",
    kicker: "#6B7F4E", headFont: BODY_FONT,
    heroBg: "#FFFFFF", heroInk: "#3C4A2C", heroMuted: "#555555", heroBtn: "#3C4A2C", heroBtnInk: "#FFFFFF",
    offerBg: "#F3F1EC", offerInk: "#333333",
  },
  // Warm paper, serif display type, list-style products: a roastery journal.
  editorial: {
    page: "#EFE8DC", card: "#FBF8F2", ink: "#2B2A25", muted: "#6E675B", line: "#E2D8C6",
    accent: "#3C4A2C", accentInk: "#FFFFFF", panel: "#F3ECDF", chipBg: "#EFE6D6", chipInk: "#5A4632",
    kicker: "#8A5A3B", headFont: SERIF_FONT,
    heroBg: "#FBF8F2", heroInk: "#2B2A25", heroMuted: "#6E675B", heroBtn: "#3C4A2C", heroBtnInk: "#FFFFFF",
    offerBg: "#3C4A2C", offerInk: "#FBF8F2",
  },
  // Deep olive hero, lime accents lifted from the bag artwork.
  bold: {
    page: "#E9E7E0", card: "#FFFFFF", ink: "#26301D", muted: "#5F6656", line: "#E3E3DA",
    accent: "#2F3B25", accentInk: "#FFFFFF", panel: "#F1F3EA", chipBg: "#E6EDCB", chipInk: "#2F3B25",
    kicker: "#C9D77E", headFont: BODY_FONT,
    heroBg: "#2F3B25", heroInk: "#FFFFFF", heroMuted: "#D5DCC6", heroBtn: "#C9D77E", heroBtnInk: "#1F2818",
    offerBg: "#C9D77E", offerInk: "#1F2818",
  },
};

export function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function formatPrice(raw: string): string {
  const n = parseFloat(String(raw ?? ""));
  if (!isFinite(n)) return String(raw ?? "");
  return n % 1 === 0 ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Woo names are long SEO strings ("פולי קפה אתיופיה דיי בנסה חד זני בקלייה
// בהירה - Minuto Daye Bensa Ethiopia ..."). Keep the Hebrew part before the
// first " - " / " | " and drop the generic words around it.
export function shortProductName(name: string): string {
  let s = String(name ?? "").split(/\s[-–|]\s/)[0];
  s = s.replace(/פולי קפה|ספשלטי קפה|קפה ספשלטי|ספשלטי|טרי|מינוטו|100% ערביקה|חד זני|בקלייה בהירה|קפה(?=\s)/g, " ")
    .replace(/\s{2,}/g, " ").trim();
  // Nothing but generic words in Hebrew ("פולי קפה טרי 100% ערביקה - Minuto
  // Dark Chocolate"): the real name is the English part after the dash.
  if (s.length < 3) {
    const latin = String(name ?? "").split(/\s[-–|]\s/).slice(1).join(" ")
      .replace(/\bminuto\b|\bspecialty coffee\b/gi, " ").replace(/[+|]/g, " ").replace(/\s{2,}/g, " ").trim();
    s = latin.length >= 3 ? latin : String(name ?? "").split(/\s[-–|]\s/)[0].trim();
  }
  return s.length > 34 ? s.slice(0, 32).trim() + "…" : s;
}

// Special editions ship in a jar, never in a bag.
export function isSpecialEdition(name: string): boolean {
  return /roastery|מהדורה מיוחדת|special edition/i.test(String(name ?? ""));
}

// Clean in-email headline: the stored subject carries " | פרסומת" for the
// inbox (Communications Law §30א); the headline shows neither it nor emoji.
export function stripSubjectMarkers(subject: string): string {
  return String(subject || "")
    .replace(/^[\s‎‏]*פרסומת[\s‎‏]*/, "")
    .replace(/[\s‎‏]*\|[\s‎‏]*פרסומת[\s‎‏]*$/, "")
    .replace(/[\s‎‏]+פרסומת\b/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// UTMs on minuto.co.il links only. {{UTM_CAMPAIGN}} / {{UTM_GROUP}} are
// substituted per send by handleSendCampaign. Encoded by hand: URLSearchParams
// would percent-encode the braces and break the replace.
export function addUtms(rawUrl: string | undefined, content: string): string {
  if (!rawUrl) return "";
  if (!/^https?:\/\/([a-z0-9-]+\.)*minuto\.co\.il(\/|$|\?)/i.test(rawUrl)) return rawUrl;
  if (rawUrl.includes("utm_source=")) return rawUrl;
  const [base, hash] = rawUrl.split("#");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}utm_source=email&utm_medium=email&utm_campaign={{UTM_CAMPAIGN}}&utm_content=${encodeURIComponent(content)}__{{UTM_GROUP}}${hash ? "#" + hash : ""}`;
}

// Only http(s) links reach an href/src; anything else becomes the shop.
function safeUrl(u: string | undefined | null, fallback = `${SITE_URL}/shop`): string {
  const s = String(u ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : fallback;
}

// Body text is escaped here (the old template inserted it raw); the only
// markup the copy may carry is **bold** and line breaks.
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function paragraphs(text: string, style: string): string {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="${style}">${inline(p)}</p>`)
    .join("");
}

// Button as a table cell: Outlook paints the cell, everyone else the link.
function button(text: string, href: string, bg: string, ink: string, align: "center" | "right" = "center", border = bg): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:${align === "center" ? "0 auto" : "0"};">
  <tr><td bgcolor="${bg}" style="background:${bg};border:1px solid ${border};border-radius:6px;mso-padding-alt:14px 36px;">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 36px;font-family:${BODY_FONT};font-size:16px;line-height:20px;font-weight:700;color:${ink};text-decoration:none;border-radius:6px;">${escapeHtml(text)}</a>
  </td></tr>
</table>`;
}

function priceHtml(p: EmailProduct, t: Theme, size = 16): string {
  const sale = p.sale_price && p.regular_price && String(p.sale_price) !== String(p.regular_price) && parseFloat(p.sale_price) > 0;
  if (sale) {
    return `<span style="color:${t.muted};text-decoration:line-through;font-size:${size - 3}px;">₪${formatPrice(p.regular_price!)}</span>&nbsp;<span style="color:${t.accent};font-weight:700;font-size:${size}px;">₪${formatPrice(p.sale_price!)}</span>`;
  }
  return p.price ? `<span style="color:${t.ink};font-weight:700;font-size:${size}px;">₪${formatPrice(p.price)}</span>` : "";
}

// Woo bag shots are transparent PNGs that sit on the warm panel; JPG/WebP
// shots (the jars) carry their own white studio background, so they get a
// white panel instead of a white box on beige.
function imageBg(url: string | undefined | null, panel: string): string {
  return /\.png(\?|$)/i.test(String(url ?? "")) ? panel : "#FFFFFF";
}

const solid = (c: string) => `linear-gradient(${c},${c})`;

function badgeFor(p: EmailProduct): string {
  return isSpecialEdition(p.name) ? "מהדורה מיוחדת · בצנצנת" : "";
}

export function buildCampaignHtml(params: EmailParams): string {
  const style: EmailStyle = params.style && THEMES[params.style] ? params.style : DEFAULT_STYLE;
  const t = THEMES[style];
  const products = (params.products || []).filter((p) => p && p.name);
  const ctaUrl = safeUrl(params.ctaUrl);

  // Hero product: the requested one, else the first with a photo. It moves
  // out of the grid so the email never shows the same coffee twice.
  const heroProduct = params.heroProductId != null
    ? products.find((p) => String(p.woo_id) === String(params.heroProductId)) ?? null
    : null;
  const gridProducts = heroProduct ? products.filter((p) => p !== heroProduct) : products;
  const heroImage = heroProduct?.image_url || params.bannerUrl || null;
  const heroIsBanner = !heroProduct?.image_url && !!params.bannerUrl;
  const heroHref = addUtms(safeUrl(heroProduct?.permalink, ctaUrl), "hero");
  const headline = (params.headline && params.headline.trim()) || stripSubjectMarkers(params.subject);

  const P = `margin:0 0 16px;font-family:${BODY_FONT};font-size:17px;line-height:1.75;color:${t.ink};`;
  const cell = (pad: string, extra = "") => `class="px" style="padding:${pad};direction:rtl;text-align:right;${extra}"`;

  // ── Hero ──────────────────────────────────────────────────────────────
  const kickerHtml = params.kicker
    ? `<p style="margin:0 0 10px;font-family:${BODY_FONT};font-size:13px;line-height:1.4;font-weight:700;letter-spacing:.04em;color:${t.kicker};">${escapeHtml(params.kicker)}</p>` : "";
  const headlineHtml = (size: number, color: string, align = "right") =>
    `<h1 class="h1" style="margin:0;font-family:${t.headFont};font-size:${size}px;line-height:1.2;font-weight:700;color:${color};text-align:${align};">${escapeHtml(headline)}</h1>`;
  const subHtml = (color: string, align = "right") => params.preheader
    ? `<p style="margin:12px 0 0;font-family:${BODY_FONT};font-size:17px;line-height:1.6;color:${color};text-align:${align};">${escapeHtml(params.preheader)}</p>` : "";
  const heroImg = (maxW: number, extra = "") => heroImage
    ? `<a href="${escapeHtml(heroHref)}" style="text-decoration:none;"><img class="hero-img" src="${escapeHtml(heroImage)}" width="${maxW}" alt="${escapeHtml(heroProduct ? shortProductName(heroProduct.name) : headline)}" style="display:block;width:100%;max-width:${maxW}px;height:auto;border:0;margin:0 auto;${extra}" /></a>` : "";
  const heroPrice = heroProduct ? priceHtml(heroProduct, t, 18) : "";
  const heroBadge = heroProduct ? badgeFor(heroProduct) : "";

  let heroHtml = "";
  if (style === "editorial" && heroImage && !heroIsBanner) {
    // Split hero: text on the right, photo on the left; stacks on phones.
    heroHtml = `<tr><td style="padding:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl">
    <tr>
      <td class="stack" width="54%" valign="middle" style="padding:44px 40px 36px 12px;direction:rtl;text-align:right;">
        ${kickerHtml}${headlineHtml(34, t.heroInk)}${subHtml(t.heroMuted)}
        ${heroPrice ? `<p style="margin:16px 0 0;font-family:${BODY_FONT};font-size:15px;color:${t.muted};">${heroBadge ? escapeHtml(heroBadge) + " · " : ""}${heroPrice}</p>` : ""}
        <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
        ${button(params.ctaText || "לחנות", addUtms(ctaUrl, "cta_hero"), t.heroBtn, t.heroBtnInk, "right")}
      </td>
      <td class="stack" width="46%" valign="middle" bgcolor="${imageBg(heroImage, t.panel)}" style="background:${imageBg(heroImage, t.panel)};background-image:${solid(imageBg(heroImage, t.panel))};padding:28px 20px;">
        ${heroImg(220)}
      </td>
    </tr>
  </table>
</td></tr>`;
  } else if (style === "bold") {
    heroHtml = `<tr><td bgcolor="${t.heroBg}" class="px" style="background:${t.heroBg};background-image:${solid(t.heroBg)};padding:44px 40px 0;direction:rtl;text-align:center;">
  ${kickerHtml.replace("margin:0 0 10px", "margin:0 0 12px;text-align:center")}
  <div class="gm-screen"><div class="gm-diff">${headlineHtml(38, t.heroInk, "center")}</div></div>${subHtml(t.heroMuted, "center")}
  <div style="height:26px;line-height:26px;font-size:0;">&nbsp;</div>
  ${button(params.ctaText || "לחנות", addUtms(ctaUrl, "cta_hero"), t.heroBtn, t.heroBtnInk)}
  <div style="height:30px;line-height:30px;font-size:0;">&nbsp;</div>
</td></tr>
${heroImage ? `<tr><td bgcolor="${t.heroBg}" style="background:${t.heroBg};background-image:${solid(t.heroBg)};padding:0 40px;" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td bgcolor="${heroIsBanner ? t.heroBg : imageBg(heroImage, "#F4F5EE")}" style="background:${heroIsBanner ? t.heroBg : imageBg(heroImage, "#F4F5EE")};background-image:${solid(heroIsBanner ? t.heroBg : imageBg(heroImage, "#F4F5EE"))};border-radius:12px 12px 0 0;padding:${heroIsBanner ? "0" : "28px 20px 8px"};text-align:center;">
      ${heroImg(heroIsBanner ? 520 : 260, heroIsBanner ? "border-radius:12px 12px 0 0;" : "")}
      ${heroProduct ? `<p style="margin:8px 0 18px;font-family:${BODY_FONT};font-size:15px;color:${t.ink};text-align:center;"><strong>${escapeHtml(heroProduct.display_name || shortProductName(heroProduct.name))}</strong>${heroBadge ? " · " + escapeHtml(heroBadge) : ""}${heroPrice ? " · " + heroPrice : ""}</p>` : ""}
    </td>
  </tr></table>
</td></tr>` : ""}`;
  } else {
    // house (and editorial without a product photo): centred, photo on a panel.
    heroHtml = `<tr><td class="px" style="padding:40px 40px 0;direction:rtl;text-align:center;">
  ${kickerHtml.replace("margin:0 0 10px", "margin:0 0 10px;text-align:center")}
  ${headlineHtml(32, t.heroInk, "center")}${subHtml(t.heroMuted, "center")}
</td></tr>
${heroImage ? `<tr><td class="px" style="padding:28px 40px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td bgcolor="${heroIsBanner ? t.card : imageBg(heroImage, t.panel)}" style="background:${heroIsBanner ? t.card : imageBg(heroImage, t.panel)};background-image:${solid(heroIsBanner ? t.card : imageBg(heroImage, t.panel))};padding:${heroIsBanner ? "0" : "28px 20px 12px"};text-align:center;">
      ${heroImg(heroIsBanner ? 480 : 250)}
      ${heroProduct ? `<p style="margin:10px 0 16px;font-family:${BODY_FONT};font-size:15px;color:${t.ink};text-align:center;"><strong>${escapeHtml(heroProduct.display_name || shortProductName(heroProduct.name))}</strong>${heroBadge ? " · " + escapeHtml(heroBadge) : ""}${heroPrice ? " · " + heroPrice : ""}</p>` : ""}
    </td>
  </tr></table>
</td></tr>` : ""}
<tr><td style="padding:28px 40px 0;" class="px">${button(params.ctaText || "לחנות", addUtms(ctaUrl, "cta_hero"), t.heroBtn, t.heroBtnInk)}</td></tr>`;
  }

  // ── Tasting notes + facts ─────────────────────────────────────────────
  const notes = (params.notes || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 4);
  const notesHtml = notes.length ? `<tr><td ${cell("32px 40px 0", "text-align:center;")}>
  <p style="margin:0 0 12px;font-family:${BODY_FONT};font-size:13px;font-weight:700;color:${t.muted};text-align:center;">בכוס</p>
  ${notes.map((n) => `<span style="display:inline-block;margin:0 3px 8px;padding:8px 16px;background:${t.chipBg};color:${t.chipInk};border-radius:999px;font-family:${BODY_FONT};font-size:15px;font-weight:700;line-height:1.2;">${escapeHtml(n)}</span>`).join("")}
</td></tr>` : "";

  const facts = (params.facts || []).filter((f) => f && f.label && f.value).slice(0, 4);
  const factsHtml = facts.length ? `<tr><td class="px" style="padding:20px 40px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="border-top:1px solid ${t.line};border-bottom:1px solid ${t.line};">
    <tr>${facts.map((f, i) => `<td class="fact" width="${Math.floor(100 / facts.length)}%" valign="top" style="padding:14px 6px;direction:rtl;text-align:center;${i < facts.length - 1 ? `border-left:1px solid ${t.line};` : ""}">
      <div style="font-family:${BODY_FONT};font-size:12px;line-height:1.4;color:${t.muted};">${escapeHtml(f.label)}</div>
      <div style="font-family:${BODY_FONT};font-size:15px;line-height:1.4;font-weight:700;color:${t.ink};margin-top:2px;">${escapeHtml(f.value)}</div>
    </td>`).join("")}</tr>
  </table>
</td></tr>` : "";

  // ── Story (greeting + body) ───────────────────────────────────────────
  const storyHtml = `<tr><td ${cell("36px 40px 4px")}>
  ${params.greeting ? `<p style="${P}font-weight:700;">${escapeHtml(params.greeting)}</p>` : ""}
  ${paragraphs(params.body, P)}
</td></tr>`;

  // ── Brew tip ──────────────────────────────────────────────────────────
  const tipHtml = params.tip && params.tip.text ? `<tr><td class="px" style="padding:12px 40px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding:18px 22px;background:${t.panel};border-right:3px solid ${t.accent};direction:rtl;text-align:right;">
      <p style="margin:0 0 6px;font-family:${BODY_FONT};font-size:14px;font-weight:700;color:${t.accent};">${escapeHtml(params.tip.title || "איך להכין")}</p>
      <p style="margin:0;font-family:${BODY_FONT};font-size:16px;line-height:1.65;color:${t.ink};">${escapeHtml(params.tip.text)}</p>
    </td>
  </tr></table>
</td></tr>` : "";

  // ── Offer ─────────────────────────────────────────────────────────────
  const offer = params.offer && params.offer.title ? params.offer : null;
  const deadline = params.promoDeadline && !isNaN(Date.parse(params.promoDeadline))
    ? new Date(params.promoDeadline).toLocaleDateString("he-IL", { day: "numeric", month: "long" }) : "";
  const offerHtml = offer ? `<tr><td class="px" style="padding:28px 40px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td bgcolor="${t.offerBg}" style="background:${t.offerBg};border-radius:10px;padding:28px 28px;direction:rtl;text-align:center;">
      <p style="margin:0;font-family:${t.headFont};font-size:24px;line-height:1.3;font-weight:700;color:${t.offerInk};">${escapeHtml(offer.title)}</p>
      ${offer.text ? `<p style="margin:8px 0 0;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${t.offerInk};">${escapeHtml(offer.text)}</p>` : ""}
      ${offer.code ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:16px auto 0;"><tr><td style="border:2px dashed ${t.offerInk};border-radius:6px;padding:10px 22px;font-family:'Courier New',monospace;font-size:20px;font-weight:700;letter-spacing:.12em;color:${t.offerInk};" dir="ltr">${escapeHtml(offer.code)}</td></tr></table>` : ""}
      ${deadline ? `<p style="margin:12px 0 0;font-family:${BODY_FONT};font-size:14px;color:${t.offerInk};">בתוקף עד ${escapeHtml(deadline)}</p>` : ""}
      ${offer.ctaText ? `<div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>${(style === "house"
        ? button(offer.ctaText, addUtms(safeUrl(offer.ctaUrl, ctaUrl), "offer"), t.accent, t.accentInk)
        : button(offer.ctaText, addUtms(safeUrl(offer.ctaUrl, ctaUrl), "offer"), t.offerInk, t.offerBg))}` : ""}
    </td>
  </tr></table>
</td></tr>` : "";

  // ── Product grid ──────────────────────────────────────────────────────
  const gridItems = gridProducts.slice(0, 6);
  const gridTitle = params.gridTitle || "עוד מהקלייה שלנו";
  const productHref = (p: EmailProduct) => addUtms(safeUrl(p.permalink, ctaUrl), `product_${p.woo_id ?? "unknown"}`);
  const productName = (p: EmailProduct) => p.display_name || shortProductName(p.name);
  const productNote = (p: EmailProduct) => p.note || badgeFor(p);

  const card = (p: EmailProduct) => `<td class="stack-card" width="50%" valign="top" style="padding:8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.card};border:1px solid ${t.line};border-radius:10px;">
    <tr><td bgcolor="${imageBg(p.image_url, t.panel)}" style="background:${imageBg(p.image_url, t.panel)};background-image:${solid(imageBg(p.image_url, t.panel))};border-radius:10px 10px 0 0;padding:16px 12px 6px;text-align:center;">
      <a href="${escapeHtml(productHref(p))}" style="text-decoration:none;">${p.image_url
        ? `<img src="${escapeHtml(p.image_url)}" width="170" alt="${escapeHtml(productName(p))}" style="display:block;width:100%;max-width:170px;height:auto;border:0;margin:0 auto;" />`
        : `<div style="height:170px;line-height:170px;font-size:0;">&nbsp;</div>`}</a>
    </td></tr>
    <tr><td style="padding:14px 16px 18px;direction:rtl;text-align:right;font-family:${BODY_FONT};">
      <a href="${escapeHtml(productHref(p))}" style="display:block;font-size:16px;line-height:1.35;font-weight:700;color:${t.ink};text-decoration:none;">${escapeHtml(productName(p))}</a>
      ${productNote(p) ? `<div style="margin-top:4px;font-size:14px;line-height:1.45;color:${t.muted};">${escapeHtml(productNote(p))}</div>` : ""}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr>
        <td style="direction:rtl;text-align:right;font-family:${BODY_FONT};">${priceHtml(p, t)}</td>
        <td style="text-align:left;"><a href="${escapeHtml(productHref(p))}" style="display:inline-block;padding:7px 14px;border:1px solid ${t.accent};border-radius:999px;font-family:${BODY_FONT};font-size:14px;line-height:16px;font-weight:700;color:${t.accent};text-decoration:none;">לרכישה</a></td>
      </tr></table>
    </td></tr>
  </table>
</td>`;

  const row = (p: EmailProduct, last: boolean) => `<tr><td style="padding:14px 0;${last ? "" : `border-bottom:1px solid ${t.line};`}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl"><tr>
    <td width="96" valign="middle" style="padding:0 0 0 16px;">
      <a href="${escapeHtml(productHref(p))}" style="text-decoration:none;">${p.image_url
        ? `<img src="${escapeHtml(p.image_url)}" width="88" alt="${escapeHtml(productName(p))}" style="display:block;width:88px;height:auto;border:0;background:${imageBg(p.image_url, t.panel)};border-radius:8px;" />` : ""}</a>
    </td>
    <td valign="middle" style="direction:rtl;text-align:right;font-family:${BODY_FONT};">
      <a href="${escapeHtml(productHref(p))}" style="display:block;font-family:${t.headFont};font-size:19px;line-height:1.3;font-weight:700;color:${t.ink};text-decoration:none;">${escapeHtml(productName(p))}</a>
      ${productNote(p) ? `<div style="margin-top:3px;font-size:14px;line-height:1.45;color:${t.muted};">${escapeHtml(productNote(p))}</div>` : ""}
      <div style="margin-top:6px;font-size:15px;">${priceHtml(p, t, 15)}&nbsp;&nbsp;<a href="${escapeHtml(productHref(p))}" style="display:inline-block;padding:7px 14px;border:1px solid ${t.accent};border-radius:999px;font-family:${BODY_FONT};font-size:14px;line-height:16px;font-weight:700;color:${t.accent};text-decoration:none;">לרכישה</a></div>
    </td>
  </tr></table>
</td></tr>`;

  let gridHtml = "";
  if (gridItems.length) {
    let inner = "";
    if (style === "editorial") {
      inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${gridItems.map((p, i) => row(p, i === gridItems.length - 1)).join("")}</table>`;
    } else {
      let rows = "";
      for (let i = 0; i < gridItems.length; i += 2) {
        const b = gridItems[i + 1];
        rows += `<tr>${card(gridItems[i])}${b ? card(b) : `<td class="stack-card spacer" width="50%" style="padding:8px;">&nbsp;</td>`}</tr>`;
      }
      inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="table-layout:fixed;">${rows}</table>`;
    }
    gridHtml = `<tr><td ${cell("36px 40px 6px")}>
  <h2 style="margin:0;font-family:${t.headFont};font-size:22px;line-height:1.3;font-weight:700;color:${t.accent === "#2F3B25" ? t.ink : t.accent};">${escapeHtml(gridTitle)}</h2>
</td></tr>
<tr><td class="${style === "editorial" ? "px" : "px-grid"}" style="padding:${style === "editorial" ? "4px 40px 8px" : "8px 32px 8px"};">${inner}</td></tr>`;
  }

  // ── Closing CTA ───────────────────────────────────────────────────────
  const closingHtml = params.ctaText ? `<tr><td class="px" style="padding:24px 40px 44px;text-align:center;">
  ${params.closingText ? `<p style="margin:0 0 16px;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${t.muted};text-align:center;">${escapeHtml(params.closingText)}</p>` : ""}
  ${button(params.ctaText, addUtms(ctaUrl, "cta_button"), t.accent, t.accentInk)}
</td></tr>` : `<tr><td style="padding:0 0 32px;"></td></tr>`;

  const legalDeadline = params.promoDeadline && !isNaN(Date.parse(params.promoDeadline))
    ? new Date(params.promoDeadline).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" }) : "";

  return `<!DOCTYPE html>
<html dir="rtl" lang="he" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
  <meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(stripSubjectMarkers(params.subject))}</title>
  ${encodeDesign(designOf(params))}
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <!--[if !mso]><!-->
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&family=Frank+Ruhl+Libre:wght@700&display=swap" rel="stylesheet">
  <!--<![endif]-->
  <style>
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; }
    u + .body .gm-screen { background:#000000; mix-blend-mode:screen; }
    u + .body .gm-diff { background:#000000; mix-blend-mode:difference; }
    a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
    @media only screen and (max-width:620px) {
      .px { padding-left:22px !important; padding-right:22px !important; }
      .px-grid { padding-left:14px !important; padding-right:14px !important; }
      .h1 { font-size:28px !important; }
      .stack { display:block !important; width:100% !important; box-sizing:border-box; padding-left:22px !important; padding-right:22px !important; }
      .stack-card { padding:5px !important; }
      .fact { display:inline-block !important; width:49% !important; box-sizing:border-box; border-left:0 !important; }
    }
  </style>
</head>
<body class="body" style="margin:0;padding:0;background:${t.page};font-family:${BODY_FONT};color:${t.ink};-webkit-font-smoothing:antialiased;">
  ${params.preheader ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(params.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>` : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.page}" style="background:${t.page};">
    <tr><td align="center" style="padding:24px 10px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.card}" style="max-width:600px;background:${t.card};">
        <tr><td align="center" bgcolor="${t.card}" style="background:${t.card};background-image:${solid(t.card)};padding:24px 32px 20px;${style === "bold" ? "" : `border-bottom:1px solid ${t.line};`}">
          <a href="${SITE_URL}"><img src="${LOGO_URL}" width="124" alt="Minuto Café Roastery" style="display:block;width:124px;max-width:124px;height:auto;border:0;" /></a>
        </td></tr>
        ${heroHtml}
        ${notesHtml}
        ${factsHtml}
        ${storyHtml}
        ${tipHtml}
        ${offerHtml}
        ${gridHtml}
        ${closingHtml}
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td align="center" style="padding:24px 32px 8px;font-family:${BODY_FONT};font-size:13px;line-height:1.8;color:#555555;direction:rtl;">
          <strong>מינוטו קפה בית קלייה ספיישלטי</strong> · קולים פולים טריים בכל שבוע<br>
          מינוטו קפה בע״מ · אחד העם 22, רחובות 7626101 · <a href="${SITE_URL}" style="color:#555555;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#555555;">Instagram</a>
        </td></tr>
        <tr><td align="center" style="padding:4px 32px 28px;font-family:${BODY_FONT};font-size:12px;line-height:1.8;color:#666666;direction:rtl;">
          ${legalDeadline ? `<p style="margin:0 0 8px;font-weight:700;color:#555555;">המבצע עד ה־${escapeHtml(legalDeadline)} או עד גמר המלאי, הראשון מבינהם | ט.ל.ח</p>` : ""}
          <p style="margin:0 0 6px;">הפניה אליך נעשית בדיוור ישיר בעקבות הרשמתך לקפה מינוטו.</p>
          <p style="margin:0 0 6px;">הודעת דואר זו נשלחה מכתובת דואר אלקטרוני שאינה נבדקת. אין באפשרותנו להגיב על תשובות שנשלחות לכתובת דואר אלקטרוני זאת. אנו מכבדים את פרטיותך, כנדרש עפ&quot;י דין.</p>
          <p style="margin:0 0 6px;">להסרה מרשימת הדיוור <a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#666666;">לחץ/י כאן</a>.</p>
          <p style="margin:0;">Please do not reply to this mail · ט.ל.ח</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Section data kept with the draft ───────────────────────────────────────
// The campaigns table stores only subject / body / CTA columns. The section
// fields ride along in the stored HTML as one comment, so update-draft can
// re-render an edited draft without losing its hero, notes or offer (same
// idea as recovering the banner URL from html_content).

export interface EmailDesign {
  style?: EmailStyle;
  kicker?: string;
  headline?: string;
  heroProductId?: number | string | null;
  notes?: string[];
  facts?: EmailFact[];
  tip?: { title: string; text: string } | null;
  offer?: EmailOffer | null;
  gridTitle?: string;
  closingText?: string;
  sceneBrief?: string;
  bannerUrl?: string | null;
  productNotes?: Record<string, { note?: string; display_name?: string }>;
}

const DESIGN_MARK = "minuto-design:";

export function designOf(p: EmailParams): EmailDesign {
  const productNotes: EmailDesign["productNotes"] = {};
  for (const pr of p.products || []) {
    if (pr && pr.woo_id != null && (pr.note || pr.display_name)) {
      productNotes[String(pr.woo_id)] = { note: pr.note, display_name: pr.display_name };
    }
  }
  return {
    style: p.style, kicker: p.kicker, headline: p.headline, heroProductId: p.heroProductId ?? null,
    notes: p.notes, facts: p.facts, tip: p.tip ?? null, offer: p.offer ?? null,
    gridTitle: p.gridTitle, closingText: p.closingText, sceneBrief: p.sceneBrief, bannerUrl: p.bannerUrl ?? null, productNotes,
  };
}

function encodeDesign(d: EmailDesign): string {
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `<!--${DESIGN_MARK}${btoa(bin)}-->`;
}

// Returns {} for HTML written before this template (or anything unreadable).
export function decodeDesign(html: string | null | undefined): EmailDesign {
  const m = String(html ?? "").match(/<!--minuto-design:([A-Za-z0-9+/=]+)-->/);
  if (!m) return {};
  try {
    const bin = atob(m[1]);
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return d && typeof d === "object" && !Array.isArray(d) ? d as EmailDesign : {};
  } catch {
    return {};
  }
}
